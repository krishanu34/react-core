"""list_indexed_sources — inspect what's already searchable."""
from __future__ import annotations

from typing import Any, Optional

from ..app_db import get_app_db
from .base import BaseTool


class ListIndexedSourcesTool(BaseTool):
    name = "list_indexed_sources"
    description = (
        "List every source URI currently indexed in the vector store, "
        "with chunk count and last-indexed timestamp. Use this to decide "
        "whether to re-fetch or rely on `search_semantic`."
    )

    def __init__(
        self,
        workspace: str,
        *,
        org_id: str = "org-default",
        project_id: Optional[str] = None,
    ):
        super().__init__(workspace)
        self._org_id = org_id
        self._project_id = project_id

    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **_: Any) -> dict[str, Any]:
        db = get_app_db()
        sources = db.list_indexed_sources(self._org_id, self._project_id)
        return {
            "count": len(sources),
            "sources": [
                {
                    "source": s.source,
                    "chunks": s.chunk_count,
                    "indexed_at": s.indexed_at,
                    "project_id": s.project_id,
                    "collection_id": s.collection_id,
                }
                for s in sources
            ],
        }
