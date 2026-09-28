"""Domain dataclasses used between repositories and services."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


@dataclass(slots=True)
class WorkspaceRecord:
    """A workspace. The OWNER is the tenancy boundary — every read path filters
    on `owner_user_id` (see WorkspaceService). There is no project scoping."""

    id: int
    name: str
    owner_user_id: int
    description: Optional[str] = None
    local_fs_path: Optional[str] = None
    status: str = "active"
    sync_version: int = 1
    version: int = 1
    active_session_id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_accessed_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    # Stable public handle for this workspace (== the agent's thread id).
    tracking_id: Optional[str] = None


@dataclass(slots=True)
class SessionRecord:
    id: int
    workspace_id: int
    user_id: int
    session_name: str
    status: str = "active"
    is_active: bool = False
    context_snapshot: dict[str, Any] = field(default_factory=dict)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_accessed_at: Optional[datetime] = None
