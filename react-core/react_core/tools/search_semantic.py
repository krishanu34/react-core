"""search_semantic — top-k semantic retrieval over the shared vector store."""
from __future__ import annotations

from typing import Any, Optional

from ..vector_store import get_vector_store
from .base import BaseTool


class SearchSemanticTool(BaseTool):
    name = "search_semantic"
    description = (
        "Search the vector store for chunks similar to `query`. Returns "
        "the top-k hits with their source, page, score, and text. "
        "Prefer this over reading whole attachments."
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
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "k": {"type": "integer", "description": "How many hits (default 5)."},
                "source_filter": {
                    "type": "string",
                    "description": "Substring to match against source URI (e.g. 'attachment:').",
                },
            },
            "required": ["query"],
        }

    async def run(
        self,
        query: str,
        k: int = 5,
        source_filter: Optional[str] = None,
        **_: Any,
    ) -> dict[str, Any]:
        store = get_vector_store()
        hits = await store.search(
            query,
            k=int(k),
            org_id=self._org_id,
            project_id=self._project_id,
            source_filter=source_filter,
        )
        return {
            "count": len(hits),
            "hits": [
                {
                    "source": h.source,
                    "page": h.page,
                    "chunk_index": h.chunk_index,
                    "score": round(h.score, 4),
                    "text": h.text,
                }
                for h in hits
            ],
        }
