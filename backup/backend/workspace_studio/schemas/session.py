"""Session and chat schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class SessionCreateRequest(BaseModel):
    session_name: str = Field(default="Workspace Session", min_length=1, max_length=255)
    context_snapshot: dict[str, Any] = Field(default_factory=dict)
    is_active: bool = True


class SessionUpdateRequest(BaseModel):
    session_name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    status: Optional[str] = Field(default=None, pattern="^(active|completed|archived)$")
    context_snapshot: Optional[dict[str, Any]] = None
    is_active: Optional[bool] = None


class SessionResponse(BaseModel):
    id: int
    workspace_id: int
    user_id: int
    session_name: str
    status: str
    is_active: bool
    context_snapshot: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_accessed_at: Optional[datetime] = None


class ChatMessage(BaseModel):
    id: Optional[int] = None
    role: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[datetime] = None


class ChatSyncRequest(BaseModel):
    session_id: Optional[int] = None
    sessions: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[ChatMessage] = Field(default_factory=list)


class ChatSyncResponse(BaseModel):
    sessions: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[ChatMessage] = Field(default_factory=list)

