"""
Core Logging System — the ONE logging configuration for the whole backend.

Every module logs through this: the agent (`utils.logger.get_logger`) and
Workspace Studio / common_utils (`common_utils.logging_config.get_logger`, a thin
adapter over this module). One root config, one format, one set of files.

Two outputs for every log message:
  1. Console — colored, human-readable, for development
  2. File — structured JSON lines, for dashboard/analysis

Log files (under backend/logs/, override with LOG_DIR):
  logs/app.log        — all application logs (INFO+), rotates at 10MB
  logs/app_debug.log  — debug-level logs, rotates at 50MB
  logs/errors.log     — ERROR+ only, for quick issue scanning

Every log entry includes:
  - timestamp (ISO 8601 with milliseconds)
  - level (DEBUG/INFO/WARNING/ERROR/CRITICAL)
  - module name (which .py file)
  - function name
  - line number
  - message
  - context (correlation_id / user_id / workspace_id / thread_id, when set)
  - extra fields (model, tokens, duration_ms, ...)

Secrets (API keys, bearer tokens, passwords) are masked in BOTH outputs.

Environment:
  LOG_LEVEL   DEBUG|INFO|WARNING|ERROR   console verbosity (default INFO)
  LOG_DIR     directory for the log files (default backend/logs)

Usage:
    from utils.logger import get_logger
    log = get_logger(__name__)
    log.info("Processing request", extra={"thread_id": "abc123"})
"""

import contextvars
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from typing import Any, Dict

# Log directory — backend/logs by default, overridable for containers.
LOG_DIR = os.getenv("LOG_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs"
)
os.makedirs(LOG_DIR, exist_ok=True)

_SETUP_DONE = False

# Handlers we own, so ensure_logging() can re-attach them if a third party
# (uvicorn/gunicorn dictConfig) resets the root logger after us.
_OUR_HANDLERS: list[logging.Handler] = []


# ── Request context ─────────────────────────────────────────────────────────
# ContextVar, not threading.local: the server is async, so a thread is shared by
# many concurrent requests and a thread-local would leak one request's ids into
# another's log lines. ContextVars are per-task.

CONTEXT_KEYS = (
    "correlation_id",
    "user_id",
    "workspace_id",
    "thread_id",
    "route",
    "action",
)

_ctx: contextvars.ContextVar[Dict[str, Any]] = contextvars.ContextVar(
    "devsphere_log_context", default={}
)


def set_context(**kwargs: Any) -> None:
    """Attach ids to every log line emitted from here on in this task.

    Example:
        set_context(correlation_id=req_id, user_id=42, thread_id=tid)
    """
    merged = dict(_ctx.get())
    merged.update({k: v for k, v in kwargs.items() if k in CONTEXT_KEYS})
    _ctx.set(merged)


def get_context() -> Dict[str, Any]:
    """Snapshot of the current logging context."""
    return dict(_ctx.get())


def clear_context() -> None:
    """Drop all context fields (call at the end of a request/run)."""
    _ctx.set({})


# ── Secret masking ──────────────────────────────────────────────────────────

_SECRET_PATTERNS = (
    (re.compile(r"sk-ant-[A-Za-z0-9\-_]{16,}"), "sk-ant-***"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "sk-***"),
    (re.compile(r"(?i)Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"), "Bearer ***"),
    (re.compile(r"(?i)(\"?(?:password|api[_-]?key|secret|token)\"?\s*[:=]\s*)\"?[^\s\",}]+\"?"), r"\1***"),
)

# Values of keys containing these words are masked wholesale.
_SECRET_KEY_PARTS = ("password", "secret", "token", "api_key", "apikey", "credential")


def _mask(value: str) -> str:
    for pattern, replacement in _SECRET_PATTERNS:
        value = pattern.sub(replacement, value)
    return value


def _mask_for_key(key: str, value: Any) -> Any:
    if isinstance(value, str):
        lowered = key.lower()
        if any(part in lowered for part in _SECRET_KEY_PARTS):
            return "***"
        return _mask(value)
    return value


# Internal LogRecord attributes — never rendered as "extra".
_RECORD_BUILTINS = frozenset({
    "name", "msg", "args", "created", "relativeCreated",
    "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "module", "filename", "pathname", "levelname", "levelno",
    "processName", "process", "threadName", "thread",
    "msecs", "message", "taskName",
})

# Rendered first on the console line, in this order, when present.
_PRIORITY_KEYS = (
    "correlation_id", "user_id", "workspace_id", "thread_id",
    "route", "action", "tool", "model", "tokens", "duration_ms",
)


