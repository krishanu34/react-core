"""Structured audit logging for workspace operations."""

from __future__ import annotations

from typing import Any

from common_utils.logging_config import get_logger


log = get_logger(__name__)


class AuditService:
    def record(self, event: str, *, workspace_id: int | None, user_id: int | None, launch_mode: str = "standalone", **details: Any) -> None:
        log.info(
            event,
            builder_module="workspace-studio",
            workspace_id=workspace_id,
            user_id=user_id,
            launch_mode=launch_mode,
            **details,
        )


audit_service = AuditService()

