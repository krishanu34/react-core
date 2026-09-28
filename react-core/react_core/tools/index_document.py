"""index_document — ingest raw text into the vector store."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Optional

from ..app_db import IndexedSource, get_app_db
from ..vector_store import VectorDoc, chunk_text, get_vector_store
from .base import BaseTool


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class IndexDocumentTool(BaseTool):
    name = "index_document"
    description = (
        "Chunk, embed, and upsert a raw text document into the shared "
        "vector store. Idempotent: if the same `source` is re-indexed "
        "with unchanged content the call is a no-op (fingerprint match)."
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
                "source": {"type": "string", "description": "Stable URI like 'jira:PROJ-123' or 'note:release-plan'."},
                "text": {"type": "string"},
                "metadata": {"type": "object"},
                "collection_id": {"type": "string"},
            },
            "required": ["source", "text"],
        }

    async def run(
        self,
        source: str,
        text: str,
        metadata: Optional[dict[str, Any]] = None,
        collection_id: Optional[str] = None,
        **_: Any,
    ) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"error": "empty text"}
        fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()

        db = get_app_db()
        existing = db.get_indexed_source(source, self._org_id)
        if existing and existing.fingerprint == fingerprint:
            return {"source": source, "status": "unchanged", "chunks_stored": 0}

        store = get_vector_store()
        if existing is not None:
            await store.delete_source(source, self._org_id)

        chunks = chunk_text(text)
        docs = [
            VectorDoc(
                text=c,
                org_id=self._org_id,
                source=source,
                project_id=self._project_id,
                collection_id=collection_id,
                chunk_index=i,
                metadata=metadata or {},
            )
            for i, c in enumerate(chunks)
        ]
        if not docs:
            return {"source": source, "chunks_stored": 0}
        await store.upsert(docs)
        db.upsert_indexed_source(
            IndexedSource(
                source=source,
                org_id=self._org_id,
                project_id=self._project_id,
                collection_id=collection_id,
                fingerprint=fingerprint,
                chunk_count=len(docs),
                indexed_at=_utcnow(),
            )
        )
        return {"source": source, "chunks_stored": len(docs)}
