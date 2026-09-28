"""Workspace API schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class WorkspaceCreateRequest(BaseModel):
    # Standalone: a workspace belongs directly to the authenticated user. The
    # owner comes from the JWT, so there is nothing here to scope it with.
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    local_fs_path: str = Field(..., min_length=1)


class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    local_fs_path: Optional[str] = None
    status: Optional[str] = Field(default=None, pattern="^(active|archived)$")
    version: Optional[int] = Field(default=None, ge=1)


class WorkspaceResponse(BaseModel):
    id: int
    tracking_id: Optional[str] = None
    name: str
    description: Optional[str] = None
    owner_user_id: int
    local_fs_path: Optional[str] = None
    status: str
    sync_version: int
    version: int
    active_session_id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_accessed_at: Optional[datetime] = None


class ActiveWorkspaceRequest(BaseModel):
    session_id: Optional[int] = None
