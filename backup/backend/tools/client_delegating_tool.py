"""
Client Delegating Tool — Pattern C bridge (see ARCHITECTURE_PLAN.md, Phase 1).

Wraps a workspace tool so that, instead of executing on the SERVER's disk, it
asks the connected client (browser / VS Code) to execute it locally against the
user's real files and post the result back. The orchestrator awaits this exactly
like any other tool, so the turn pauses naturally until the client responds.

Presents the SAME name / description / parameter schema as the tool it replaces,
so the LLM sees no difference — only the execution location changes.
"""

import asyncio
import json
import os
import uuid

from .base_tool import BaseTool
from .client_broker import broker

# How long to wait for the client to execute one tool before giving up.
CLIENT_TOOL_TIMEOUT = int(os.getenv("CLIENT_TOOL_TIMEOUT_SECONDS", "120"))


class ClientDelegatingTool(BaseTool):
    # True so ToolUseAgent._call_tool passes on_event into run() — that's our
    # channel to emit `client_tool_use` onto the live SSE stream.
    SUPPORTS_STREAMING = True

    def __init__(self, name, description, parameters_schema, thread_id, workspace):
        super().__init__(workspace)
        self.name = name
        self.description = description
        self._parameters = parameters_schema
        self.thread_id = thread_id
        # The broker channel — SEPARATE from `thread_id`, which is per-thread
        # STATE (read-tracking, task lists, permission approvals) and is
        # deliberately re-stamped for a sub-agent so siblings can't authorise
        # each other's writes (see tools/sub_agent_tool.py).
        #
        # The channel must NOT move with it. The browser only knows the thread
        # id it opened the stream with, so it POSTs every tool result to
        # /api/agent/tool_result under THAT id. A sub-agent whose clone
        # registered its future under "{root}::sub::{agent_id}" was waiting on
        # a key nothing would ever resolve: the result arrived, matched no
        # pending call, returned 404 to the client, and the child sat there
        # until the 120 s timeout before reporting a tool error. Every
        # client-delegated call in every fan-out did this.
        #
        # Shallow-copied clones inherit this value unchanged, which is exactly
        # what makes a child resolve against the root's channel.
        self.channel_thread_id = thread_id

    def parameters(self):
        return self._parameters

    async def run(self, on_event=None, **kwargs):
        if on_event is None:
            # No live client channel (e.g. called inside a server-only sub-agent).
            # Surface a clear error the LLM can react to instead of hanging.
            return json.dumps({
                "error": f"Tool '{self.name}' is client-executed, but no client "
                         f"channel is connected for this call."
            })

        call_id = uuid.uuid4().hex
        fut = broker.create(self.channel_thread_id, call_id)

        # Ask the client to run this tool locally.
        await self._maybe_await(on_event("client_tool_use", {
            "id": call_id,
            "tool": self.name,
            "input": kwargs,
        }))

        try:
            output = await asyncio.wait_for(fut, timeout=CLIENT_TOOL_TIMEOUT)
        except asyncio.TimeoutError:
            broker.discard(self.channel_thread_id, call_id)
            return json.dumps({
                "error": f"Client did not return a result for '{self.name}' within "
                         f"{CLIENT_TOOL_TIMEOUT}s."
            })
        except asyncio.CancelledError:
            broker.discard(self.channel_thread_id, call_id)
            raise

        # Visibility parity with server-executed edits: when the client's
        # result carries the APPLIED diff (code_edit does), surface it as a
        # file_diff event so the chat renders the same diff card — the user
        # sees exactly what landed on their disk, not just a tool row.
        if isinstance(output, dict) and output.get("diff") and not output.get("error"):
            await self._maybe_await(on_event("file_diff", {
                "path": output.get("path", ""),
                "diff": output["diff"],
            }))

        # Vision parity with server-executed reads: the client's read_file
        # parsed a local image (or a document containing one) and sent the
        # base64 back. Hand it to the run's vision buffer so the agent loop
        # attaches it as real image content on the next turn — the same path a
        # server-side read takes. See agents/vision_buffer.py for why a tool
        # result cannot carry an image itself.
        #
        # The payloads are REMOVED from the text result: a tool message is
        # capped by the scratchpad budget, and several hundred KB of base64
        # would evict the rest of the conversation to say nothing the model can
        # read.
        if isinstance(output, dict) and output.get("images"):
            output = self._siphon_images(output)

        # The loop expects a string; client results are JSON objects.
        return output if isinstance(output, str) else json.dumps(output)

    def _siphon_images(self, output: dict) -> dict:
        """Move a client result's image payloads into the vision buffer.

        Returns the result with `images` replaced by a count, so the model is
        told images exist and how many — including when the buffer was already
        full and some were dropped, which it must know rather than assume it
        saw everything.

        A malformed payload is discarded rather than raising: the tool call
        itself succeeded, and the text result is still worth returning.
        """
        from agents import vision_buffer

        raw = output.get("images")
        payloads = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                mime = str(item.get("mime_type") or "")
                data = item.get("data")
                if not mime.startswith("image/") or not isinstance(data, str) or not data:
                    continue
                payloads.append({
                    "mime_type": mime,
                    "data": data,
                    "filename": str(item.get("filename") or output.get("path") or "image"),
                })

        result = {k: v for k, v in output.items() if k != "images"}
        if not payloads:
            return result

        queued = vision_buffer.offer(
            self.thread_id, payloads, source=str(output.get("path") or self.name),
        )
        result["images_attached"] = queued
        if queued < len(payloads):
            result["images_dropped"] = len(payloads) - queued
            result["message"] = (
                f"{queued} of {len(payloads)} image(s) attached; the rest "
                f"exceeded this turn's image limit. Read the file again on a "
                f"later turn to see them."
            )
        return result

    @staticmethod
    async def _maybe_await(result):
        """on_event may be sync or async — await only if it returned a coroutine."""
        if result is not None:
            await result
