"""Domain-to-API schema mappers."""

from __future__ import annotations

from workspace_studio.models.domain import SessionRecord, WorkspaceRecord
from workspace_studio.schemas.session import SessionResponse
from workspace_studio.schemas.workspace import WorkspaceResponse


def workspace_response(record: WorkspaceRecord) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=record.id,
        tracking_id=record.tracking_id,
        name=record.name,
        description=record.description,
        owner_user_id=record.owner_user_id,
        local_fs_path=record.local_fs_path,
        status=record.status,
        sync_version=record.sync_version,
        version=record.version,
        active_session_id=record.active_session_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
        last_accessed_at=record.last_accessed_at,
    )


def session_response(record: SessionRecord) -> SessionResponse:
    return SessionResponse(
        id=record.id,
        workspace_id=record.workspace_id,
        user_id=record.user_id,
        session_name=record.session_name,
        status=record.status,
        is_active=record.is_active,
        context_snapshot=record.context_snapshot,
        created_at=record.created_at,
        updated_at=record.updated_at,
        last_accessed_at=record.last_accessed_at,
    )
