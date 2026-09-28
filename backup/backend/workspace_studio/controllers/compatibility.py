"""Compatibility routes for the existing workspace frontend API shapes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.dependencies import get_repository
from workspace_studio.schemas.recovery import WorkspaceMetadata
from workspace_studio.schemas.session import ChatSyncRequest
from workspace_studio.security.auth import WORKSPACE_STUDIO_ROLE, require_role
from workspace_studio.services.recovery_service import RecoveryService
from workspace_studio.services.session_service import SessionService
from workspace_studio.services.workspace_service import WorkspaceService


router = APIRouter(tags=["Compatibility"])


def _client_local_files_removed():
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Workspace files are client-local. Use the linked browser folder instead of server file APIs.",
    )


@router.get("/api/v1/ide/workspaces/{workspace_id}/metadata")
def compat_get_metadata(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    metadata = RecoveryService(repo).get_metadata(workspace_id)
    return metadata or {}


@router.post("/api/v1/ide/workspaces/{workspace_id}/metadata")
def compat_save_metadata(
    workspace_id: int,
    body: WorkspaceMetadata,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return RecoveryService(repo).save_metadata(workspace_id, body)


@router.get("/api/v1/ide/workspaces/{workspace_id}/chat")
def compat_get_chat(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return RecoveryService(repo).get_chat(workspace_id)


@router.post("/api/v1/ide/workspaces/{workspace_id}/chat")
def compat_save_chat(
    workspace_id: int,
    body: ChatSyncRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return RecoveryService(repo).save_chat(workspace_id, int(current_user["user_id"]), body)


@router.get("/api/workspace/files")
def compat_workspace_files(
    project_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    _client_local_files_removed()


@router.get("/api/workspace/files/{file_path:path}")
def compat_workspace_file_content(
    file_path: str,
    project_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    _client_local_files_removed()


@router.post("/api/workspace/files/create")
def compat_create_file(
    project_id: int,
    path: str,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    _client_local_files_removed()


@router.post("/api/workspace/files/{file_path:path}/delete")
def compat_delete_file(
    file_path: str,
    project_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    _client_local_files_removed()


@router.post("/api/workspace/files/{file_path:path}/save")
def compat_save_file(
    file_path: str,
    project_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    _client_local_files_removed()


@router.get("/api/session/list")
def compat_list_sessions(
    project_id: int,
    limit: int = 100,
    offset: int = 0,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    page_size = max(1, min(limit, 200))
    page = (offset // page_size) + 1
    result = SessionService(repo).list(project_id, page, page_size)
    return {
        "sessions": [
            {
                "id": item.id,
                "session_name": item.session_name,
                "status": item.status,
                "created_at": item.created_at.isoformat() if item.created_at else None,
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
            }
            for item in result.items
        ],
        "total": result.total,
    }


@router.get("/api/session/active")
def compat_active_session(
    project_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
):
    WorkspaceService(repo).ensure_access(project_id, current_user)
    active = SessionService(repo).active(project_id)
    if not active:
        return {"session": None}
    return {"id": active.id, "session_name": active.session_name, "status": active.status, "session": active.model_dump(mode="json")}
