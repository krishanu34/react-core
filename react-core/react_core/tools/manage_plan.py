"""manage_plan — an optional, non-blocking visible task list.

Unlike `ask_user` / `request_approval`, this tool never blocks the run: it
emits a `plan_update` SSE event so the UI can render a live checklist, then
returns immediately. The agent decides for itself whether a given turn is
worth planning at all — see the prompt's guidance on right-sizing this.
"""
from __future__ import annotations

import re
from typing import Any, Awaitable, Callable, Optional

from .base import BaseTool

_VALID_STATUSES = {"pending", "in_progress", "completed"}
_MAX_ITEMS = 40


def _slugify_id(raw: Any, fallback_index: int) -> str:
    text = str(raw or "").strip()
    if text:
        return text[:64]
    return str(fallback_index + 1)


def _normalize_item(raw: Any, index: int) -> Optional[dict[str, str]]:
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or raw.get("text") or "").strip()
    if not title:
        return None
    status = str(raw.get("status") or "pending").strip().lower()
    if status not in _VALID_STATUSES:
        status = "pending"
    return {
        "id": _slugify_id(raw.get("id"), index),
        "title": re.sub(r"\s+", " ", title)[:200],
        "status": status,
    }


class ManagePlanTool(BaseTool):
    name = "manage_plan"
    SUPPORTS_STREAMING = True
    description = (
        "Create or update the visible task checklist for this run. Use ONLY "
        "when the request genuinely has multiple independent parts to track "
        "— skip it entirely for anything answerable in one or two tool calls. "
        "Every call REPLACES the checklist shown to the user, so always pass "
        "every item (not just the one that changed) with its current status: "
        "'pending' | 'in_progress' | 'completed'. Mark an item 'in_progress' "
        "before you start it and 'completed' right after, so the user can "
        "follow along live. Does not pause the run — it returns immediately."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "The full checklist, every item, every call.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "Stable short id, e.g. '1'. Reuse it across calls for the same item.",
                            },
                            "title": {"type": "string", "description": "Short label for the item."},
                            "status": {
                                "type": "string",
                                "description": "pending | in_progress | completed",
                            },
                        },
                        "required": ["id", "title", "status"],
                    },
                },
            },
            "required": ["items"],
        }

    async def run(
        self,
        items: Optional[list[dict]] = None,
        on_event: Callable[[str, dict], Awaitable[None] | None] | None = None,
    ) -> dict[str, Any]:
        raw_items = items or []
        normalized = [
            item for item in (
                _normalize_item(raw, i) for i, raw in enumerate(raw_items[:_MAX_ITEMS])
            ) if item is not None
        ]
        if not normalized:
            return {"error": "manage_plan requires at least one item with a title."}

        payload = {"items": normalized}
        if on_event is not None:
            result = on_event("plan_update", payload)
            if hasattr(result, "__await__"):
                await result

        counts = {
            status: sum(1 for it in normalized if it["status"] == status)
            for status in _VALID_STATUSES
        }
        return {"ok": True, "items": normalized, "counts": counts}
