"""Credential resolution for connectors.

Auth flow:
- Tokens live in App DB (`user_credentials`), keyed by (user_id, provider, base_url).
- The UI Settings modal writes rows via `PUT /api/settings/credentials`.
- Connectors accept an `AuthCredential`; they never touch the DB directly.

No env-var fallback for Jira / Confluence — the App DB is the sole source
of truth. If a credential is missing, tools return a structured
"not configured" error and prompt the user to open Settings.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..app_db import Credential, get_app_db


@dataclass(slots=True)
class AuthCredential:
    base_url: str
    token: str
    auth_type: str = "bearer"           # 'bearer' | 'basic' | 'pat'
    email: Optional[str] = None         # basic-auth username
    expires_at: Optional[str] = None
    refresh_token: Optional[str] = None


def resolve_auth(
    provider: str,
    *,
    user_id: str = "admin",
    base_url: Optional[str] = None,
) -> Optional[AuthCredential]:
    """Return an AuthCredential from the App DB, or `None` if none exists."""
    db = get_app_db()
    cred = db.get_credential(user_id, provider, base_url)
    if cred is None:
        return None
    return _cred_to_auth(cred)


def _cred_to_auth(c: Credential) -> AuthCredential:
    return AuthCredential(
        base_url=c.base_url,
        token=c.token,
        auth_type=c.auth_type,
        email=c.email,
        expires_at=c.expires_at,
        refresh_token=c.refresh_token,
    )
