"""Launch mode enum and per-request resolution for Workspace Studio."""

from __future__ import annotations

from enum import Enum
from typing import Any

from fastapi import Request


class LaunchMode(str, Enum):
    STANDALONE = "standalone"
    INTEGRATED = "integrated"


def resolve_launch_mode(request: Request) -> LaunchMode:
    """Determine the launch mode from the current request's auth context."""
    user: dict[str, Any] | None = getattr(request.state, "user", None)
    if user and user.get("launch_mode") == LaunchMode.INTEGRATED:
        return LaunchMode.INTEGRATED
    return LaunchMode.STANDALONE
