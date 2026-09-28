"""
common_utils/logging_config.py
═══════════════════════════════════════════════════════════════════════════════
Structured-logging adapter over the ONE backend logging config, `utils.logger`.

Why this file is thin
---------------------
This module used to be a second, independent logging stack inherited from the
DevAccel monorepo: its own formatters, its own per-module rotating files under a
different directory, and a ``setup_logging()`` that called ``root.handlers.clear()``.
With ``utils/logger.py`` also configuring the root logger, which stack you got
depended on which entry point started the process — so the same event was
formatted two different ways, or written to files nobody was tailing.

There is now one configuration (``utils.logger``) and one set of files
(``logs/app.log``, ``app_debug.log``, ``errors.log``). This module keeps the
ergonomic keyword API that Workspace Studio and ``common_utils`` already use::

    from common_utils.logging_config import get_logger
    log = get_logger(__name__)
    log.info("workspace_created", workspace_id=42, owner="ada")

…and routes it into that single config. Secret masking, the context fields, and
the console/JSON formats all live in ``utils/logger.py``.

Context tracking
~~~~~~~~~~~~~~~~
    from common_utils.logging_config import set_context, clear_context

    set_context(correlation_id="r-001", user_id=5, workspace_id=42)
    log.info("file_generated", path="src/main.py")   # context auto-attached
    clear_context()

Context is stored in a ContextVar (async-safe, per request), not a thread-local.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict

from utils.logger import (  # re-exported: one implementation, one behaviour
    CONTEXT_KEYS,
    LOG_DIR as _LOG_DIR_STR,
    clear_context,
    ensure_logging,
    get_context,
    set_context,
    setup_logging as _setup_logging,
)

LOG_DIR = Path(_LOG_DIR_STR)

__all__ = [
    "CONTEXT_KEYS",
    "LOG_DIR",
    "DevSphereLogger",
    "clear_context",
    "ensure_logging",
    "get_context",
    "get_logger",
    "set_context",
    "setup_logging",
]


def setup_logging(**kwargs: Any) -> None:
    """Configure logging for the process (delegates to ``utils.logger``).

    Accepts and ignores the legacy keyword arguments (``log_format``,
    ``enable_file``, ``enable_console``, ``log_dir``) so old call sites keep
    working; ``log_level`` is honoured, otherwise ``LOG_LEVEL`` from the
    environment. Idempotent.
    """
    _setup_logging(kwargs.get("log_level"))


# LogRecord attributes a caller must not overwrite — collisions are prefixed.
_RESERVED = frozenset({
    "name", "msg", "args", "levelname", "levelno",
    "pathname", "filename", "module", "lineno",
    "funcName", "created", "msecs", "relativeCreated",
    "thread", "threadName", "process", "processName",
    "exc_info", "exc_text", "stack_info", "message",
    "taskName",
})


class DevSphereLogger:
    """
    Thin wrapper around ``logging.Logger`` that turns keyword arguments into
    structured log fields.

    Usage::

        from common_utils.logging_config import get_logger
        log = get_logger(__name__)
        log.info("generation_started", project_id=42)
    """

    __slots__ = ("_logger",)

    def __init__(self, name: str) -> None:
        _setup_logging()          # no-op after the first call
        self._logger = logging.getLogger(name)

    # ── Level helpers ─────────────────────────────────────────────────

    def debug(self, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(logging.DEBUG, msg, args, kw)

    def info(self, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(logging.INFO, msg, args, kw)

    def warning(self, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(logging.WARNING, msg, args, kw)

    def error(self, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(logging.ERROR, msg, args, kw)

    def critical(self, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(logging.CRITICAL, msg, args, kw)

    def exception(self, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(logging.ERROR, msg, args, kw, default_exc_info=True)

    # ── Passthrough for code that treats this as a stdlib logger ──────

    def log(self, level: int, msg: str, *args: Any, **kw: Any) -> None:
        self._emit(level, msg, args, kw)

    def isEnabledFor(self, level: int) -> bool:
        return self._logger.isEnabledFor(level)

    def setLevel(self, level: int | str) -> None:
        self._logger.setLevel(level)

    # ── Core ──────────────────────────────────────────────────────────

    def _emit(
        self,
        level: int,
        msg: str,
        args: tuple,
        extra_kw: Dict[str, Any],
        default_exc_info: Any = False,
    ) -> None:
        if not self._logger.isEnabledFor(level):
            return
        exc_info = extra_kw.pop("exc_info", default_exc_info)
        stack_info = extra_kw.pop("stack_info", False)
        # 3 frames up: caller -> level helper -> _emit.
        stacklevel = extra_kw.pop("stacklevel", 3)
        explicit_extra = extra_kw.pop("extra", None)

        fields: Dict[str, Any] = {}
        if isinstance(explicit_extra, dict):
            fields.update(explicit_extra)
        elif explicit_extra is not None:
            fields["extra"] = explicit_extra
        fields.update(extra_kw)

        # Prevent collisions with LogRecord reserved attrs by prefixing.
        safe = {(f"ctx_{k}" if k in _RESERVED else k): v for k, v in fields.items()}

        self._logger.log(
            level,
            msg,
            *args,
            exc_info=exc_info,
            extra=safe,
            stack_info=stack_info,
            stacklevel=stacklevel,
        )


# Legacy alias — the class was called DevAccelLogger in the monorepo.
DevAccelLogger = DevSphereLogger


def get_logger(name: str) -> DevSphereLogger:
    """
    Return a ``DevSphereLogger`` for *name*.

    Automatically inherits the root logging config from ``utils.logger``.
    """
    return DevSphereLogger(name)
