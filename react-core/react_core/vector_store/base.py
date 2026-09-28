"""VectorStore Protocol.

Backends implement `upsert`, `search`, `delete_source`, `list_sources`.
Search filters use metadata (`org_id`, `project_id`, `collection_id`) —
critical for our enterprise-wide, isolated-by-metadata design.
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from .models import VectorDoc, VectorHit


@runtime_checkable
class VectorStoreProtocol(Protocol):
    async def upsert(self, docs: list[VectorDoc]) -> list[int]:
        """Embed & store `docs`. Returns the assigned chunk IDs."""

    async def search(
        self,
        query: str,
        k: int = 5,
        *,
        org_id: Optional[str] = None,
        project_id: Optional[str] = None,
        collection_id: Optional[str] = None,
        source_filter: Optional[str] = None,
    ) -> list[VectorHit]:
        """Top-k semantic search, filtered by the given metadata."""

    async def delete_source(self, source: str, org_id: str) -> int:
        """Delete every chunk belonging to `source` within `org_id`. Returns count."""

    async def list_sources(
        self, org_id: str, project_id: Optional[str] = None
    ) -> list[str]:
        """List distinct source URIs currently indexed under `org_id`."""

    def close(self) -> None: ...
