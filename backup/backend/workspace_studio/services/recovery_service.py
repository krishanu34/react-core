"""Recovery state, metadata, and chat persistence."""

from __future__ import annotations

from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.schemas.recovery import WorkspaceMetadata, WorkspaceRecoveryState
from workspace_studio.schemas.session import ChatSyncRequest, ChatSyncResponse


class RecoveryService:
    def __init__(self, repo: WorkspaceRepository) -> None:
        self.repo = repo

    def get_state(self, workspace_id: int) -> WorkspaceRecoveryState:
        state = self.repo.get_recovery_state(workspace_id) or {}
        return WorkspaceRecoveryState.model_validate(state)

    def save_state(
        self,
        workspace_id: int,
        state: WorkspaceRecoveryState,
        session_id: int | None = None,
        enforce_version: bool = True,
    ) -> WorkspaceRecoveryState:
        # enforce_version=True (default, used by PUT /state): optimistic
        # concurrency — reject if the client's version is stale.
        # enforce_version=False (used by the /sync snapshot push): last-writer-
        # wins. The sync client sends a full snapshot and has no way to learn
        # the server's recovery-state version (it isn't returned by /sync), so
        # enforcing it would 409 on every drain after the first.
        expected_version = state.version if enforce_version else None
        saved = self.repo.save_recovery_state(
            workspace_id, session_id, state.model_dump(mode="json"), expected_version
        )
        return WorkspaceRecoveryState.model_validate(saved)

    def get_metadata(self, workspace_id: int) -> WorkspaceMetadata | None:
        metadata = self.repo.get_metadata(workspace_id)
        return WorkspaceMetadata.model_validate(metadata) if metadata else None

    def save_metadata(self, workspace_id: int, metadata: WorkspaceMetadata) -> WorkspaceMetadata:
        saved = self.repo.save_metadata(workspace_id, metadata.model_dump(mode="json"))
        return WorkspaceMetadata.model_validate(saved)

    def get_chat(self, workspace_id: int) -> ChatSyncResponse:
        payload = self.repo.get_chat(workspace_id)
        return ChatSyncResponse.model_validate(payload)

    def save_chat(self, workspace_id: int, user_id: int, payload: ChatSyncRequest) -> ChatSyncResponse:
        saved = self.repo.save_chat(workspace_id, user_id, payload.model_dump(mode="json"))
        return ChatSyncResponse.model_validate(saved)
