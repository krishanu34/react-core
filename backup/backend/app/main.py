"""
DevSphere AI — unified backend entry point.

    uvicorn app.main:app --host 0.0.0.0 --port 8003

Composes the whole product on one FastAPI app with one identity:
  • /auth/*            login / logout / me  (mints the JWT)
  • /api/agent/*       the coding agent (SSE, Pattern C)  — JWT-authed
  • /chat/*            simple no-tools chat streaming
  • /api/workspaces/*  Workspace Studio (workspaces, sessions, sync, recovery) — JWT-authed
  • /api/daemon/*      local-daemon download/verify

The same JWT authenticates the agent stream AND the workspace APIs (see
``router.auth`` and ``workspace_studio.security.auth``).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make bare package imports (llm, router, workspace_studio, persistence, auth,
# common_utils, token_tracking, ...) resolve regardless of the launch cwd.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import time  # noqa: E402
import uuid  # noqa: E402

from fastapi import Request  # noqa: E402

# `router.apis` already builds the FastAPI app and mounts the agent router,
# Workspace Studio, and the /chat endpoints. Reuse it so no functionality is lost.
from router.apis import app  # noqa: E402
from auth.router import router as auth_router  # noqa: E402
from utils.logger import clear_context, ensure_logging, get_logger, set_context  # noqa: E402

app.title = "DevSphere AI"
app.description = "Standalone client-server AI coding assistant."
app.version = "1.0.0"

app.include_router(auth_router)

log = get_logger("devsphere.http")

# Endpoints hit by pollers (daemon status, health probes) — logging every one
# buries the interesting lines. They're still in app_debug.log.
_QUIET_PATHS = {"/health", "/api/workspaces/health", "/api/daemon/verify"}


@app.on_event("startup")
async def _init_logging() -> None:
    """Re-attach our handlers: uvicorn/gunicorn apply their own dictConfig
    after import time, which would otherwise drop our formatters."""
    ensure_logging()
    log.info("DevSphere AI backend ready", extra={"version": app.version})


@app.middleware("http")
async def _request_logging(request: Request, call_next):
    """One correlation id per request, attached to every log line it produces.

    Grep any id from a response's X-Correlation-ID header to get the complete
    server-side story of that request across the agent, tools and DB layers.
    """
    correlation_id = request.headers.get("X-Correlation-ID") or uuid.uuid4().hex[:12]
    set_context(correlation_id=correlation_id, route=request.url.path)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        log.exception(
            f"{request.method} {request.url.path} failed",
            extra={"duration_ms": round((time.perf_counter() - started) * 1000)},
        )
        clear_context()
        raise

    duration_ms = round((time.perf_counter() - started) * 1000)
    record = log.debug if request.url.path in _QUIET_PATHS else log.info
    record(
        f"{request.method} {request.url.path} → {response.status_code}",
        extra={"status": response.status_code, "duration_ms": duration_ms},
    )
    response.headers["X-Correlation-ID"] = correlation_id
    clear_context()
    return response


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "devsphere-ai"}
