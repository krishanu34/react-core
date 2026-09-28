"""Vector store DTOs (kept small and backend-agnostic)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(slots=True)
class VectorDoc:
    """One chunk to embed and upsert."""
    text: str
    org_id: str
    source: str                     # 'attachment:foo.pdf', 'jira:PROJ-123', ...
    project_id: Optional[str] = None
    collection_id: Optional[str] = None
    page: Optional[int] = None
    chunk_index: int = 0
    metadata: dict = field(default_factory=dict)


@dataclass(slots=True)
class VectorHit:
    """One search result."""
    chunk_id: int
    text: str
    score: float
    source: str
    org_id: str
    project_id: Optional[str] = None
    collection_id: Optional[str] = None
    page: Optional[int] = None
    chunk_index: int = 0
    metadata: dict = field(default_factory=dict)
