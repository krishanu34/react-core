"""Password hashing, credential verification, and JWT issuance.

Issues the exact token shape the rest of the app already verifies
(``workspace_studio.security.auth`` and ``router.auth``): claims
``sub`` (user id), ``usr`` (username), ``role``, ``rls`` (roles), ``exp``.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import bcrypt
import jwt
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from utils.logger import get_logger
from workspace_studio.config.settings import get_settings
from workspace_studio.repositories.database import get_session


log = get_logger(__name__)

ACCESS_TOKEN_TTL = timedelta(hours=8)

# ── Credential policy ───────────────────────────────────────────────────────
PASSWORD_MIN_LENGTH = 8
# bcrypt hashes at most 72 BYTES and raises ValueError beyond that (it does not
# truncate). Validate here so a long passphrase is a clean 400, not a 500.
PASSWORD_MAX_BYTES = 72

USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 100
# Letters, digits, dot, underscore, hyphen. No spaces or '@', so a username can
# never be confused with an email address at the login prompt.
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class CredentialError(ValueError):
    """Invalid credential input — the caller maps this to a 400."""


class DuplicateUserError(ValueError):
    """Username or email already registered — the caller maps this to a 409."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field          # "username" | "email"


def validate_password(password: str) -> None:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise CredentialError(
            f"Password must be at least {PASSWORD_MIN_LENGTH} characters."
        )
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise CredentialError(
            f"Password is too long (max {PASSWORD_MAX_BYTES} bytes)."
        )


def validate_username(username: str) -> None:
    if not (USERNAME_MIN_LENGTH <= len(username) <= USERNAME_MAX_LENGTH):
        raise CredentialError(
            f"Username must be {USERNAME_MIN_LENGTH}–{USERNAME_MAX_LENGTH} characters."
        )
    if not USERNAME_PATTERN.match(username):
        raise CredentialError(
            "Username may contain only letters, numbers, dot, underscore and hyphen."
        )


def validate_email(email: str) -> None:
    if not EMAIL_PATTERN.match(email) or len(email) > 255:
        raise CredentialError("Enter a valid email address.")


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(user: dict[str, Any]) -> str:
    settings = get_settings()
    if not settings.secret_key:
        raise RuntimeError("SECRET_KEY environment variable is required to mint tokens")
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user["id"]),
        "usr": user.get("username", ""),
        "role": user.get("role", "user"),
        # Grant the workspace_studio capability role to every authenticated user;
        # in this standalone product workspaces ARE the product.
        "rls": ["workspace_studio"],
        "iat": now,
        "exp": now + ACCESS_TOKEN_TTL,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def get_user_by_username(username: str) -> Optional[dict[str, Any]]:
    with get_session() as session:
        row = session.execute(
            text(
                """
                SELECT id, username, email, full_name, password_hash, role, is_active
                FROM users
                WHERE username = :username
                """
            ),
            {"username": username},
        ).fetchone()
    return dict(row._mapping) if row else None


def get_user_by_email(email: str) -> Optional[dict[str, Any]]:
    """Case-insensitive lookup — emails are not case-sensitive in practice."""
    with get_session() as session:
        row = session.execute(
            text(
                """
                SELECT id, username, email, full_name, password_hash, role, is_active
                FROM users
                WHERE LOWER(email) = LOWER(:email)
                """
            ),
            {"email": email},
        ).fetchone()
    return dict(row._mapping) if row else None


def register_user(
    username: str,
    email: str,
    password: str,
    full_name: str | None = None,
) -> dict[str, Any]:
    """Create a normal ('user' role) account.

    Raises CredentialError for invalid input and DuplicateUserError when the
    username or email is taken. The pre-checks give a precise message ("that
    username is taken" vs "that email is registered"); the IntegrityError catch
    below is what makes it CORRECT — two simultaneous signups both pass the
    pre-check, and only the UNIQUE constraints decide the winner.
    """
    username = username.strip()
    email = email.strip()
    full_name = (full_name or "").strip() or None

    validate_username(username)
    validate_email(email)
    validate_password(password)

    if get_user_by_username(username):
        raise DuplicateUserError("username", "That username is already taken.")
    if get_user_by_email(email):
        raise DuplicateUserError("email", "An account with that email already exists.")

    try:
        with get_session() as session:
            row = session.execute(
                text(
                    """
                    INSERT INTO users (username, email, full_name, password_hash, role, is_active)
                    VALUES (:username, :email, :full_name, :password_hash, 'user', TRUE)
                    RETURNING id, username, email, full_name, role, is_active
                    """
                ),
                {
                    "username": username,
                    "email": email,
                    "full_name": full_name,
                    "password_hash": hash_password(password),
                },
            ).fetchone()
    except IntegrityError as exc:
        constraint = str(getattr(exc.orig, "diag", None) and exc.orig.diag.constraint_name or exc)
        if "email" in constraint:
            raise DuplicateUserError("email", "An account with that email already exists.") from exc
        raise DuplicateUserError("username", "That username is already taken.") from exc

    return dict(row._mapping)


