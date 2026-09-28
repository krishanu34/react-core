"""Workspace synchronization routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.dependencies import get_repository
from workspace_studio.schemas.common import PaginatedResponse
from workspace_studio.schemas.sync import SyncRequest, SyncResponse
from workspace_studio.security.auth import WORKSPACE_STUDIO_ROLE, require_role
from workspace_studio.services.sync_service import SyncService
from workspace_studio.services.workspace_service import WorkspaceService


router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["Workspace Sync"])


@router.post("/sync", response_model=SyncResponse)
def sync_workspace(
    workspace_id: int,
    body: SyncRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> SyncResponse:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return SyncService(repo).apply(workspace_id, body, current_user)


@router.get("/sync/logs", response_model=PaginatedResponse[dict])
def sync_logs(
    workspace_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> PaginatedResponse[dict]:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    rows, total = repo.list_sync_logs(workspace_id, page, page_size)
    return PaginatedResponse[dict](items=rows, total=total, page=page, page_size=page_size)
