"""Plain data-transfer objects for the App DB.

These are the only shapes callers see. Backend implementations translate
rows/documents into these dataclasses.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(slots=True)
class Org:
    id: str
    name: str
    created_at: str


@dataclass(slots=True)
class User:
    id: str
    org_id: str
    name: str
    email: Optional[str]
    created_at: str


@dataclass(slots=True)
class Credential:
    """Per-user auth token for an external provider (Jira / Confluence / etc.)."""
    id: str
    user_id: str
    team_id: Optional[str]
    provider: str            # 'jira' | 'confluence' | 'github' | ...
    base_url: str
    token: str               # MVP: plaintext. TODO: encrypt at rest via DATABASE_ENCRYPTION_KEY.
    refresh_token: Optional[str]
    expires_at: Optional[str]
    auth_type: str           # 'bearer' | 'basic' | 'pat'
    email: Optional[str]     # for Atlassian Cloud (basic-auth email + API token)
    created_at: str
    updated_at: str


@dataclass(slots=True)
class Thread:
    id: str
    org_id: str
    user_id: str
    project_id: Optional[str]
    workspace_path: Optional[str]
    title: Optional[str]
    created_at: str
    updated_at: str


@dataclass(slots=True)
class Message:
    id: str
    thread_id: str
    role: str                # 'user' | 'assistant'
    content: str
    created_at: str


@dataclass(slots=True)
class Attachment:
    id: str
    org_id: str
    thread_id: Optional[str]   # thread that first uploaded it; retrievable org-wide
    filename: str
    mime: Optional[str]
    size: int
    path: str                  # absolute path on disk
    pages: Optional[int]
    indexed: bool
    fingerprint: str           # sha256 of content (drives dedup)
    created_at: str


@dataclass(slots=True)
class Artefact:
    """A file the agent produced (test cases, automation script, ...)."""
    id: str
    thread_id: str
    org_id: str
    project_id: Optional[str]
    kind: str                  # 'scenario' | 'test_case' | 'automation' | 'perf' | 'security' | 'traceability' | 'other'
    name: str
    path: str                  # workspace-relative
    size: Optional[int]
    approved_by: Optional[str]
    approved_at: Optional[str]
    created_at: str


@dataclass(slots=True)
class IndexedSource:
    """Fingerprint bookkeeping — lets us skip re-embedding unchanged sources."""
    source: str                # 'attachment:foo.pdf' | 'jira:PROJ-123' | 'conf:5687' | 'web:<hash>'
    org_id: str
    project_id: Optional[str]
    collection_id: Optional[str]
    fingerprint: str
    chunk_count: int
    indexed_at: str


@dataclass(slots=True)
class VectorChunk:
    """One embeddable text chunk. `id` becomes the FAISS vector ID."""
    id: int
    source: str
    org_id: str
    project_id: Optional[str]
    collection_id: Optional[str]
    page: Optional[int]
    chunk_index: int
    text: str
    metadata: dict = field(default_factory=dict)
    created_at: str = ""