def change_password(user_id: int, current_password: str, new_password: str) -> bool:
    """Re-authenticate with the current password, then set the new one.

    Returns False when the current password is wrong; the caller maps that to a
    401 rather than leaking it as a validation error.
    """
    validate_password(new_password)

    with get_session() as session:
        row = session.execute(
            text("SELECT password_hash FROM users WHERE id = :id AND is_active = TRUE"),
            {"id": user_id},
        ).fetchone()
    if not row or not verify_password(current_password, row._mapping["password_hash"] or ""):
        return False

    with get_session() as session:
        session.execute(
            text("UPDATE users SET password_hash = :h, updated_at = NOW() WHERE id = :id"),
            {"h": hash_password(new_password), "id": user_id},
        )
    return True


def authenticate(username: str, password: str) -> Optional[dict[str, Any]]:
    """Return the user dict on success, else None. Records the login timestamp."""
    user = get_user_by_username(username)
    if not user or not user.get("is_active"):
        return None
    if not verify_password(password, user.get("password_hash") or ""):
        return None
    with get_session() as session:
        session.execute(
            text("UPDATE users SET last_login = NOW(), login_count = login_count + 1 WHERE id = :id"),
            {"id": user["id"]},
        )
    return user


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    """Strip secrets before returning a user to a client."""
    return {
        "user_id": user["id"],
        "username": user.get("username", ""),
        "email": user.get("email", ""),
        "full_name": user.get("full_name", ""),
        "role": user.get("role", "user"),
        "is_admin": user.get("role") == "admin",
    }


# ── Profile ─────────────────────────────────────────────────────────────────
# Everything the account page shows, assembled from DevSphere's OWN tables
# (users, teams, workspaces, sessions, the message logs and the token ledger).
#
# The identity block is the only required part: a profile page that renders the
# account but shows a dash where a count should be is still useful, whereas one
# that 500s because the model-governance migration hasn't been applied is not.
# So every aggregate runs in its own session and degrades to its zero value —
# the same contract token_tracking/usage_queries.py holds for the usage panel.


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else (value or None)


