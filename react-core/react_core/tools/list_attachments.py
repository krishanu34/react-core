"""list_attachments — enumerate attachments visible to this org."""
from __future__ import annotations

from typing import Any

from ..app_db import get_app_db
from .base import BaseTool


class ListAttachmentsTool(BaseTool):
    name = "list_attachments"
    description = (
        "List every uploaded attachment visible to this workspace, with "
        "filename, size, page count, indexed flag, and attachment ID. "
        "Use before calling `read_attachment` or `search_semantic` to see "
        "what knowledge is available."
    )

    def __init__(self, workspace: str, *, org_id: str = "org-default"):
        super().__init__(workspace)
        self._org_id = org_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "thread_only": {
                    "type": "boolean",
                    "description": "If true, only list attachments uploaded to the current thread.",
                },
            },
            "required": [],
        }

    async def run(self, thread_only: bool = False, **_: Any) -> dict[str, Any]:
        db = get_app_db()
        atts = db.list_attachments(self._org_id)
        return {
            "attachments": [
                {
                    "id": a.id,
                    "filename": a.filename,
                    "mime": a.mime,
                    "size": a.size,
                    "pages": a.pages,
                    "indexed": a.indexed,
                }
                for a in atts
            ]
        }
