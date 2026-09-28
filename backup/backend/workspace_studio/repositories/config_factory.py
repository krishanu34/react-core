"""Factory for selecting the correct ConfigurationRepository based on launch mode."""

from __future__ import annotations

from sqlalchemy.orm import Session

from common_utils.integration.devaccel_client import DevAccelContext
from workspace_studio.config.launch_mode import LaunchMode
from workspace_studio.repositories.config_repository import (
    ConfigurationRepository,
    DBConfigRepository,
    DevAccelAPIConfigRepository,
)


def get_config_repository(
    launch_mode: LaunchMode,
    db_session: Session | None = None,
    devaccel_context: DevAccelContext | None = None,
) -> ConfigurationRepository:
    """Return the correct config repository based on the current launch mode."""
    if launch_mode == LaunchMode.INTEGRATED:
        if devaccel_context is None:
            raise RuntimeError("DevAccel context required for integrated mode")
        return DevAccelAPIConfigRepository(devaccel_context)
    if db_session is None:
        raise RuntimeError("DB session required for standalone mode")
    return DBConfigRepository(db_session)
