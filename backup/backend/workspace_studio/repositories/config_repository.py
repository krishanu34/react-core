"""Configuration repository — strategy pattern for dual-mode config access."""

from __future__ import annotations

from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.orm import Session

from common_utils.integration.devaccel_client import DevAccelContext
from common_utils.integration.models import ConnectorBundle, ConnectorConfig, ModelConfig


class ConfigurationRepository(Protocol):
    """Provides AI models and connector configs regardless of source."""

    def get_models(self, user_id: int) -> list[ModelConfig]: ...
    def get_connectors(self, workspace_id: int) -> ConnectorBundle: ...


class DBConfigRepository:
    """Reads model/connector config from the Workspace Studio (devsphere) DB.

    In standalone mode, connectors are stored in the ``connectors`` table
    (scoped to workspace_id). AI model config is read from environment
    variables (no DB table), so this returns an empty list for models.
    """

    def __init__(self, session: Session) -> None:
        self._session = session

    def get_models(self, user_id: int) -> list[ModelConfig]:
        # Standalone mode: models come from env vars, not the DB.
        return []

    def get_connectors(self, workspace_id: int) -> ConnectorBundle:
        rows = self._session.execute(
            text(
                """
                SELECT connector_type, display_name, metadata, status
                FROM connectors
                WHERE workspace_id = :workspace_id AND status = 'active'
                """
            ),
            {"workspace_id": workspace_id},
        ).fetchall()

        bundle_data: dict[str, ConnectorConfig | None] = {"jira": None, "ado": None, "git": None}
        for row in rows:
            ctype = row[0]  # connector_type
            metadata: dict[str, Any] = row[2] if isinstance(row[2], dict) else {}
            if ctype in bundle_data:
                bundle_data[ctype] = ConnectorConfig(
                    connector_type=ctype,
                    base_url=metadata.get("base_url", ""),
                    auth_method=metadata.get("auth_method", "token"),
                    credentials=metadata.get("credentials", {}),
                )
        return ConnectorBundle(**bundle_data)


class DevAccelAPIConfigRepository:
    """Reads model/connector config from the cached DevAccel API response.

    In integrated mode, all configuration comes from DevAccel — the
    Workspace Studio DB is NOT queried for config data.
    """

    def __init__(self, context: DevAccelContext) -> None:
        self._context = context

    def get_models(self, user_id: int) -> list[ModelConfig]:
        return self._context.models

    def get_connectors(self, workspace_id: int) -> ConnectorBundle:
        return self._context.connectors
