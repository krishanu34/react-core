"""Workspace Studio router registration for the DevSphere AI FastAPI app."""

from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from common_utils.logging_config import get_logger
from workspace_studio.controllers import compatibility, health, recovery, sessions, sync, workspaces
from workspace_studio.models.exceptions import ConflictError, DuplicateError, NotFoundError, ValidationError


log = get_logger(__name__)


async def _not_found_handler(_request: Request, exc: NotFoundError):
    return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": str(exc)})


async def _conflict_handler(_request: Request, exc: ConflictError):
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc)})


async def _duplicate_handler(_request: Request, exc: DuplicateError):
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc)})


async def _validation_handler(_request: Request, exc: ValidationError):
    return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"detail": str(exc)})


def register_workspace_studio(app: FastAPI) -> None:
    """Mount Workspace Studio APIs on the existing DevSphere app.

    Auth remains route-level through `require_role("workspace_studio")`; this
    avoids changing the behavior of DevSphere's public agent streaming routes.
    """
    if getattr(app.state, "workspace_studio_registered", False):
        return

    app.add_exception_handler(NotFoundError, _not_found_handler)
    app.add_exception_handler(ConflictError, _conflict_handler)
    app.add_exception_handler(DuplicateError, _duplicate_handler)
    app.add_exception_handler(ValidationError, _validation_handler)

    app.include_router(health.router)
    app.include_router(workspaces.router)
    app.include_router(sessions.router)
    app.include_router(recovery.router)
    app.include_router(sync.router)
    app.include_router(compatibility.router)

    # DevAccel integration (SSO handoff, context fetch)
    from workspace_studio.controllers import integration as _integration
    app.include_router(_integration.router)

    # Register the local-daemon support router DEFENSIVELY: it's an optional
    # feature (download link + session verify), and a failure here (e.g. a
    # missing/undeployed module) must never take down agent streaming / the rest
    # of this app. Degrade to "daemon endpoints unavailable" instead of crashing.
    try:
        from workspace_studio.controllers import daemon as _daemon

        app.include_router(_daemon.router)
    except Exception as exc:  # noqa: BLE001 — never let the daemon feature crash the app
        log.warning("daemon_router_registration_failed", error=str(exc))

    # No schema work at startup: db/migrations/001_init.sql owns the schema and
    # is applied out-of-band (postgres init hook / psql). The app role is not
    # expected to hold DDL rights.
    @app.on_event("startup")
    async def _workspace_studio_startup() -> None:
        log.info("workspace_studio_starting", builder_module="workspace_studio")

    app.state.workspace_studio_registered = True
