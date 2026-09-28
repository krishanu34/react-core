"""Secure SSO token exchange — validates DevAccel handoff tokens."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import jwt


class HandoffTokenError(Exception):
    """Raised when a handoff token is invalid or expired."""

    def __init__(self, detail: str, *, status_code: int = 401) -> None:
        self.detail = detail
        self.status_code = status_code
        super().__init__(detail)


@dataclass(slots=True)
class HandoffClaims:
    """Decoded claims from a valid DevAccel handoff token."""

    user_id: int
    project_id: int
    roles: list[str]
    nonce: str
    issued_at: int
    expires_at: int


# In-memory nonce store to prevent token replay.
# Key: nonce string, Value: expiry timestamp.
# In production, replace with Redis for multi-instance deployments.
_used_nonces: dict[str, float] = {}
_NONCE_TTL_SECONDS = 60


def _cleanup_expired_nonces() -> None:
    """Remove expired nonces from the in-memory store."""
    now = time.time()
    expired = [k for k, v in _used_nonces.items() if v < now]
    for k in expired:
        del _used_nonces[k]


def validate_handoff_token(
    token: str,
    *,
    public_key: str,
    audience: str,
    max_age_seconds: int = 300,
) -> HandoffClaims:
    """Validate a DevAccel handoff token and return its claims.

    Parameters
    ----------
    token : str
        The raw JWT string from DevAccel.
    public_key : str
        PEM-encoded RS256 public key for signature verification.
    audience : str
        Expected ``aud`` claim (e.g. ``"workspace-studio"``).
    max_age_seconds : int
        Maximum token age in seconds.

    Raises
    ------
    HandoffTokenError
        If the token is invalid, expired, replayed, or has wrong audience.
    """
    if not public_key:
        raise HandoffTokenError("DevAccel public key is not configured", status_code=500)

    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=audience,
            options={"require": ["exp", "iat", "sub", "aud", "nonce", "project_id"]},
        )
    except jwt.ExpiredSignatureError:
        raise HandoffTokenError("Handoff token has expired. Return to DevAccel to relaunch.")
    except jwt.InvalidAudienceError:
        raise HandoffTokenError("Handoff token has invalid audience.")
    except jwt.InvalidTokenError as exc:
        raise HandoffTokenError(f"Invalid handoff token: {exc}")

    # Check max age
    iat = int(payload.get("iat", 0))
    if time.time() - iat > max_age_seconds:
        raise HandoffTokenError("Handoff token is too old. Return to DevAccel to relaunch.")

    # Nonce replay protection
    nonce = payload.get("nonce", "")
    if not nonce:
        raise HandoffTokenError("Handoff token missing nonce.")

    _cleanup_expired_nonces()
    if nonce in _used_nonces:
        raise HandoffTokenError(
            "This launch link has already been used. Return to DevAccel.",
            status_code=409,
        )
    _used_nonces[nonce] = time.time() + _NONCE_TTL_SECONDS

    return HandoffClaims(
        user_id=int(payload["sub"]),
        project_id=int(payload["project_id"]),
        roles=payload.get("roles", []),
        nonce=nonce,
        issued_at=iat,
        expires_at=int(payload.get("exp", 0)),
    )