def _scalars(sql: str, params: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    """Run a one-row aggregate query, returning `fallback` if anything fails."""
    try:
        with get_session() as session:
            row = session.execute(text(sql), params).fetchone()
    except Exception as exc:  # missing table, permissions, connection blip
        log.warning("profile_aggregate_failed", extra={"error": str(exc)})
        return dict(fallback)
    if row is None:
        return dict(fallback)
    mapping = row._mapping
    return {key: mapping[key] if key in mapping else default for key, default in fallback.items()}


def _latest(*values: Any) -> Optional[Any]:
    """Most recent of a set of possibly-None timestamps.

    All three sources are TIMESTAMPTZ so the driver hands back aware datetimes,
    but a naive one mixed in raises on comparison — not worth failing the page
    over, so fall back to the first value present.
    """
    present = [v for v in values if v is not None]
    if not present:
        return None
    try:
        return max(present)
    except TypeError:
        return present[0]


def get_profile(user_id: int) -> Optional[dict[str, Any]]:
    """Identity, team membership and activity totals for one user.

    Returns None when the user no longer exists, which the router maps to a 404
    rather than rendering a profile for a deleted account.
    """
    with get_session() as session:
        row = session.execute(
            text(
                """
                SELECT id, username, email, full_name, role, is_active,
                       created_at, last_login, login_count
                FROM users
                WHERE id = :uid
                """
            ),
            {"uid": user_id},
        ).fetchone()
    if row is None:
        return None
    user = dict(row._mapping)

    # ── Teams ────────────────────────────────────────────────────────────────
    # A grouping layer for model access and quotas only (db/migrations/005) —
    # not a tenancy boundary, so it never widens what the user can see.
    try:
        with get_session() as session:
            team_rows = session.execute(
                text(
                    """
                    SELECT t.id, t.name, t.description, tm.role_in_team
                    FROM team_members tm
                    JOIN teams t ON t.id = tm.team_id
                    WHERE tm.user_id = :uid AND t.is_active = TRUE
                    ORDER BY t.name
                    """
                ),
                {"uid": user_id},
            ).fetchall()
        teams = [dict(r._mapping) for r in team_rows]
    except Exception as exc:
        log.warning("profile_teams_failed", extra={"error": str(exc)})
        teams = []

    # ── Workspaces ───────────────────────────────────────────────────────────
    # Only rows this user owns. The synthetic '__global__' / '__chat__'
    # workspaces have no owner, so they fall out of the count on their own.
    workspaces = _scalars(
        """
        SELECT COUNT(*) FILTER (WHERE status = 'active')   AS active_workspaces,
               COUNT(*) FILTER (WHERE status = 'archived') AS archived_workspaces,
               MAX(last_accessed_at)                       AS last_workspace_at
        FROM workspaces
        WHERE owner_user_id = :uid AND deleted_at IS NULL
        """,
        {"uid": user_id},
        {"active_workspaces": 0, "archived_workspaces": 0, "last_workspace_at": None},
    )

    # ── Sessions ─────────────────────────────────────────────────────────────
    # GREATEST ignores NULLs in PostgreSQL, so a session that was never
    # re-opened still contributes its updated_at.
    sessions = _scalars(
        """
        SELECT COUNT(*)                                                AS total_sessions,
               COUNT(*) FILTER (WHERE is_active AND status = 'active') AS active_sessions,
               MAX(GREATEST(last_accessed_at, updated_at))             AS last_session_at
        FROM sessions
        WHERE user_id = :uid
        """,
        {"uid": user_id},
        {"total_sessions": 0, "active_sessions": 0, "last_session_at": None},
    )

    # ── Prompts sent ─────────────────────────────────────────────────────────
    # The two message logs are keyed differently — Workspace Studio chat by
    # workspaces.id, the agent by workspaces.tracking_id — so both are counted
    # and summed rather than picking one and under-reporting.
    prompts = _scalars(
        """
        SELECT (
                 SELECT COUNT(*) FROM chat_messages cm
                 JOIN workspaces w ON w.id = cm.workspace_id
                 WHERE w.owner_user_id = :uid AND cm.role = 'user'
               ) + (
                 SELECT COUNT(*) FROM agent_messages am
                 JOIN workspaces w ON w.tracking_id = am.tracking_id
                 WHERE w.owner_user_id = :uid AND am.role = 'user'
               ) AS prompts_sent
        """,
        {"uid": user_id},
        {"prompts_sent": 0},
    )

    # ── Token ledger ─────────────────────────────────────────────────────────
    # Imported lazily: token_tracking pulls in the model registry, and auth must
    # stay importable (login has to work) even when that stack cannot load.
    month = all_time = {"total_tokens": 0, "cost_usd": 0.0, "request_count": 0}
    try:
        from token_tracking.usage_queries import usage_for_user

        month = usage_for_user(user_id, "month")
        all_time = usage_for_user(user_id, "all")
    except Exception as exc:
        log.warning("profile_usage_failed", extra={"error": str(exc)})

    last_active = _latest(
        workspaces["last_workspace_at"], sessions["last_session_at"], user.get("last_login")
    )

    return {
        "user": {
            "id": user["id"],
            "username": user.get("username", ""),
            "email": user.get("email"),
            "full_name": user.get("full_name"),
            "role": user.get("role", "user"),
            "is_admin": user.get("role") == "admin",
            "is_active": bool(user.get("is_active", True)),
            "created_at": _iso(user.get("created_at")),
            "last_login": _iso(user.get("last_login")),
            "login_count": int(user.get("login_count") or 0),
        },
        "teams": teams,
        "stats": {
            "active_workspaces": int(workspaces["active_workspaces"] or 0),
            "archived_workspaces": int(workspaces["archived_workspaces"] or 0),
            "total_sessions": int(sessions["total_sessions"] or 0),
            "active_sessions": int(sessions["active_sessions"] or 0),
            "prompts_sent": int(prompts["prompts_sent"] or 0),
            "login_count": int(user.get("login_count") or 0),
            "llm_requests": int(all_time.get("request_count") or 0),
            "total_tokens": int(all_time.get("total_tokens") or 0),
            "tokens_this_month": int(month.get("total_tokens") or 0),
            "cost_this_month_usd": float(month.get("cost_usd") or 0.0),
            "last_active_at": _iso(last_active),
        },
    }
