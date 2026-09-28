"""PostgreSQL repository for Workspace Studio."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from workspace_studio.models.domain import SessionRecord, WorkspaceRecord
from workspace_studio.models.exceptions import ConflictError, DuplicateError
from workspace_studio.sync.hashing import stable_payload_hash


def _json(value: Any) -> Any:
    if value is None:
        return {}
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value


def _dump(value: Any) -> str:
    return json.dumps(value or {}, default=str)


class PostgresWorkspaceRepository:
    """Raw-SQL repository matching the existing module style."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def health(self) -> bool:
        self.session.execute(text("SELECT 1"))
        return True

    def create_workspace(
        self,
        owner_user_id: int,
        name: str,
        description: str | None,
        local_fs_path: str | None,
    ) -> WorkspaceRecord:
        try:
            row = self.session.execute(
                text(
                    """
                    INSERT INTO workspaces (name, description, owner_user_id, local_fs_path, created_at, updated_at, last_accessed_at)
                    VALUES (:name, :description, :owner_user_id, :local_fs_path, NOW(), NOW(), NOW())
                    RETURNING *
                    """
                ),
                {
                    "name": name,
                    "description": description,
                    "owner_user_id": owner_user_id,
                    "local_fs_path": local_fs_path,
                },
            ).fetchone()
        except IntegrityError as exc:
            # ux_workspaces_owner_name_active: one active name per owner.
            raise DuplicateError("Workspace name already exists") from exc
        return self._workspace(row)

    def list_workspaces(
        self, owner_user_id: int | None, page: int, page_size: int, status: str | None
    ) -> tuple[list[WorkspaceRecord], int]:
        offset = (page - 1) * page_size
        params: dict[str, Any] = {"limit": page_size, "offset": offset}
        # Synthetic accounting rows ('__global__', '__chat__') are agent
        # bookkeeping, never user-visible workspaces.
        conditions = ["tracking_id NOT IN ('__global__', '__chat__')"]
        if owner_user_id is None:
            # Admin view. Unclaimed agent-created rows have a NULL owner.
            conditions.append("owner_user_id IS NOT NULL")
        else:
            conditions.append("owner_user_id = :owner_user_id")
            params["owner_user_id"] = owner_user_id
        if status:
            conditions.append("status = :status")
            params["status"] = status
        else:
            conditions.append("status <> 'deleted'")
        where = " AND ".join(conditions)
        total = int(self.session.execute(text(f"SELECT COUNT(*) FROM workspaces WHERE {where}"), params).scalar() or 0)
        rows = self.session.execute(
            text(
                f"""
                SELECT *
                FROM workspaces
                WHERE {where}
                ORDER BY last_accessed_at DESC NULLS LAST, updated_at DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        ).fetchall()
        return [self._workspace(row) for row in rows], total

    def get_workspace(self, workspace_id: int) -> WorkspaceRecord | None:
        row = self.session.execute(
            text(
                """
                SELECT *
                FROM workspaces
                WHERE id = :workspace_id AND status <> 'deleted'
                """
            ),
            {"workspace_id": workspace_id},
        ).fetchone()
        return self._workspace(row) if row else None

    def update_workspace(
        self,
        workspace_id: int,
        updates: dict[str, Any],
        expected_version: int | None,
    ) -> WorkspaceRecord | None:
        existing = self.get_workspace(workspace_id)
        if not existing:
            return None
        if expected_version is not None and existing.version != expected_version:
            raise ConflictError("Workspace version conflict")

        allowed = {k: v for k, v in updates.items() if k in {"name", "description", "local_fs_path", "status"}}
        if not allowed:
            return existing
        set_parts = [f"{key} = :{key}" for key in allowed]
        set_parts.extend(["version = version + 1", "sync_version = sync_version + 1", "updated_at = NOW()"])
        params = {"workspace_id": workspace_id, **allowed}
        row = self.session.execute(
            text(
                f"""
                UPDATE workspaces
                SET {", ".join(set_parts)}
                WHERE id = :workspace_id AND status <> 'deleted'
                RETURNING *
                """
            ),
            params,
        ).fetchone()
        return self._workspace(row) if row else None

    def set_workspace_status(self, workspace_id: int, status: str) -> WorkspaceRecord | None:
        deleted_expr = "NOW()" if status == "deleted" else "NULL"
        row = self.session.execute(
            text(
                f"""
                UPDATE workspaces
                SET status = :status,
                    deleted_at = {deleted_expr},
                    version = version + 1,
                    sync_version = sync_version + 1,
                    updated_at = NOW()
                WHERE id = :workspace_id
                RETURNING *
                """
            ),
            {"workspace_id": workspace_id, "status": status},
        ).fetchone()
        return self._workspace(row) if row else None

    def set_active_workspace(self, workspace_id: int, session_id: int | None) -> WorkspaceRecord | None:
        row = self.session.execute(
            text(
                """
                UPDATE workspaces
                SET active_session_id = :session_id,
                    last_accessed_at = NOW(),
                    updated_at = NOW()
                WHERE id = :workspace_id AND status <> 'deleted'
                RETURNING *
                """
            ),
            {"workspace_id": workspace_id, "session_id": session_id},
        ).fetchone()
        return self._workspace(row) if row else None

    def create_session(
        self,
        workspace_id: int,
        user_id: int,
        session_name: str,
        context_snapshot: dict[str, Any],
        is_active: bool,
    ) -> SessionRecord:
        if is_active:
            self.session.execute(
                text("UPDATE sessions SET is_active = FALSE WHERE workspace_id = :workspace_id"),
                {"workspace_id": workspace_id},
            )
        row = self.session.execute(
            text(
                """
                INSERT INTO sessions (
                    workspace_id, user_id, session_name, context_snapshot, is_active,
                    created_at, updated_at, last_accessed_at
                )
                VALUES (:workspace_id, :user_id, :session_name, CAST(:context_snapshot AS jsonb), :is_active, NOW(), NOW(), NOW())
                RETURNING *
                """
            ),
            {
                "workspace_id": workspace_id,
                "user_id": user_id,
                "session_name": session_name,
                "context_snapshot": _dump(context_snapshot),
                "is_active": is_active,
            },
        ).fetchone()
        record = self._session(row)
        if is_active:
            self.session.execute(
                text("UPDATE workspaces SET active_session_id = :sid WHERE id = :workspace_id"),
                {"sid": record.id, "workspace_id": workspace_id},
            )
        return record

    def list_sessions(self, workspace_id: int, page: int, page_size: int) -> tuple[list[SessionRecord], int]:
        offset = (page - 1) * page_size
        params = {"workspace_id": workspace_id, "limit": page_size, "offset": offset}
        total = int(self.session.execute(text("SELECT COUNT(*) FROM sessions WHERE workspace_id = :workspace_id"), params).scalar() or 0)
        rows = self.session.execute(
            text(
                """
                SELECT *
                FROM sessions
                WHERE workspace_id = :workspace_id
                ORDER BY is_active DESC, updated_at DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        ).fetchall()
        return [self._session(row) for row in rows], total

    def get_active_session(self, workspace_id: int) -> SessionRecord | None:
        row = self.session.execute(
            text(
                """
                SELECT *
                FROM sessions
                WHERE workspace_id = :workspace_id AND is_active = TRUE
                ORDER BY updated_at DESC
                LIMIT 1
                """
            ),
            {"workspace_id": workspace_id},
        ).fetchone()
        return self._session(row) if row else None

    def update_session(self, workspace_id: int, session_id: int, updates: dict[str, Any]) -> SessionRecord | None:
        if updates.get("is_active") is True:
            self.session.execute(
                text("UPDATE sessions SET is_active = FALSE WHERE workspace_id = :workspace_id"),
                {"workspace_id": workspace_id},
            )
        allowed = {k: v for k, v in updates.items() if k in {"session_name", "status", "context_snapshot", "is_active"}}
        if not allowed:
            row = self.session.execute(
                text("SELECT * FROM sessions WHERE workspace_id = :workspace_id AND id = :session_id"),
                {"workspace_id": workspace_id, "session_id": session_id},
            ).fetchone()
            return self._session(row) if row else None
        set_parts: list[str] = []
        params = {"workspace_id": workspace_id, "session_id": session_id}
        for key, value in allowed.items():
            if key == "context_snapshot":
                set_parts.append("context_snapshot = CAST(:context_snapshot AS jsonb)")
                params[key] = _dump(value)
            else:
                set_parts.append(f"{key} = :{key}")
                params[key] = value
        set_parts.append("updated_at = NOW()")
        row = self.session.execute(
            text(
                f"""
                UPDATE sessions
                SET {", ".join(set_parts)}
                WHERE workspace_id = :workspace_id AND id = :session_id
                RETURNING *
                """
            ),
            params,
        ).fetchone()
        record = self._session(row) if row else None
        if record and record.is_active:
            self.session.execute(
                text("UPDATE workspaces SET active_session_id = :sid WHERE id = :workspace_id"),
                {"sid": record.id, "workspace_id": workspace_id},
            )
        return record

    def get_recovery_state(self, workspace_id: int) -> dict[str, Any] | None:
        row = self.session.execute(
            text("SELECT state_json, version FROM session_state WHERE workspace_id = :workspace_id"),
            {"workspace_id": workspace_id},
        ).fetchone()
        if not row:
            return None
        state = _json(row._mapping["state_json"])
        state["version"] = row._mapping["version"]
        return state

    def save_recovery_state(
        self,
        workspace_id: int,
        session_id: int | None,
        state: dict[str, Any],
        expected_version: int | None,
    ) -> dict[str, Any]:
        existing = self.get_recovery_state(workspace_id)
        if existing and expected_version is not None and int(existing.get("version") or 1) != expected_version:
            raise ConflictError("Recovery state version conflict")
        row = self.session.execute(
            text(
                """
                INSERT INTO session_state (workspace_id, session_id, state_json, version, created_at, updated_at)
                VALUES (:workspace_id, :session_id, CAST(:state_json AS jsonb), 1, NOW(), NOW())
                ON CONFLICT (workspace_id)
                DO UPDATE SET
                    session_id = EXCLUDED.session_id,
                    state_json = EXCLUDED.state_json,
                    version = session_state.version + 1,
                    updated_at = NOW()
                RETURNING state_json, version
                """
            ),
            {"workspace_id": workspace_id, "session_id": session_id, "state_json": _dump(state)},
        ).fetchone()
        saved = _json(row._mapping["state_json"])
        saved["version"] = row._mapping["version"]
        return saved

    def get_metadata(self, workspace_id: int) -> dict[str, Any] | None:
        state = self.get_recovery_state(workspace_id)
        if not state:
            return None
        metadata = state.get("metadata")
        return metadata if isinstance(metadata, dict) else None

    def save_metadata(self, workspace_id: int, metadata: dict[str, Any]) -> dict[str, Any]:
        current = self.get_recovery_state(workspace_id) or {}
        current["metadata"] = metadata
        self.save_recovery_state(workspace_id, None, current, None)
        return metadata

    def get_chat(self, workspace_id: int) -> dict[str, Any]:
        session_rows = self.session.execute(
            text(
                """
                SELECT *
                FROM sessions
                WHERE workspace_id = :workspace_id
                  AND COALESCE(context_snapshot->>'source', '') = 'workspace_studio_chat'
                ORDER BY created_at ASC, id ASC
                """
            ),
            {"workspace_id": workspace_id},
        ).fetchall()
        if not session_rows:
            return {"sessions": [], "messages": []}

        db_session_ids = [int(row._mapping["id"]) for row in session_rows]
        message_rows = self.session.execute(
            text(
                """
                SELECT *
                FROM chat_messages
                WHERE workspace_id = :workspace_id
                  AND session_id = ANY(:session_ids)
                ORDER BY session_id ASC, id ASC
                """
            ),
            {"workspace_id": workspace_id, "session_ids": db_session_ids},
        ).fetchall()

        messages_by_session: dict[int, list[dict[str, Any]]] = {sid: [] for sid in db_session_ids}
        flat_messages: list[dict[str, Any]] = []
        for row in message_rows:
            data = row._mapping
            metadata = _json(data.get("metadata"))
            client_message = metadata.get("client_message") if isinstance(metadata, dict) else None
            message = client_message if isinstance(client_message, dict) else {
                "kind": "text",
                "role": data["role"],
                "text": data["content"],
            }
            messages_by_session.setdefault(int(data["session_id"]), []).append(message)
            flat_messages.append({
                "id": int(data["id"]),
                "role": data["role"],
                "content": data["content"],
                "metadata": metadata if isinstance(metadata, dict) else {},
                "created_at": data.get("created_at"),
            })

        sessions: list[dict[str, Any]] = []
        for row in session_rows:
            data = row._mapping
            snapshot = _json(data.get("context_snapshot"))
            client_session = snapshot.get("client_session") if isinstance(snapshot, dict) else None
            session_payload = dict(client_session) if isinstance(client_session, dict) else {
                "id": str(snapshot.get("client_session_id") or data["id"]) if isinstance(snapshot, dict) else str(data["id"]),
                "name": data["session_name"],
                "createdAt": int(data["created_at"].timestamp() * 1000) if data.get("created_at") else None,
            }
            session_payload["messages"] = messages_by_session.get(int(data["id"]), [])
            sessions.append(session_payload)

        return {"sessions": sessions, "messages": flat_messages}

    def save_chat(self, workspace_id: int, user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        sessions = payload.get("sessions")
        if not isinstance(sessions, list):
            sessions = []

        incoming_client_ids: set[str] = set()
        for index, chat_session in enumerate(sessions):
            if not isinstance(chat_session, dict):
                continue
            client_session_id = str(chat_session.get("id") or f"session-{index + 1}")
            incoming_client_ids.add(client_session_id)
            session_name = str(chat_session.get("name") or f"Session {index + 1}")[:255]
            messages = chat_session.get("messages")
            if not isinstance(messages, list):
                messages = []

            existing = self.session.execute(
                text(
                    """
                    SELECT *
                    FROM sessions
                    WHERE workspace_id = :workspace_id
                      AND COALESCE(context_snapshot->>'source', '') = 'workspace_studio_chat'
                      AND context_snapshot->>'client_session_id' = :client_session_id
                    LIMIT 1
                    """
                ),
                {"workspace_id": workspace_id, "client_session_id": client_session_id},
            ).fetchone()

            context_snapshot = {
                "source": "workspace_studio_chat",
                "client_session_id": client_session_id,
                "client_session": {**chat_session, "messages": []},
            }
            if existing:
                db_session_id = int(existing._mapping["id"])
                self.session.execute(
                    text(
                        """
                        UPDATE sessions
                        SET session_name = :session_name,
                            context_snapshot = CAST(:context_snapshot AS jsonb),
                            updated_at = NOW(),
                            last_accessed_at = NOW()
                        WHERE id = :session_id
                        """
                    ),
                    {
                        "session_id": db_session_id,
                        "session_name": session_name,
                        "context_snapshot": _dump(context_snapshot),
                    },
                )
            else:
                row = self.session.execute(
                    text(
                        """
                        INSERT INTO sessions (
                            workspace_id, user_id, session_name, status, is_active,
                            context_snapshot, created_at, updated_at, last_accessed_at
                        )
                        VALUES (
                            :workspace_id, :user_id, :session_name, 'active', FALSE,
                            CAST(:context_snapshot AS jsonb), NOW(), NOW(), NOW()
                        )
                        RETURNING id
                        """
                    ),
                    {
                        "workspace_id": workspace_id,
                        "user_id": user_id,
                        "session_name": session_name,
                        "context_snapshot": _dump(context_snapshot),
                    },
                ).fetchone()
                db_session_id = int(row._mapping["id"])

            self.session.execute(
                text("DELETE FROM chat_messages WHERE workspace_id = :workspace_id AND session_id = :session_id"),
                {"workspace_id": workspace_id, "session_id": db_session_id},
            )
            for order, message in enumerate(messages):
                if not isinstance(message, dict):
                    continue
                role = message.get("role") if message.get("role") in {"system", "user", "assistant", "tool"} else "assistant"
                content = str(message.get("text") or message.get("answer") or message.get("content") or "")
                metadata = {
                    "source": "workspace_studio_chat",
                    "client_session_id": client_session_id,
                    "order": order,
                    "client_message": message,
                }
                self.session.execute(
                    text(
                        """
                        INSERT INTO chat_messages (workspace_id, session_id, role, content, metadata, created_at)
                        VALUES (:workspace_id, :session_id, :role, :content, CAST(:metadata AS jsonb), NOW())
                        """
                    ),
                    {
                        "workspace_id": workspace_id,
                        "session_id": db_session_id,
                        "role": role,
                        "content": content,
                        "metadata": _dump(metadata),
                    },
                )

        if incoming_client_ids:
            self.session.execute(
                text(
                    """
                    DELETE FROM sessions
                    WHERE workspace_id = :workspace_id
                      AND COALESCE(context_snapshot->>'source', '') = 'workspace_studio_chat'
                      AND NOT (context_snapshot->>'client_session_id' = ANY(:client_session_ids))
                    """
                ),
                {"workspace_id": workspace_id, "client_session_ids": list(incoming_client_ids)},
            )

        return self.get_chat(workspace_id)

    def get_sync_log(self, workspace_id: int, client_id: str, batch_id: str) -> dict[str, Any] | None:
        row = self.session.execute(
            text(
                """
                SELECT details
                FROM sync_logs
                WHERE workspace_id = :workspace_id AND client_id = :client_id AND batch_id = :batch_id
                ORDER BY created_at DESC
                LIMIT 1
                """
            ),
            {"workspace_id": workspace_id, "client_id": client_id, "batch_id": batch_id},
        ).fetchone()
        return _json(row._mapping["details"]) if row else None

    def create_sync_log(
        self,
        workspace_id: int,
        user_id: int,
        client_id: str,
        batch_id: str,
        status: str,
        details: dict[str, Any],
    ) -> None:
        self.session.execute(
            text(
                """
                INSERT INTO sync_logs (
                    workspace_id, user_id, client_id, batch_id, idempotency_key,
                    operation_count, status, conflict_count, request_hash, details, created_at
                )
                VALUES (
                    :workspace_id, :user_id, :client_id, :batch_id, :idempotency_key,
                    :operation_count, :status, :conflict_count, :request_hash, CAST(:details AS jsonb), NOW()
                )
                ON CONFLICT (workspace_id, client_id, batch_id) DO NOTHING
                """
            ),
            {
                "workspace_id": workspace_id,
                "user_id": user_id,
                "client_id": client_id,
                "batch_id": batch_id,
                "idempotency_key": f"{workspace_id}:{client_id}:{batch_id}",
                "operation_count": len(details.get("applied", [])) + len(details.get("conflicts", [])),
                "status": status,
                "conflict_count": len(details.get("conflicts", [])),
                "request_hash": stable_payload_hash(details),
                "details": _dump(details),
            },
        )

    def list_sync_logs(self, workspace_id: int, page: int, page_size: int) -> tuple[list[dict[str, Any]], int]:
        offset = (page - 1) * page_size
        params = {"workspace_id": workspace_id, "limit": page_size, "offset": offset}
        total = int(self.session.execute(text("SELECT COUNT(*) FROM sync_logs WHERE workspace_id = :workspace_id"), params).scalar() or 0)
        rows = self.session.execute(
            text(
                """
                SELECT id, client_id, batch_id, operation_count, status, conflict_count, details, created_at
                FROM sync_logs
                WHERE workspace_id = :workspace_id
                ORDER BY created_at DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        ).fetchall()
        return [dict(row._mapping) for row in rows], total

    def bump_workspace_sync_version(self, workspace_id: int) -> int:
        row = self.session.execute(
            text(
                """
                UPDATE workspaces
                SET sync_version = sync_version + 1, updated_at = NOW()
                WHERE id = :workspace_id
                RETURNING sync_version
                """
            ),
            {"workspace_id": workspace_id},
        ).fetchone()
        return int(row._mapping["sync_version"]) if row else 0

    @staticmethod
    def _workspace(row) -> WorkspaceRecord:
        data = row._mapping
        return WorkspaceRecord(
            id=data["id"],
            tracking_id=data.get("tracking_id"),
            name=data["name"],
            description=data.get("description"),
            owner_user_id=data["owner_user_id"],
            local_fs_path=data.get("local_fs_path"),
            status=data["status"],
            sync_version=data["sync_version"],
            version=data["version"],
            active_session_id=data.get("active_session_id"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            last_accessed_at=data.get("last_accessed_at"),
            deleted_at=data.get("deleted_at"),
        )

    @staticmethod
    def _session(row) -> SessionRecord:
        data = row._mapping
        return SessionRecord(
            id=data["id"],
            workspace_id=data["workspace_id"],
            user_id=data["user_id"],
            session_name=data["session_name"],
            status=data["status"],
            is_active=bool(data.get("is_active")),
            context_snapshot=_json(data.get("context_snapshot")),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            last_accessed_at=data.get("last_accessed_at"),
        )
