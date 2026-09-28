"""Recovery, metadata, and chat sync routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.repositories.dependencies import get_repository
from workspace_studio.schemas.recovery import WorkspaceMetadata, WorkspaceRecoveryState
from workspace_studio.schemas.session import ChatSyncRequest, ChatSyncResponse, SessionResponse
from workspace_studio.security.auth import WORKSPACE_STUDIO_ROLE, require_role
from workspace_studio.services.recovery_service import RecoveryService
from workspace_studio.services.session_service import SessionService
from workspace_studio.services.workspace_service import WorkspaceService


router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["Workspace Recovery"])


def _service(workspace_id: int, current_user: dict, repo: WorkspaceRepository) -> RecoveryService:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return RecoveryService(repo)


@router.get("/state", response_model=WorkspaceRecoveryState)
def get_state(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceRecoveryState:
    return _service(workspace_id, current_user, repo).get_state(workspace_id)


@router.put("/state", response_model=WorkspaceRecoveryState)
def save_state(
    workspace_id: int,
    body: WorkspaceRecoveryState,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceRecoveryState:
    return _service(workspace_id, current_user, repo).save_state(workspace_id, body)


@router.get("/session", response_model=SessionResponse | None)
def recover_session(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> SessionResponse | None:
    WorkspaceService(repo).ensure_access(workspace_id, current_user)
    return SessionService(repo).active(workspace_id)


@router.get("/metadata", response_model=WorkspaceMetadata | None)
def get_metadata(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceMetadata | None:
    return _service(workspace_id, current_user, repo).get_metadata(workspace_id)


@router.post("/metadata", response_model=WorkspaceMetadata)
def save_metadata(
    workspace_id: int,
    body: WorkspaceMetadata,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> WorkspaceMetadata:
    return _service(workspace_id, current_user, repo).save_metadata(workspace_id, body)


@router.get("/chat", response_model=ChatSyncResponse)
def get_chat(
    workspace_id: int,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> ChatSyncResponse:
    return _service(workspace_id, current_user, repo).get_chat(workspace_id)


@router.post("/chat", response_model=ChatSyncResponse)
def save_chat(
    workspace_id: int,
    body: ChatSyncRequest,
    current_user: dict = Depends(require_role(WORKSPACE_STUDIO_ROLE)),
    repo: WorkspaceRepository = Depends(get_repository),
) -> ChatSyncResponse:
    return _service(workspace_id, current_user, repo).save_chat(workspace_id, int(current_user["user_id"]), body)
