"""Workspace CRUD routes."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, status

from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.dependencies import get_repository
from workspace_studio.schemas.common import PaginatedResponse
from workspace_studio.schemas.workspace import ActiveWorkspaceRequest, WorkspaceCreateRequest, WorkspaceResponse, WorkspaceUpdateRequest
from workspace_studio.security.auth import WORKSPACE_STUDIO_ROLE, require_role
from workspace_studio.services.workspace_service import WorkspaceService


router = APIRouter(prefix="/api/workspaces", tags=["Workspaces"])


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
def create_workspace(
    body: WorkspaceCreateRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).create(body, current_user)


@router.get("", response_model=PaginatedResponse[WorkspaceResponse])
def list_workspaces(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    status_filter: Optional[str] = Query(None, alias="status"),
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> PaginatedResponse[WorkspaceResponse]:
    """The caller's own workspaces (admins: everyone's).

    Scope comes from the JWT, never from a query parameter — a client-supplied
    scope would be a client-supplied authorisation decision.
    """
    return WorkspaceService(repo).list(
        current_user=current_user, page=page, page_size=page_size, status=status_filter
    )


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
def get_workspace(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).get(workspace_id, current_user)


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
def update_workspace(
    workspace_id: int,
    body: WorkspaceUpdateRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).update(workspace_id, body, current_user)


@router.delete("/{workspace_id}", response_model=WorkspaceResponse)
def delete_workspace(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).delete(workspace_id, current_user)


@router.post("/{workspace_id}/archive", response_model=WorkspaceResponse)
def archive_workspace(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).archive(workspace_id, current_user)


@router.post("/{workspace_id}/restore", response_model=WorkspaceResponse)
def restore_workspace(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).restore(workspace_id, current_user)


@router.post("/{workspace_id}/active", response_model=WorkspaceResponse)
def set_active_workspace(
    workspace_id: int,
    body: ActiveWorkspaceRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceResponse:
    return WorkspaceService(repo).set_active(workspace_id, current_user, body.session_id)
