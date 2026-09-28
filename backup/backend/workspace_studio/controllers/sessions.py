"""Workspace session routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status

from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.dependencies import get_repository
from workspace_studio.schemas.common import PaginatedResponse
from workspace_studio.schemas.session import SessionCreateRequest, SessionResponse, SessionUpdateRequest
from workspace_studio.security.auth import WORKSPACE_STUDIO_ROLE, require_role
from workspace_studio.services.session_service import SessionService
from workspace_studio.services.workspace_service import WorkspaceService


router = APIRouter(prefix="/api/workspaces/{workspace_id}/sessions", tags=["Workspace Sessions"])


@router.post("", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
def create_session(
    workspace_id: int,
    body: SessionCreateRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> SessionResponse:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return SessionService(repo).create(workspace_id, body, current_user)


@router.get("", response_model=PaginatedResponse[SessionResponse])
def list_sessions(
    workspace_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=200),
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> PaginatedResponse[SessionResponse]:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return SessionService(repo).list(workspace_id, page, page_size)


@router.get("/active", response_model=SessionResponse | None)
def active_session(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> SessionResponse | None:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return SessionService(repo).active(workspace_id)


@router.put("/{session_id}", response_model=SessionResponse)
def update_session(
    workspace_id: int,
    session_id: int,
    body: SessionUpdateRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> SessionResponse:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return SessionService(repo).update(workspace_id, session_id, body)
