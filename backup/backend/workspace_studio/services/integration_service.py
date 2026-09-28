"""Integration service — orchestrates the DevAccel SSO handoff flow."""

from __future__ import annotations

import hashlib
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from common_utils.integration.devaccel_client import DevAccelClient, DevAccelClientError, DevAccelContext
from common_utils.integration.token_exchange import HandoffClaims, HandoffTokenError, validate_handoff_token
from workspace_studio.config.settings import get_settings


# In-memory context cache keyed by session nonce.
# In production, use Redis for multi-instance deployments.
_context_cache: dict[str, tuple[DevAccelContext, float]] = {}
_CONTEXT_TTL_SECONDS = 3600  # 1 hour


class IntegrationService:
    """Handles the DevAccel → Workspace Studio integration flow."""

    def __init__(self) -> None:
        self._settings = get_settings()

    async def exchange_handoff_token(self, handoff_token: str) -> dict[str, Any]:
        """Validate a DevAccel handoff token, fetch context, and mint a local session JWT.

        Returns
        -------
        dict with keys: access_token, token_type, launch_mode, project_context
        """
        # 1. Validate the handoff token
        claims = validate_handoff_token(
            handoff_token,
            public_key=self._settings.devaccel_public_key,
            audience=self._settings.devaccel_token_audience,
            max_age_seconds=self._settings.devaccel_handoff_token_ttl_seconds,
        )

        # 2. Fetch context from DevAccel API
        client = DevAccelClient(self._settings.devaccel_api_url)
        context = await client.fetch_context(handoff_token)

        # 3. Cache context for the session
        _context_cache[claims.nonce] = (context, time.time() + _CONTEXT_TTL_SECONDS)
        self._cleanup_expired_contexts()

        # 4. Mint a local WS session token
        access_token = self._mint_session_token(claims, context)

        return {
            "access_token": access_token,
            "token_type": "bearer",
            "launch_mode": "integrated",
            "project_context": {
                "project_id": context.project_context.project_id,
                "project_name": context.project_context.project_name,
            },
            "handoff_token_hash": hashlib.sha256(handoff_token.encode()).hexdigest(),
        }

    def get_cached_context(self, nonce: str) -> DevAccelContext | None:
        """Return the cached DevAccel context for a given session nonce."""
        entry = _context_cache.get(nonce)
        if entry is None:
            return None
        context, expiry = entry
        if time.time() > expiry:
            del _context_cache[nonce]
            return None
        return context

    def _mint_session_token(self, claims: HandoffClaims, context: DevAccelContext) -> str:
        """Create a WS-internal JWT for the integrated session."""
        now = datetime.now(timezone.utc)
        # Include workspace_studio role since the user already passed the handoff gate
        roles = list(context.auth_context.roles)
        if "workspace_studio" not in roles:
            roles.append("workspace_studio")
        payload = {
            "sub": str(claims.user_id),
            "usr": context.auth_context.username,
            "role": "user",
            "rls": roles,
            "launch_mode": "integrated",
            "project_id": claims.project_id,
            "nonce": claims.nonce,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(hours=8)).timestamp()),
        }
        return jwt.encode(payload, self._settings.secret_key, algorithm=self._settings.jwt_algorithm)

    def _cleanup_expired_contexts(self) -> None:
        """Remove expired entries from the context cache."""
        now = time.time()
        expired = [k for k, (_, exp) in _context_cache.items() if exp < now]
        for k in expired:
            del _context_cache[k]


# Module-level singleton
integration_service = IntegrationService()
