"""Workspace lifecycle service."""

from __future__ import annotations

from typing import Any

from workspace_studio.models.exceptions import ConflictError, NotFoundError
from workspace_studio.repositories.base import WorkspaceRepository
from workspace_studio.schemas.common import PaginatedResponse
from workspace_studio.schemas.workspace import WorkspaceCreateRequest, WorkspaceResponse, WorkspaceUpdateRequest
from workspace_studio.services.audit_service import audit_service
from workspace_studio.services.mappers import workspace_response


class WorkspaceService:
    """Workspace CRUD with per-user isolation.

    The OWNER is the tenancy boundary: a workspace belongs to one user, and every
    read/write path filters on `owner_user_id`. Admins (`is_admin`) see and manage
    everything, which is the only carve-out.

    This used to scope by `project_id` — a leftover from the DevAccel monorepo,
    where the project was the tenancy unit. In this standalone product there is no
    projects table and no /api/v1/projects endpoint, so that scoping filtered on a
    column nothing populated: workspaces went missing from the UI, and
    `owner_user_id` was written on create but never read, leaving every workspace
    reachable by id from any account holding the workspace_studio role.
    """

    def __init__(self, repo: WorkspaceRepository) -> None:
        self.repo = repo

    def create(self, body: WorkspaceCreateRequest, current_user: dict[str, Any]) -> WorkspaceResponse:
        owner_id = int(current_user["user_id"])
        record = self.repo.create_workspace(owner_id, body.name.strip(), body.description, body.local_fs_path)
        audit_service.record("workspace_created", workspace_id=record.id, user_id=owner_id, name=record.name)
        return workspace_response(record)

    def list(
        self,
        *,
        current_user: dict[str, Any],
        page: int,
        page_size: int,
        status: str | None = None,
    ) -> PaginatedResponse[WorkspaceResponse]:
        owner_filter = None if _is_admin(current_user) else int(current_user["user_id"])
        rows, total = self.repo.list_workspaces(owner_filter, page, page_size, status)
        return PaginatedResponse[WorkspaceResponse](
            items=[workspace_response(row) for row in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    def get(self, workspace_id: int, current_user: dict[str, Any]) -> WorkspaceResponse:
        record = self._get_record(workspace_id, current_user)
        return workspace_response(record)

    def update(self, workspace_id: int, body: WorkspaceUpdateRequest, current_user: dict[str, Any]) -> WorkspaceResponse:
        self._get_record(workspace_id, current_user)      # ownership gate
        updates = body.model_dump(exclude_unset=True)
        expected_version = updates.pop("version", None)
        if "name" in updates and updates["name"] is not None:
            updates["name"] = updates["name"].strip()
        try:
            record = self.repo.update_workspace(workspace_id, updates, expected_version)
        except ConflictError:
            raise
        if not record:
            raise NotFoundError("Workspace not found")
        audit_service.record("workspace_updated", workspace_id=workspace_id, user_id=int(current_user["user_id"]))
        return workspace_response(record)

    def delete(self, workspace_id: int, current_user: dict[str, Any]) -> WorkspaceResponse:
        self._get_record(workspace_id, current_user)
        record = self.repo.set_workspace_status(workspace_id, "deleted")
        if not record:
            raise NotFoundError("Workspace not found")
        audit_service.record("workspace_deleted", workspace_id=workspace_id, user_id=int(current_user["user_id"]))
        return workspace_response(record)

    def archive(self, workspace_id: int, current_user: dict[str, Any]) -> WorkspaceResponse:
        self._get_record(workspace_id, current_user)
        record = self.repo.set_workspace_status(workspace_id, "archived")
        if not record:
            raise NotFoundError("Workspace not found")
        audit_service.record("workspace_archived", workspace_id=workspace_id, user_id=int(current_user["user_id"]))
        return workspace_response(record)

    def restore(self, workspace_id: int, current_user: dict[str, Any]) -> WorkspaceResponse:
        self._get_record(workspace_id, current_user)
        record = self.repo.set_workspace_status(workspace_id, "active")
        if not record:
            raise NotFoundError("Workspace not found")
        audit_service.record("workspace_restored", workspace_id=workspace_id, user_id=int(current_user["user_id"]))
        return workspace_response(record)

    def set_active(self, workspace_id: int, current_user: dict[str, Any], session_id: int | None) -> WorkspaceResponse:
        self._get_record(workspace_id, current_user)
        record = self.repo.set_active_workspace(workspace_id, session_id)
        if not record:
            raise NotFoundError("Workspace not found")
        audit_service.record("workspace_activated", workspace_id=workspace_id, user_id=int(current_user["user_id"]), session_id=session_id)
        return workspace_response(record)

    def ensure_access(self, workspace_id: int, current_user: dict[str, Any]) -> None:
        """Ownership gate for the sibling services (sessions, sync, recovery, chat)."""
        self._get_record(workspace_id, current_user)

    def _get_record(self, workspace_id: int, current_user: dict[str, Any]):
        """Fetch a workspace the caller is allowed to touch, else raise NotFound.

        Deliberately NotFound and not Forbidden: a 403 confirms the id exists and
        turns the sequential BIGSERIAL primary key into an enumeration oracle. A
        caller who doesn't own it should not be able to tell the difference
        between "someone else's" and "doesn't exist".
        """
        record = self.repo.get_workspace(workspace_id)
        if not record:
            raise NotFoundError("Workspace not found")
        if _is_admin(current_user):
            return record
        # An unclaimed agent-created workspace (owner NULL) belongs to nobody yet;
        # it is claimed through the agent path (postgres_agent.claim_thread), not here.
        if record.owner_user_id != int(current_user["user_id"]):
            raise NotFoundError("Workspace not found")
        return record


def _is_admin(current_user: dict[str, Any]) -> bool:
    return bool(current_user.get("is_admin"))
