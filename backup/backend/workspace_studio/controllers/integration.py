"""Integration controller — DevAccel SSO handoff and context endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from common_utils.integration.devaccel_client import DevAccelClientError
from common_utils.integration.token_exchange import HandoffTokenError
from workspace_studio.security.auth import get_current_user
from workspace_studio.services.integration_service import integration_service


router = APIRouter(prefix="/api/integration", tags=["integration"])


# ── Request / Response schemas ──────────────────────────────────────────────


class HandoffRequest(BaseModel):
    handoff_token: str = Field(..., min_length=1)


class HandoffResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    launch_mode: str
    project_context: dict
    handoff_token_hash: str


class IntegrationStatusResponse(BaseModel):
    status: str
    devaccel_configured: bool


# ── Endpoints ───────────────────────────────────────────────────────────────


@router.post("/handoff", response_model=HandoffResponse)
async def handoff(body: HandoffRequest) -> HandoffResponse:
    """Exchange a DevAccel handoff token for a Workspace Studio session token.

    This endpoint is PUBLIC (no auth required) — it IS the auth entry point
    for integrated mode.
    """
    try:
        result = await integration_service.exchange_handoff_token(body.handoff_token)
    except HandoffTokenError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except DevAccelClientError as exc:
        status_map = {401: 403, 403: 403}
        status_code = status_map.get(exc.status_code, 502)
        detail_map = {
            401: "Insufficient permissions in DevAccel. Contact your admin.",
            403: "Insufficient permissions in DevAccel. Contact your admin.",
        }
        detail = detail_map.get(exc.status_code, "Unable to reach DevAccel. Try again or log in directly.")
        raise HTTPException(status_code=status_code, detail=detail)

    return HandoffResponse(**result)


@router.get("/context")
async def get_context(current_user: dict = Depends(get_current_user)) -> dict:
    """Return the cached DevAccel context for the current integrated session."""
    if current_user.get("launch_mode") != "integrated":
        raise HTTPException(status_code=400, detail="Not in integrated mode")

    nonce = current_user.get("nonce")
    if not nonce:
        raise HTTPException(status_code=400, detail="Session nonce not found")

    context = integration_service.get_cached_context(nonce)
    if context is None:
        raise HTTPException(
            status_code=410,
            detail="DevAccel session expired. Please relaunch from DevAccel.",
        )

    return {
        "auth_context": context.auth_context.model_dump(),
        "project_context": context.project_context.model_dump(),
        "models": [m.model_dump() for m in context.models],
        "connectors": context.connectors.model_dump(),
    }


@router.get("/status", response_model=IntegrationStatusResponse)
async def integration_status() -> IntegrationStatusResponse:
    """Health check for DevAccel integration configuration."""
    from workspace_studio.config.settings import get_settings

    settings = get_settings()
    configured = bool(settings.devaccel_api_url and settings.devaccel_public_key)
    return IntegrationStatusResponse(
        status="ok" if configured else "not_configured",
        devaccel_configured=configured,
    )
