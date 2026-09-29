"""request_approval — a semantic checkpoint call.

Same broker as `ask_user`, but emits a `checkpoint_request` SSE event so
the UI can render an approval card instead of a generic question prompt.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable, Optional

from .ask_user import ASK_USER_TIMEOUT, ask_user_broker
from .base import BaseTool


class RequestApprovalTool(BaseTool):
    name = "request_approval"
    SUPPORTS_STREAMING = True
    description = (
        "Pause and request explicit approval at one of the four QA "
        "checkpoints (Design / Cases / Automation / Delivery). Use this "
        "instead of `ask_user` for review sign-offs — the UI renders it as "
        "an approval card.\n"
        "Give the reviewer enough to actually decide:\n"
        "- FIRST write the draft (e.g. `write_artefact` / `generate_*`) so it "
        "shows in the artefacts panel, then reference it in `artefacts` "
        "(workspace-relative paths) so the reviewer can open it.\n"
        "- `items` must be the CONCRETE things being approved — actual "
        "scenario/case titles WITH their @requirement:AC-x tags — not vague "
        "category labels.\n"
        "- `next_action` states in one line what Approve will trigger, so the "
        "consequence of signing off is explicit."
    )

    def __init__(self, workspace: str, thread_id: Optional[str] = None):
        super().__init__(workspace)
        self.thread_id = thread_id or ""

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "checkpoint": {
                    "type": "string",
                    "description": "One of 'design' | 'cases' | 'automation' | 'delivery'.",
                },
                "summary": {
                    "type": "string",
                    "description": "One paragraph describing what the user is approving.",
                },
                "items": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "The concrete things being approved — actual scenario/"
                        "case titles WITH @requirement:AC-x tags, not category "
                        "labels."
                    ),
                },
                "next_action": {
                    "type": "string",
                    "description": "One line: what approving will trigger next.",
                },
                "artefacts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Workspace-relative paths of drafts already written, so "
                        "the reviewer can open them before deciding."
                    ),
                },
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Default: ['approve','revise','reject'].",
                },
            },
            "required": ["checkpoint", "summary"],
        }

    async def run(
        self,
        checkpoint: str,
        summary: str,
        items: Optional[list[str]] = None,
        next_action: Optional[str] = None,
        artefacts: Optional[list[str]] = None,
        options: Optional[list[str]] = None,
        on_event: Callable[[str, dict], Awaitable[None] | None] | None = None,
    ) -> dict[str, Any]:
        if not self.thread_id:
            return {"error": "request_approval requires a bound thread_id."}
        if on_event is None:
            return {"error": "no live client channel — cannot request approval."}
        call_id = uuid.uuid4().hex
        fut = ask_user_broker.create(self.thread_id, call_id)
        payload: dict[str, Any] = {
            "call_id": call_id,
            "checkpoint": checkpoint,
            "summary": summary,
        }
        if items:
            payload["items"] = list(items)[:32]
        if next_action and next_action.strip():
            payload["next_action"] = next_action.strip()
        if artefacts:
            payload["artefacts"] = [str(a) for a in artefacts][:16]
        payload["options"] = list(options or ["approve", "revise", "reject"])[:6]
        result = on_event("checkpoint_request", payload)
        if hasattr(result, "__await__"):
            await result

        try:
            answer = await asyncio.wait_for(fut, timeout=ASK_USER_TIMEOUT)
        except asyncio.TimeoutError:
            ask_user_broker._futures.pop((self.thread_id, call_id), None)  # noqa: SLF001
            return {"error": f"No approval received within {ASK_USER_TIMEOUT}s."}
        return {"checkpoint": checkpoint, "answer": answer, "summary": summary}
