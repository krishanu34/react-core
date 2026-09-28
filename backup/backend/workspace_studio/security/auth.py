"""JWT and cookie authentication dependencies for Workspace Studio."""

from __future__ import annotations

from typing import Any, Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from workspace_studio.config.settings import get_settings


_bearer = HTTPBearer(auto_error=False)

WORKSPACE_STUDIO_ROLE = "workspace_studio"
INTEGRATED_TOKEN_ISSUER = "devaccel"
PUBLIC_PATHS = {"/health", "/docs", "/openapi.json", "/redoc", "/api/integration/handoff"}
PUBLIC_PREFIXES = ("/docs", "/redoc")


def _decode_token(token: str) -> dict[str, Any]:
    """Decode a JWT token. Supports both local (HS256) and DevAccel (RS256) tokens."""
    settings = get_settings()
    # Try to peek at the header to determine algorithm
    try:
        unverified_header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError:
        # Fall through to local decode which will raise a proper error
        unverified_header = {}

    alg = unverified_header.get("alg", "")

    if alg == "RS256" and settings.devaccel_public_key:
        # DevAccel-issued token (integrated mode)
        payload = jwt.decode(
            token,
            settings.devaccel_public_key,
            algorithms=["RS256"],
            audience=settings.devaccel_token_audience,
        )
        # Mark as integrated so downstream code knows the mode
        payload.setdefault("launch_mode", "integrated")
        return payload

    # Local token (standalone mode)
    if not settings.secret_key:
        raise RuntimeError("SECRET_KEY environment variable is required for authentication")
    return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])


def _extract_request_token(request: Request) -> Optional[str]:
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


def _user_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": int(payload["sub"]),
        "username": payload.get("usr", ""),
        "role": payload.get("role", "user"),
        "roles": payload.get("rls", []),
        "is_admin": payload.get("role") == "admin",
        "launch_mode": payload.get("launch_mode", "standalone"),
        "devaccel_project_id": payload.get("project_id"),
    }


class JWTAuthMiddleware(BaseHTTPMiddleware):
    """Process-wide auth guard with the same bearer/cookie behavior as Code Builder."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if request.method == "OPTIONS" or request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)
        if path in PUBLIC_PATHS or any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES):
            return await call_next(request)

        token = _extract_request_token(request)
        if not token:
            return JSONResponse(
                status_code=401,
                content={"detail": "Not authenticated"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        try:
            request.state.user = _user_from_payload(_decode_token(token))
        except jwt.ExpiredSignatureError:
            return JSONResponse(
                status_code=401,
                content={"detail": "Token expired"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        except jwt.InvalidTokenError:
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        except RuntimeError:
            return JSONResponse(status_code=500, content={"detail": "Authentication service misconfigured"})

        return await call_next(request)


async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict[str, Any]:
    if getattr(request.state, "user", None):
        return request.state.user

    token = credentials.credentials if credentials and credentials.credentials else request.cookies.get("auth_token")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return _user_from_payload(_decode_token(token))
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_role(role_name: str):
    async def _check(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
        if current_user.get("is_admin") or role_name in current_user.get("roles", []):
            return current_user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Required role '{role_name}' not assigned")

    _check.__name__ = f"require_role_{role_name}"
    return _check
