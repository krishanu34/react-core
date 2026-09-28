"""Centralized error sanitization for user-facing SSE / chat responses.

Rules:
  * Raw provider / framework exceptions (RateLimitError, APITimeoutError,
    OpenAI HTTP 429 / 5xx wrappers, agent retry exhaustion, asyncio
    timeouts, etc.) must never reach the UI verbatim.
  * Every classified exception is logged via the caller's logger with
    full ``exc_info`` so operators can debug from server logs.
  * The chat surface only receives a short, professional fallback
    message keyed by category.

Public API:
  - ``classify_exception(exc) -> Category``
  - ``friendly_message(exc, *, phase=None) -> str``
  - ``sanitize_error_payload(exc, *, phase=None, extra=None) -> dict``
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger(__name__)

# ── Category constants ─────────────────────────────────────────────
RATE_LIMIT = "rate_limit"
TIMEOUT = "timeout"
UPSTREAM = "upstream"
CANCELLED = "cancelled"
AUTH = "auth"
NOT_FOUND = "not_found"
VALIDATION = "validation"
INTERNAL = "internal"

_FRIENDLY: dict[str, str] = {
    RATE_LIMIT: (
        "We are currently experiencing high request volume. "
        "Please try again after a few moments."
    ),
    TIMEOUT: (
        "The request is taking longer than expected. "
        "Please retry shortly."
    ),
    UPSTREAM: (
        "The request could not be completed at the moment due to a "
        "temporary service issue. Please retry shortly."
    ),
    CANCELLED: "The run was cancelled.",
    AUTH: (
        "The service is not configured correctly. "
        "Please contact your administrator."
    ),
    NOT_FOUND: "The requested resource was not found.",
    VALIDATION: (
        "We could not process the request. "
        "Please review the inputs and try again."
    ),
    INTERNAL: (
        "Something went wrong while processing the request. "
        "Please try again shortly."
    ),
}

_RATE_LIMIT_MARKERS = ("rate limit", "ratelimit", "429", "too many requests", "quota")
_TIMEOUT_MARKERS = ("timeout", "timed out", "deadline exceeded")
_UPSTREAM_MARKERS = (
    "server had an error", "server_error", "internal server error",
    "bad gateway", "service unavailable", "gateway timeout",
    "500", "502", "503", "504",
    "connection reset", "connection aborted", "connection refused",
    "temporarily unavailable", "upstream",
    "apierror", "apiconnection", "serviceexception",
)
_AUTH_MARKERS = (
    "unauthorized", "401", "403", "forbidden", "invalid api key",
    "authentication", "credentials",
)
_NOT_FOUND_MARKERS = ("not found", "404")


def classify_exception(exc: BaseException) -> str:
    """Map a raw exception to a coarse user-facing category."""
    if isinstance(exc, asyncio.CancelledError):
        return CANCELLED
    if isinstance(exc, asyncio.TimeoutError):
        return TIMEOUT
    if isinstance(exc, (ConnectionError, ConnectionResetError, ConnectionAbortedError)):
        return UPSTREAM

    cls_name = type(exc).__name__.lower()
    msg = str(exc).lower()

    if "ratelimit" in cls_name or any(m in msg for m in _RATE_LIMIT_MARKERS):
        return RATE_LIMIT
    if "timeout" in cls_name or any(m in msg for m in _TIMEOUT_MARKERS):
        return TIMEOUT
    if any(m in cls_name for m in ("apierror", "apiconnection", "serviceexception")):
        return UPSTREAM
    if any(m in msg for m in _UPSTREAM_MARKERS):
        return UPSTREAM
    if any(m in msg for m in _AUTH_MARKERS):
        return AUTH
    if any(m in msg for m in _NOT_FOUND_MARKERS):
        return NOT_FOUND
    if isinstance(exc, (ValueError, TypeError, KeyError)):
        return VALIDATION
    return INTERNAL


def friendly_message(exc: BaseException, *, phase: str | None = None) -> str:
    """Return a short user-facing message. The raw exception is NOT included."""
    category = classify_exception(exc)
    return _FRIENDLY.get(category, _FRIENDLY[INTERNAL])


def sanitize_error_payload(
    exc: BaseException,
    *,
    phase: str | None = None,
    extra: dict[str, Any] | None = None,
    logger: logging.Logger | None = None,
    log_prefix: str = "sanitized_error",
) -> dict[str, Any]:
    """Build an SSE-safe error payload + log the raw exception internally.

    The returned dict intentionally omits any provider error text,
    stack traces, request IDs, or rate-limit headers.
    """
    category = classify_exception(exc)
    message = _FRIENDLY.get(category, _FRIENDLY[INTERNAL])
    _logger = logger or log
    try:
        _logger.error(
            "%s phase=%s category=%s exc_type=%s: %s",
            log_prefix, phase, category, type(exc).__name__, exc,
            exc_info=True,
        )
    except Exception:  # noqa: BLE001 — never let logging crash the pipeline
        pass
    payload: dict[str, Any] = {
        "category": category,
        "message": message,
    }
    if phase:
        payload["phase"] = phase
    if extra:
        # Allow callers to add safe identifiers (task_id, file_path) but
        # never override the sanitized message/category.
        for k, v in extra.items():
            if k in ("message", "category"):
                continue
            payload[k] = v
    return payload


__all__ = [
    "RATE_LIMIT", "TIMEOUT", "UPSTREAM", "CANCELLED",
    "AUTH", "NOT_FOUND", "VALIDATION", "INTERNAL",
    "classify_exception", "friendly_message", "sanitize_error_payload",
]
