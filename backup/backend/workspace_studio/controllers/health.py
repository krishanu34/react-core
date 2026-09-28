"""Health endpoints."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from workspace_studio.config.settings import get_settings
from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.dependencies import get_repository
from workspace_studio.schemas.common import HealthResponse


router = APIRouter(tags=["Health"])


@router.get("/health", response_model=HealthResponse)
def health(repo: WorkspaceRepository = Depends(get_repository)) -> HealthResponse:
    settings = get_settings()
    db_status = "ok"
    try:
        repo.health()
    except Exception:
        db_status = "unavailable"
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=settings.app_version,
        database=db_status,
        timestamp=datetime.now(timezone.utc),
    )

