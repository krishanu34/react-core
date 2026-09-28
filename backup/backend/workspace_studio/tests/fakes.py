from __future__ import annotations

from typing import Any

from workspace_studio.models.domain import SessionRecord, WorkspaceRecord
from workspace_studio.models.exceptions import ConflictError, DuplicateError


class FakeWorkspaceRepository:
    def __init__(self) -> None:
        self.workspaces: dict[int, WorkspaceRecord] = {
            1: WorkspaceRecord(id=1, name="Test", owner_user_id=7, sync_version=1, version=1)
        }
        self.sessions: dict[int, SessionRecord] = {}
        self.state: dict[int, dict[str, Any]] = {}
        self.metadata: dict[int, dict[str, Any]] = {}
        self.chat: dict[int, dict[str, Any]] = {}
        self.sync_logs: dict[tuple[int, str, str], dict[str, Any]] = {}
        self.next_session_id = 1

    def health(self) -> bool:
        return True

    def create_workspace(self, owner_user_id: int, name: str, description: str | None, local_fs_path: str | None):
        normalized = name.casefold()
        for row in self.workspaces.values():
            # Mirrors ux_workspaces_owner_name_active: unique per OWNER.
            if row.owner_user_id == owner_user_id and row.status == "active" and row.name.casefold() == normalized:
                raise DuplicateError("Workspace name already exists")
        record = WorkspaceRecord(
            id=max(self.workspaces) + 1,
            name=name,
            owner_user_id=owner_user_id,
            description=description,
            local_fs_path=local_fs_path,
        )
        self.workspaces[record.id] = record
        return record

    def list_workspaces(self, owner_user_id: int | None, page: int, page_size: int, status: str | None):
        rows = [
            w for w in self.workspaces.values()
            if (owner_user_id is None or w.owner_user_id == owner_user_id)
            and (status is None or w.status == status)
            and w.status != "deleted"
        ]
        return rows[(page - 1) * page_size : page * page_size], len(rows)

    def get_workspace(self, workspace_id: int):
        row = self.workspaces.get(workspace_id)
        return row if row and row.status != "deleted" else None

    def update_workspace(self, workspace_id: int, updates: dict[str, Any], expected_version: int | None):
        row = self.get_workspace(workspace_id)
        if not row:
            return None
        if expected_version is not None and row.version != expected_version:
            raise ConflictError("Workspace version conflict")
        if "name" in updates and updates["name"] is not None:
            normalized = str(updates["name"]).casefold()
            for other in self.workspaces.values():
                if other.id != workspace_id and other.owner_user_id == row.owner_user_id and other.status == "active" and other.name.casefold() == normalized:
                    raise DuplicateError("Workspace name already exists")
        for key, value in updates.items():
            setattr(row, key, value)
        row.version += 1
        row.sync_version += 1
        return row

    def set_workspace_status(self, workspace_id: int, status: str):
        row = self.workspaces.get(workspace_id)
        if not row:
            return None
        row.status = status
        row.version += 1
        return row

    def set_active_workspace(self, workspace_id: int, session_id: int | None):
        row = self.get_workspace(workspace_id)
        if not row:
            return None
        row.active_session_id = session_id
        return row

    def create_session(self, workspace_id: int, user_id: int, session_name: str, context_snapshot: dict[str, Any], is_active: bool):
        row = SessionRecord(id=self.next_session_id, workspace_id=workspace_id, user_id=user_id, session_name=session_name, is_active=is_active, context_snapshot=context_snapshot)
        self.next_session_id += 1
        self.sessions[row.id] = row
        return row

    def list_sessions(self, workspace_id: int, page: int, page_size: int):
        rows = [s for s in self.sessions.values() if s.workspace_id == workspace_id]
        return rows[(page - 1) * page_size : page * page_size], len(rows)

    def get_active_session(self, workspace_id: int):
        return next((s for s in self.sessions.values() if s.workspace_id == workspace_id and s.is_active), None)

    def update_session(self, workspace_id: int, session_id: int, updates: dict[str, Any]):
        row = self.sessions.get(session_id)
        if not row or row.workspace_id != workspace_id:
            return None
        for key, value in updates.items():
            setattr(row, key, value)
        return row

    def get_recovery_state(self, workspace_id: int):
        return self.state.get(workspace_id)

    def save_recovery_state(self, workspace_id: int, session_id: int | None, state: dict[str, Any], expected_version: int | None):
        current = self.state.get(workspace_id)
        if current and expected_version is not None and current.get("version") != expected_version:
            raise ConflictError("Recovery state version conflict")
        state = dict(state)
        state["version"] = int((current or {}).get("version") or 0) + 1
        self.state[workspace_id] = state
        return state

    def get_metadata(self, workspace_id: int):
        return self.metadata.get(workspace_id)

    def save_metadata(self, workspace_id: int, metadata: dict[str, Any]):
        self.metadata[workspace_id] = metadata
        return metadata

    def get_chat(self, workspace_id: int):
        return self.chat.get(workspace_id, {"sessions": [], "messages": []})

    def save_chat(self, workspace_id: int, user_id: int, payload: dict[str, Any]):
        for item in payload.get("sessions", []):
            if not isinstance(item, dict):
                continue
            client_session_id = str(item.get("id") or "")
            existing = next(
                (
                    s
                    for s in self.sessions.values()
                    if s.workspace_id == workspace_id
                    and s.context_snapshot.get("source") == "workspace_studio_chat"
                    and s.context_snapshot.get("client_session_id") == client_session_id
                ),
                None,
            )
            if existing:
                existing.session_name = str(item.get("name") or existing.session_name)
                existing.context_snapshot = {
                    "source": "workspace_studio_chat",
                    "client_session_id": client_session_id,
                    "client_session": {**item, "messages": []},
                }
            else:
                self.create_session(
                    workspace_id,
                    user_id,
                    str(item.get("name") or "Session"),
                    {
                        "source": "workspace_studio_chat",
                        "client_session_id": client_session_id,
                        "client_session": {**item, "messages": []},
                    },
                    False,
                )
        self.chat[workspace_id] = payload
        return payload

    def get_sync_log(self, workspace_id: int, client_id: str, batch_id: str):
        return self.sync_logs.get((workspace_id, client_id, batch_id))

    def create_sync_log(self, workspace_id: int, user_id: int, client_id: str, batch_id: str, status: str, details: dict[str, Any]):
        self.sync_logs[(workspace_id, client_id, batch_id)] = details

    def list_sync_logs(self, workspace_id: int, page: int, page_size: int):
        rows = list(self.sync_logs.values())
        return rows[(page - 1) * page_size : page * page_size], len(rows)

    def bump_workspace_sync_version(self, workspace_id: int):
        row = self.workspaces[workspace_id]
        row.sync_version += 1
        return row.sync_version
