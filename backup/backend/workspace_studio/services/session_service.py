"""Workspace session service."""

from __future__ import annotations

from typing import Any

from workspace_studio.models.exceptions import NotFoundError
from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.schemas.common import PaginatedResponse
from workspace_studio.schemas.session import SessionCreateRequest, SessionResponse, SessionUpdateRequest
from workspace_studio.services.audit_service import audit_service
from workspace_studio.services.mappers import session_response


class SessionService:
    def __init__(self, repo: WorkspaceRepository) -> None:
        self.repo = repo

    def create(self, workspace_id: int, body: SessionCreateRequest, current_user: dict[str, Any]) -> SessionResponse:
        record = self.repo.create_session(
            workspace_id,
            int(current_user["user_id"]),
            body.session_name,
            body.context_snapshot,
            body.is_active,
        )
        audit_service.record("workspace_session_created", workspace_id=workspace_id, user_id=int(current_user["user_id"]), session_id=record.id)
        return session_response(record)

    def list(self, workspace_id: int, page: int, page_size: int) -> PaginatedResponse[SessionResponse]:
        rows, total = self.repo.list_sessions(workspace_id, page, page_size)
        return PaginatedResponse[SessionResponse](
            items=[session_response(row) for row in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    def active(self, workspace_id: int) -> SessionResponse | None:
        row = self.repo.get_active_session(workspace_id)
        return session_response(row) if row else None

    def update(self, workspace_id: int, session_id: int, body: SessionUpdateRequest) -> SessionResponse:
        record = self.repo.update_session(workspace_id, session_id, body.model_dump(exclude_unset=True))
        if not record:
            raise NotFoundError("Session not found")
        return session_response(record)

