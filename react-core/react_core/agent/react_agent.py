"""The ReAct loop.

Think → act (one or more tools, in parallel) → observe → loop, until the LLM
returns `action: final_answer` or a hard limit is hit.

Memory model
------------
* `ThreadMemory` (composes ConversationMemory + LongTermMemory + summarizer)
  provides the `memory_context` block that appears in every step.
* `Scratchpad` is per-run short-term memory with three-tier compression.
* The `remember` tool writes to long-term memory.
"""
from __future__ import annotations

import asyncio
import json
import sys
import traceback
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

from ..llm.base import LLMClient, LLMError
from ..llm.structured_output import StructuredOutputError, extract_json
from ..memory.stop_registry import stop_registry
from ..memory.thread_memory import ThreadMemory
from ..tools.registry import ToolRegistry
from ..utils.logger import get_logger
from .prompts import render_system_prompt
from .scratchpad import Scratchpad

log = get_logger(__name__)

EventCallback = Callable[[str, dict[str, Any]], Awaitable[None] | None]

HARD_CEILING = 100
STALL_LIMIT = 3
DEFAULT_MAX_PARALLEL_TOOLS = 8


class AgentStopped(Exception):
    pass


def _truncate(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... (truncated, {len(text) - limit} more chars)"


def _stringify_observation(obs: Any) -> str:
    if isinstance(obs, str):
        return _truncate(obs)
    try:
        return _truncate(json.dumps(obs, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return _truncate(str(obs))


class ReActAgent:
    def __init__(
        self,
        llm: LLMClient,
        tool_registry: ToolRegistry,
        memory: ThreadMemory,
        thread_id: str,
        *,
        max_steps: int = 50,
        temperature: float = 0.2,
        max_parallel_tools: int = DEFAULT_MAX_PARALLEL_TOOLS,
    ):
        self.llm = llm
        self.reg = tool_registry
        self.memory = memory
        self.thread_id = thread_id
        self.max_steps = min(max_steps, HARD_CEILING)
        self.temperature = temperature
        self.max_parallel_tools = max_parallel_tools

    async def run(self, user_input: str, on_event: EventCallback) -> None:
        self.memory.add_user_message(user_input)
        workspace = self.memory.conversation.get_workspace(self.thread_id) or ""

        system = render_system_prompt(
            workspace=workspace,
            tools_text=self.reg.descriptions_text(),
            today=datetime.utcnow().strftime("%Y-%m-%d"),
            platform=sys.platform,
        )

        scratchpad = Scratchpad()
        stall = 0

        try:
            for step in range(1, self.max_steps + 1):
                if stop_registry.should_stop(self.thread_id):
                    raise AgentStopped

                await self._emit(on_event, "thinking", {"step": step})

                memory_context = await self.memory.build_memory_context()
                messages = self._build_messages(system, user_input, memory_context, scratchpad)

                try:
                    text = await self.llm.complete(messages, temperature=self.temperature)
                except LLMError as e:
                    await self._emit(on_event, "error", {"error": f"LLM error: {e}"})
                    return

                try:
                    parsed = extract_json(text)
                except StructuredOutputError as e:
                    stall += 1
                    if stall >= STALL_LIMIT:
                        await self._emit(on_event, "error", {
                            "error": f"LLM produced unparseable output {STALL_LIMIT} times: {e}",
                        })
                        return
                    scratchpad.add(
                        thought="(parse error)",
                        observations=[{
                            "tool": "(none)",
                            "input": {},
                            "observation": f"Your last response was not valid JSON: {e}. Respond with a single JSON object.",
                        }],
                    )
                    continue
                stall = 0

                thought = str(parsed.get("thought", ""))
                action = parsed.get("action")

                if action == "final_answer":
                    answer_input = parsed.get("action_input") or {}
                    if isinstance(answer_input, dict):
                        answer = str(answer_input.get("answer") or answer_input.get("text") or "")
                    else:
                        answer = str(answer_input)
                    if not answer:
                        answer = thought or "Done."
                    self.memory.add_assistant_message(answer)
                    await self._emit(on_event, "final", {"answer": answer, "steps": step})
                    return

                actions = self._extract_actions(parsed)
                if not actions:
                    scratchpad.add(
                        thought=thought,
                        observations=[{
                            "tool": "(none)",
                            "input": {},
                            "observation": "No `action` or `actions` field found. Return either final_answer or one/more tool calls.",
                        }],
                    )
                    continue

                observations = await self._run_actions(actions, on_event)
                scratchpad.add(thought=thought, observations=observations)

                if stop_registry.should_stop(self.thread_id):
                    raise AgentStopped

            await self._emit(on_event, "error", {"error": f"Hit max_steps limit ({self.max_steps})."})
        except AgentStopped:
            stop_registry.clear(self.thread_id)
            await self._emit(on_event, "stopped", {"reason": "user cancelled"})
        except Exception as e:  # noqa: BLE001
            log.exception("agent loop crashed")
            await self._emit(on_event, "error", {
                "error": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc()[-2000:],
            })

    def _build_messages(
        self,
        system: str,
        user_input: str,
        memory_context: str,
        scratchpad: Scratchpad,
    ) -> list[dict]:
        scratch = scratchpad.render()
        parts: list[str] = [f"# Current turn — user message\n{user_input}"]
        if memory_context.strip():
            parts.append(f"# Memory context\n{memory_context}")
        parts.append(f"# Scratchpad so far\n{scratch}")
        parts.append("Respond with the next JSON action per the format above.")
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": "\n\n".join(parts)},
        ]

    def _extract_actions(self, parsed: dict) -> list[dict]:
        actions: list[dict] = []
        if isinstance(parsed.get("actions"), list):
            for a in parsed["actions"][: self.max_parallel_tools]:
                if not isinstance(a, dict):
                    continue
                tool = a.get("tool") or a.get("name") or a.get("action")
                if not tool:
                    continue
                actions.append({
                    "tool": str(tool),
                    "input": a.get("input") or a.get("action_input") or a.get("arguments") or {},
                })
            return actions

        action_name = parsed.get("action")
        if action_name and action_name != "final_answer":
            actions.append({
                "tool": str(action_name),
                "input": parsed.get("action_input") or parsed.get("arguments") or {},
            })
        return actions

    async def _run_actions(
        self,
        actions: list[dict],
        on_event: EventCallback,
    ) -> list[dict[str, Any]]:
        async def _run_one(idx: int, spec: dict) -> dict[str, Any]:
            tool_name = spec["tool"]
            tool_input = spec.get("input") or {}
            if not isinstance(tool_input, dict):
                tool_input = {"value": tool_input}

            await self._emit(on_event, "tool_start", {
                "index": idx, "tool": tool_name, "input": tool_input,
            })

            tool = self.reg.get(tool_name)
            if tool is None:
                obs = {"error": f"Unknown tool '{tool_name}'. Available: {', '.join(self.reg.names())}"}
                await self._emit(on_event, "tool_result", {
                    "index": idx, "tool": tool_name, "result": obs,
                })
                return {"tool": tool_name, "input": tool_input, "observation": obs}

            try:
                if getattr(tool, "SUPPORTS_STREAMING", False):
                    result = await tool.run(on_event=on_event, **tool_input)
                else:
                    result = await tool.run(**tool_input)
            except TypeError as e:
                result = {"error": f"Bad arguments for {tool_name}: {e}"}
            except Exception as e:  # noqa: BLE001
                log.exception("tool %s crashed", tool_name)
                result = {"error": f"{type(e).__name__}: {e}"}

            await self._emit(on_event, "tool_result", {
                "index": idx, "tool": tool_name, "result": result,
            })
            return {"tool": tool_name, "input": tool_input, "observation": result}

        tasks = [asyncio.create_task(_run_one(i, a)) for i, a in enumerate(actions)]
        raw = await asyncio.gather(*tasks, return_exceptions=True)
        observations: list[dict[str, Any]] = []
        for i, entry in enumerate(raw):
            if isinstance(entry, Exception):
                observations.append({
                    "tool": actions[i]["tool"],
                    "input": actions[i].get("input") or {},
                    "observation": {"error": f"{type(entry).__name__}: {entry}"},
                })
            else:
                observations.append({
                    "tool": entry["tool"],
                    "input": entry["input"],
                    "observation": _stringify_observation(entry["observation"]),
                })
        return observations

    async def _emit(self, on_event: Optional[EventCallback], event_type: str, data: dict) -> None:
        if on_event is None:
            return
        result = on_event(event_type, data)
        if hasattr(result, "__await__"):
            await result
