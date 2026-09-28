"""Synchronization schemas."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class SyncOperation(BaseModel):
    op_id: str = Field(..., min_length=1)
    op: str = Field(..., pattern="^(metadata|state)$")
    path: Optional[str] = None
    type: Optional[str] = Field(default=None, pattern="^(file|folder)$")
    payload: dict[str, Any] = Field(default_factory=dict)
    base_version: Optional[int] = Field(default=None, ge=1)
    content_hash: Optional[str] = None
    client_updated_at: Optional[int] = None


class SyncRequest(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=128)
    batch_id: str = Field(..., min_length=1, max_length=128)
    indexeddb_version: Optional[int] = None
    local_fs_path: Optional[str] = None
    base_sync_version: Optional[int] = Field(default=None, ge=0)
    operations: list[SyncOperation] = Field(default_factory=list)


class SyncConflict(BaseModel):
    op_id: str
    path: Optional[str] = None
    reason: str
    server_version: Optional[int] = None
    client_base_version: Optional[int] = None


class SyncOperationResult(BaseModel):
    op_id: str
    status: str
    path: Optional[str] = None
    version: Optional[int] = None
    sync_version: Optional[int] = None
    etag: Optional[str] = None


class SyncResponse(BaseModel):
    workspace_id: int
    status: str
    sync_version: int
    applied: list[SyncOperationResult] = Field(default_factory=list)
    conflicts: list[SyncConflict] = Field(default_factory=list)
    idempotent_replay: bool = False
