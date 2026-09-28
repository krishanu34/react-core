"""read_attachment — windowed read of an uploaded document."""
from __future__ import annotations

from typing import Any

from ..app_db import get_app_db
from ..attachments.extractors import extract as extract_text
from .base import BaseTool

_MAX_CHARS = 4000


class ReadAttachmentTool(BaseTool):
    name = "read_attachment"
    description = (
        "Read a window of an attachment by attachment_id. For PDFs the "
        "offset/limit are page numbers; for text-like docs they are 1-based "
        "character offsets in KB blocks. Prefer `search_semantic` for large "
        "docs — this tool is for precise re-reads."
    )

    def __init__(self, workspace: str, *, org_id: str = "org-default"):
        super().__init__(workspace)
        self._org_id = org_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "attachment_id": {"type": "string"},
                "offset": {"type": "integer", "description": "1-based page or block."},
                "limit": {"type": "integer", "description": "Pages or blocks to read (default 1)."},
            },
            "required": ["attachment_id"],
        }

    async def run(
        self,
        attachment_id: str,
        offset: int = 1,
        limit: int = 1,
        **_: Any,
    ) -> dict[str, Any]:
        db = get_app_db()
        att = db.get_attachment(attachment_id)
        if att is None or att.org_id != self._org_id:
            return {"error": f"attachment {attachment_id!r} not found in this org."}
        try:
            doc = extract_text(att.path, filename=att.filename)
        except Exception as e:  # noqa: BLE001
            return {"error": f"extraction failed: {e}"}

        offset = max(1, int(offset))
        limit = max(1, int(limit))

        if doc.pages:
            selected = doc.pages[offset - 1 : offset - 1 + limit]
            total = len(doc.pages)
            return {
                "attachment_id": attachment_id,
                "filename": att.filename,
                "unit": "page",
                "offset": offset,
                "limit": limit,
                "total_pages": total,
                "content": "\n\n".join(f"[page {p.page}]\n{p.text}" for p in selected),
                "truncated": (offset - 1 + limit) < total,
            }
        # Text-only: use KB blocks.
        block = _MAX_CHARS
        start = (offset - 1) * block
        end = start + limit * block
        chunk = doc.text[start:end]
        total_blocks = max(1, (len(doc.text) + block - 1) // block)
        return {
            "attachment_id": attachment_id,
            "filename": att.filename,
            "unit": "block",
            "offset": offset,
            "limit": limit,
            "total_blocks": total_blocks,
            "block_chars": block,
            "content": chunk,
            "truncated": end < len(doc.text),
        }
