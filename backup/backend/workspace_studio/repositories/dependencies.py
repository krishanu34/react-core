"""FastAPI dependencies for repository access."""

from __future__ import annotations

from collections.abc import Generator

from fastapi import Request

from workspace_studio.config.launch_mode import LaunchMode
from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.config_repository import (
    ConfigurationRepository,
    DBConfigRepository,
    DevAccelAPIConfigRepository,
)
from workspace_studio.repositories.database import get_session
from workspace_studio.repositories.postgres import PostgresWorkspaceRepository


def get_repository() -> Generator[WorkspaceRepository, None, None]:
    with get_session() as session:
        yield PostgresWorkspaceRepository(session)


def get_config_repo(request: Request) -> ConfigurationRepository:
    """Resolve config repo based on the current user's launch mode."""
    user = getattr(request.state, "user", None) or {}
    launch_mode = LaunchMode(user.get("launch_mode", "standalone"))

    if launch_mode == LaunchMode.INTEGRATED:
        context = getattr(request.state, "devaccel_context", None)
        if context is None:
            raise RuntimeError("DevAccel context not available for integrated session")
        return DevAccelAPIConfigRepository(context)

    with get_session() as session:
        return DBConfigRepository(session)

