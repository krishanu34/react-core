"""
Authentication & user identity for the agent API.

Every agent endpoint depends on ``get_current_user()``, which resolves the caller
to a stable user-id *string*. Thread/workspace ownership is built on top of it: a
workspace belongs to the user who created it, and no other user can see or control
it.

Standalone DevSphere uses ONE identity everywhere: the JWT minted by
``auth/router.py`` (``POST /auth/login``). This module verifies that same token —
via the shared secret in ``workspace_studio.config.settings`` — so the agent
stream and the workspace APIs authenticate identically.

``DEVSPHERE_AUTH_MODE`` still selects the mechanism, for flexibility:

  jwt       (default) Verify a JWT from ``Authorization: Bearer <token>`` or the
            ``auth_token`` cookie; the caller is ``str(payload["sub"])``.
  api_key   Legacy: ``Authorization: Bearer <key>`` / ``X-API-Key: <key>`` mapped
            via ``DEVSPHERE_API_KEYS="key1:alice,key2:bob"``.
  disabled  Local single-user dev only — every caller is ``LOCAL_USER_ID``.

Default: ``jwt`` when ``SECRET_KEY`` is set; else ``api_key`` when
``DEVSPHERE_API_KEYS`` is set; else ``disabled``.
"""

import hmac
import os
from typing import Dict, Optional

import jwt
from fastapi import HTTPException, Request

from workspace_studio.config.settings import get_settings

LOCAL_USER_ID = "local-user"


def _parse_api_keys(raw: str) -> Dict[str, str]:
    """Parse 'key1:alice,key2:bob' into {key: user_id}."""
    mapping: Dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        key, sep, user_id = pair.partition(":")
        key = key.strip()
        user_id = user_id.strip()
        if key and sep and user_id:
            mapping[key] = user_id
    return mapping


def _auth_mode() -> str:
    mode = os.getenv("DEVSPHERE_AUTH_MODE", "").strip().lower()
    if mode in ("jwt", "api_key", "disabled"):
        return mode
    if get_settings().secret_key:
        return "jwt"
    return "api_key" if os.getenv("DEVSPHERE_API_KEYS", "").strip() else "disabled"


def _lookup_user(presented_key: str) -> Optional[str]:
    keys = _parse_api_keys(os.getenv("DEVSPHERE_API_KEYS", ""))
    for key, user_id in keys.items():
        if hmac.compare_digest(key, presented_key):
            return user_id
    return None


def _extract_token(request: Request) -> Optional[str]:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    cookie_token = request.cookies.get("auth_token")
    if cookie_token:
        return cookie_token
    query_token = request.query_params.get("token")
    if query_token:
        return query_token
    return None


def _payload_from_jwt(token: str) -> Dict[str, object]:
    """Verify and decode. The ONE place this module decodes a token, so a role
    check and an identity check can never disagree about what a token says."""
    settings = get_settings()
    if not settings.secret_key:
        raise HTTPException(status_code=500, detail="Authentication service misconfigured")
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired", headers={"WWW-Authenticate": "Bearer"})
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token", headers={"WWW-Authenticate": "Bearer"})


def _user_id_from_jwt(token: str) -> str:
    sub = _payload_from_jwt(token).get("sub")
    if sub is None:
        raise HTTPException(status_code=401, detail="Invalid token", headers={"WWW-Authenticate": "Bearer"})
    return str(sub)


async def get_current_user(request: Request) -> str:
    """FastAPI dependency — resolves the caller to a user-id string or raises 401."""
    mode = _auth_mode()

    if mode == "disabled":
        return LOCAL_USER_ID

    token = _extract_token(request)

    if mode == "jwt":
        if not token:
            raise HTTPException(
                status_code=401,
                detail="Not authenticated",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return _user_id_from_jwt(token)

    # api_key mode
    presented = token or request.headers.get("x-api-key", "").strip() or None
    if not presented:
        raise HTTPException(
            status_code=401,
            detail="Missing credentials. Send 'Authorization: Bearer <api-key>' or 'X-API-Key: <api-key>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user_id = _lookup_user(presented)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid API key.", headers={"WWW-Authenticate": "Bearer"})
    return user_id


async def get_current_admin(request: Request) -> str:
    """FastAPI dependency for admin-only routes — the caller's id, or 403.

    Reads the token through this module's own ``_extract_token`` (Authorization
    header, then ``auth_token`` cookie, then ``?token=``), which is what every
    other agent route accepts.

    An earlier version delegated to ``workspace_studio.security.auth`` and
    passed ``credentials=None``. That dependency only falls back to the COOKIE
    when it gets no credentials object, so admin routes silently rejected every
    ``Authorization: Bearer`` request — they worked in a browser, where the
    cookie rides along, and 401'd for curl, the VS Code client and anything
    else. The role is read straight off the verified payload instead.

    In ``api_key`` and ``disabled`` modes there are no roles to check, so admin
    routes are refused rather than opened: silently granting admin because auth
    is switched off for local development is not a trade anyone chose.
    """
    mode = _auth_mode()
    if mode != "jwt":
        raise HTTPException(
            status_code=403,
            detail=(
                "Admin APIs require JWT authentication "
                f"(DEVSPHERE_AUTH_MODE is '{mode}')."
            ),
        )

    token = _extract_token(request)
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = _payload_from_jwt(token)
    if payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required.")

    sub = payload.get("sub")
    if sub is None:
        raise HTTPException(status_code=401, detail="Invalid token", headers={"WWW-Authenticate": "Bearer"})
    return str(sub)
