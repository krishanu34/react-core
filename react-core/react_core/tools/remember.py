"""remember — persist a fact into this thread's long-term memory."""
from __future__ import annotations

from typing import Any

from ..memory.long_term import LongTermMemory
from .base import BaseTool


class RememberTool(BaseTool):
    name = "remember"
    description = (
        "Save a short fact to this thread's long-term memory so it survives "
        "future turns (and process restarts). Use for: user preferences, "
        "durable project conventions, decisions the user made mid-run. Do NOT "
        "use for step-by-step reasoning — that belongs in your scratchpad."
    )

    def __init__(self, workspace: str, long_term: LongTermMemory | None = None):
        super().__init__(workspace)
        self._long_term = long_term

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The fact to remember, one short sentence.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional tags for later lookup, e.g. ['preference'].",
                },
            },
            "required": ["content"],
        }

    async def run(self, content: str, tags: list[str] | None = None) -> dict[str, Any]:
        if self._long_term is None:
            return {"error": "long-term memory is not wired for this run."}
        content = str(content or "").strip()
        if not content:
            return {"error": "content is required."}
        entry = self._long_term.add(content, tags=list(tags or []))
        return {"remembered": True, "content": entry["content"], "created_at": entry["created_at"]}