class _ContextFilter(logging.Filter):
    """Copy the current context onto every record (unless already set)."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key, value in _ctx.get().items():
            if not hasattr(record, key):
                setattr(record, key, value)
        return True


def _collect_extras(record: logging.LogRecord) -> Dict[str, Any]:
    """Non-builtin fields the caller attached via extra={...} or context."""
    return {
        k: v
        for k, v in record.__dict__.items()
        if k not in _RECORD_BUILTINS and not k.startswith("_")
    }


class JsonFormatter(logging.Formatter):
    """
    Formats log records as JSON lines — one JSON object per line.
    This is what the dashboard will consume. Every field is
    machine-parseable, no regex needed.
    """

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
            "logger": record.name,
            "message": _mask(record.getMessage()),
        }

        # Include any extra fields passed via log.info("msg", extra={...})
        for key, value in _collect_extras(record).items():
            masked = _mask_for_key(key, value)
            try:
                json.dumps(masked)
                entry[key] = masked
            except (TypeError, ValueError):
                entry[key] = str(masked)

        # Include exception info if present
        if record.exc_info and record.exc_info[0] is not None:
            entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(entry, ensure_ascii=False, default=str)


class ConsoleFormatter(logging.Formatter):
    """
    Colored, human-readable console output for development.
    Format: 2024-01-15 10:30:45 | INFO | orchestrator.py:42 | _classify | Message
    Any extra/context fields are appended as [key=value, ...].
    """

    COLORS = {
        "DEBUG": "\033[36m",     # Cyan
        "INFO": "\033[32m",      # Green
        "WARNING": "\033[33m",   # Yellow
        "ERROR": "\033[31m",     # Red
        "CRITICAL": "\033[35m",  # Magenta
    }
    DIM = "\033[2m"
    RESET = "\033[0m"

    # Long values (SQL dumps, stack strings) make the console unreadable.
    _MAX_VALUE_LEN = 160

    def format(self, record: logging.LogRecord) -> str:
        color = self.COLORS.get(record.levelname, "")
        ts = datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S")

        base = (
            f"{ts} | {color}{record.levelname:8s}{self.RESET} | "
            f"{record.module}.py:{record.lineno} | {record.funcName} | "
            f"{_mask(record.getMessage())}"
        )

        # Append context + extras: priority keys first, then the rest sorted, so
        # the same fields always land in the same place across log lines.
        extras = _collect_extras(record)
        ordered = [k for k in _PRIORITY_KEYS if k in extras]
        ordered += sorted(k for k in extras if k not in _PRIORITY_KEYS)

        rendered = []
        for key in ordered:
            value = str(_mask_for_key(key, extras[key]))
            if len(value) > self._MAX_VALUE_LEN:
                value = value[: self._MAX_VALUE_LEN - 3] + "..."
            rendered.append(f"{key}={value}")
        if rendered:
            base += f" {self.DIM}[{', '.join(rendered)}]{self.RESET}"

        if record.exc_info and record.exc_info[0] is not None:
            base += "\n" + self.formatException(record.exc_info)

        return base


def setup_logging(level: str | None = None):
    """
    Configure the root logger with console + file handlers.
    Call this ONCE at server startup (app/main.py imports router.apis, which does).

    Safe to call multiple times — only configures on first call.
    `level` defaults to the LOG_LEVEL env var, then INFO.
    """
    global _SETUP_DONE
    if _SETUP_DONE:
        return
    _SETUP_DONE = True

    console_level = getattr(
        logging, (level or os.getenv("LOG_LEVEL") or "INFO").upper(), logging.INFO
    )

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    context_filter = _ContextFilter()

    # ── Console handler (human-readable) ─────────────────────
    # errors="replace": the formatter emits box/arrow glyphs and user paths;
    # a cp1252 Windows console would otherwise raise on write.
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    console = logging.StreamHandler(sys.stdout)
    console.setLevel(console_level)
    console.setFormatter(ConsoleFormatter())
    console.name = "devsphere_console"

    # ── JSON file handler: app.log (INFO+, 10MB rotate, keep 5) ──
    app_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "app.log"),
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    app_handler.setLevel(logging.INFO)
    app_handler.setFormatter(JsonFormatter())
    app_handler.name = "devsphere_app_file"

    # ── JSON file handler: debug.log (DEBUG+, 50MB rotate, keep 3) ──
    debug_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "app_debug.log"),
        maxBytes=50 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    debug_handler.setLevel(logging.DEBUG)
    debug_handler.setFormatter(JsonFormatter())
    debug_handler.name = "devsphere_debug_file"

    # ── JSON file handler: errors.log (ERROR+, 10MB rotate, keep 10) ──
    error_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "errors.log"),
        maxBytes=10 * 1024 * 1024,
        backupCount=10,
        encoding="utf-8",
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(JsonFormatter())
    error_handler.name = "devsphere_error_file"

    for handler in (console, app_handler, debug_handler, error_handler):
        handler.addFilter(context_filter)
        root.addHandler(handler)
        _OUR_HANDLERS.append(handler)

    # Suppress noisy third-party loggers
    for name in (
        "httpx", "httpcore", "openai", "urllib3", "asyncio",
        "sqlalchemy.engine", "uvicorn.access", "agent_framework",
    ):
        logging.getLogger(name).setLevel(logging.WARNING)

    logging.getLogger(__name__).info(
        "Logging initialised",
        extra={"level": logging.getLevelName(console_level), "log_dir": LOG_DIR},
    )


def ensure_logging() -> None:
    """
    Re-attach our handlers if something removed them.

    uvicorn/gunicorn apply their own dictConfig on startup, which can reset the
    root logger and silently drop our formatters. Call this from a FastAPI
    startup event. Safe to call repeatedly.
    """
    setup_logging()
    root = logging.getLogger()
    for handler in _OUR_HANDLERS:
        if handler not in root.handlers:
            root.addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    """
    Get a named logger. Call setup_logging() first if not done.

    Usage:
        from utils.logger import get_logger
        log = get_logger(__name__)
        log.info("Something happened", extra={"thread_id": "abc"})
    """
    if not _SETUP_DONE:
        setup_logging()
    return logging.getLogger(name)
