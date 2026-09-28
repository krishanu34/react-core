"""Lightweight workspace metadata synchronization service."""

from __future__ import annotations

from typing import Any

from workspace_studio.config.settings import get_settings
from workspace_studio.models.exceptions import ValidationError
from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.schemas.recovery import WorkspaceMetadata, WorkspaceRecoveryState
from workspace_studio.schemas.sync import SyncOperationResult, SyncRequest, SyncResponse
from workspace_studio.services.audit_service import audit_service
from workspace_studio.services.recovery_service import RecoveryService


class SyncService:
    def __init__(self, repo: WorkspaceRepository) -> None:
        self.repo = repo
        self.recovery = RecoveryService(repo)

    def apply(self, workspace_id: int, body: SyncRequest, current_user: dict[str, Any]) -> SyncResponse:
        if len(body.operations) > get_settings().max_sync_operations:
            raise ValidationError("Too many sync operations")

        replay = self.repo.get_sync_log(workspace_id, body.client_id, body.batch_id)
        if replay:
            replay["idempotent_replay"] = True
            return SyncResponse.model_validate(replay)

        applied: list[SyncOperationResult] = []
        conflicts = []

        if body.local_fs_path:
            self.repo.update_workspace(workspace_id, {"local_fs_path": body.local_fs_path}, None)

        for op in body.operations:
            try:
                result = self._apply_operation(workspace_id, op.model_dump(mode="json"), current_user)
                applied.append(result)
            except ValidationError:
                raise

        sync_version = self.repo.bump_workspace_sync_version(workspace_id) if applied else (body.base_sync_version or 0)
        status = "conflict" if conflicts else "synced"
        response = SyncResponse(
            workspace_id=workspace_id,
            status=status,
            sync_version=sync_version,
            applied=applied,
            conflicts=conflicts,
        )
        self.repo.create_sync_log(
            workspace_id,
            int(current_user["user_id"]),
            body.client_id,
            body.batch_id,
            status,
            response.model_dump(mode="json"),
        )
        audit_service.record(
            "workspace_sync_applied",
            workspace_id=workspace_id,
            user_id=int(current_user["user_id"]),
            client_id=body.client_id,
            batch_id=body.batch_id,
            applied=len(applied),
            conflicts=len(conflicts),
        )
        return response

    def _apply_operation(self, workspace_id: int, op: dict[str, Any], current_user: dict[str, Any]) -> SyncOperationResult:
        op_name = op["op"]
        op_id = op["op_id"]

        if op_name == "metadata":
            payload = dict(op.get("payload") or {})
            payload.setdefault("id", workspace_id)
            payload.setdefault("name", payload.get("name") or "Workspace")
            self.recovery.save_metadata(workspace_id, WorkspaceMetadata.model_validate(payload))
            return SyncOperationResult(op_id=op_id, status="applied")

        if op_name == "state":
            # Snapshot pushes are last-writer-wins: the client can't track the
            # server's recovery-state version (it isn't echoed back by /sync),
            # so enforcing it would 409 on every drain after the first.
            self.recovery.save_state(
                workspace_id,
                WorkspaceRecoveryState.model_validate(op.get("payload") or {}),
                enforce_version=False,
            )
            return SyncOperationResult(op_id=op_id, status="applied")

        raise ValidationError(f"Unsupported sync operation: {op_name}")
