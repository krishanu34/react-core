"""FastAPI entrypoint for Workspace Studio."""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
for candidate in (REPO_ROOT, SCRIPT_DIR):
    text = str(candidate)
    if text not in sys.path:
        sys.path.insert(0, text)

import uvicorn
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from common_utils.logging_config import ensure_logging, get_logger, setup_logging
from workspace_studio.config.settings import get_settings
from workspace_studio.controllers import compatibility, health, recovery, sessions, sync, workspaces
from workspace_studio.models.exceptions import ConflictError, DuplicateError, NotFoundError, ValidationError
from workspace_studio.security.auth import JWTAuthMiddleware


setup_logging()
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_logging()
    log.info("workspace_studio_starting", builder_module="workspace-studio")
    # Schema is owned by db/migrations/001_init.sql, applied out-of-band.
    yield
    log.info("workspace_studio_stopping", builder_module="workspace-studio")


settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    description="Authoritative workspace state, file sync, recovery, and session APIs for DevAccel Workspace Studio.",
    version=settings.app_version,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(JWTAuthMiddleware)


@app.exception_handler(NotFoundError)
async def not_found_handler(_request: Request, exc: NotFoundError):
    return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": str(exc)})


@app.exception_handler(ConflictError)
async def conflict_handler(_request: Request, exc: ConflictError):
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc)})


@app.exception_handler(DuplicateError)
async def duplicate_handler(_request: Request, exc: DuplicateError):
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc)})


@app.exception_handler(ValidationError)
async def validation_handler(_request: Request, exc: ValidationError):
    return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"detail": str(exc)})


app.include_router(health.router)
app.include_router(workspaces.router)
app.include_router(sessions.router)
app.include_router(recovery.router)
app.include_router(sync.router)
app.include_router(compatibility.router)

# DevAccel integration (SSO handoff, context fetch)
from workspace_studio.controllers import integration as _integration  # noqa: E402
app.include_router(_integration.router)


if __name__ == "__main__":
    uvicorn.run(
        "workspace_studio.main:app",
        host=os.getenv("WORKSPACE_STUDIO_HOST", settings.api_host),
        port=int(os.getenv("WORKSPACE_STUDIO_PORT", str(settings.api_port))),
        reload=os.getenv("WORKSPACE_STUDIO_RELOAD", "false").lower() == "true",
    )
