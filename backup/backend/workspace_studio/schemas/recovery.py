"""Workspace recovery and metadata schemas."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class WorkspaceRecoveryState(BaseModel):
    open_tabs: list[dict[str, Any]] = Field(default_factory=list)
    active_files: list[str] = Field(default_factory=list)
    folder_tree: list[dict[str, Any]] = Field(default_factory=list)
    expanded_folders: list[str] = Field(default_factory=list)
    layout: dict[str, Any] = Field(default_factory=dict)
    session: dict[str, Any] = Field(default_factory=dict)
    recent_files: list[str] = Field(default_factory=list)
    version: int = Field(default=1, ge=1)


class WorkspaceMetadata(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    localPathLabel: Optional[str] = None
    createdAt: Optional[int] = None
    fileCount: int = 0
    extra: dict[str, Any] = Field(default_factory=dict)

