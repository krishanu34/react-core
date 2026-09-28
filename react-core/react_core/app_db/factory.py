"""AppDB singleton getter — swap the backend via `APP_DB_PROVIDER`."""
from __future__ import annotations

import os
import threading
from pathlib import Path

from .base import AppDBProtocol

_LOCK = threading.Lock()
_INSTANCE: AppDBProtocol | None = None


def get_app_db() -> AppDBProtocol:
    """Return the process-wide AppDB singleton, creating it if needed."""
    global _INSTANCE
    if _INSTANCE is not None:
        return _INSTANCE
    with _LOCK:
        if _INSTANCE is not None:
            return _INSTANCE
        _INSTANCE = _create_app_db()
        return _INSTANCE


def reset_app_db_for_tests(new_instance: AppDBProtocol | None = None) -> None:
    """Test helper — reset the singleton (do NOT call in production code)."""
    global _INSTANCE
    with _LOCK:
        if _INSTANCE is not None and new_instance is None:
            try:
                _INSTANCE.close()
            except Exception:  # noqa: BLE001
                pass
        _INSTANCE = new_instance


def _create_app_db() -> AppDBProtocol:
    provider = (os.getenv("APP_DB_PROVIDER") or "sqlite").strip().lower()
    if provider == "sqlite":
        from .sqlite_backend import SqliteAppDB
        state_dir = Path(os.getenv("REACT_CORE_STATE_DIR", "./.react-core")).resolve()
        db_path = state_dir / "app.sqlite"
        return SqliteAppDB(db_path)
    if provider == "postgres":  # future
        raise NotImplementedError("Postgres backend not implemented yet.")
    raise ValueError(f"Unknown APP_DB_PROVIDER: {provider!r}")
