"""
DB-backed model catalogue and per-user model resolution.

Model selection used to live entirely in `backend/.env` — one
`AZURE_OPENAI_DEPLOYMENT` for the whole deployment, plus the `LLM_MODEL_ALIASES`
string parsed in `llm/factory.py`. That made "which model does this user run
on?" a redeploy question rather than an admin one. This module turns the same
information into rows an admin can edit live, and adds the part `.env` could
never express: *different models for different roles, teams and people*.

Two rules govern everything here, and both exist because a model lookup sits on
the hot path of every agent run:

  1. **Never raise.** Every entry point degrades to `None`, and `None` means
     "use the .env model" — exactly today's behaviour. An unapplied migration, a
     dropped database connection or an empty table must not turn into a failed
     agent run. This mirrors the philosophy already written into
     `LLMFactory.for_alias`: a run must never fail over model selection.
  2. **Never hit the database twice for the same answer.** The catalogue is
     cached for `_TTL_SECONDS`; admin writes call `invalidate()`.

Resolution precedence — the most specific level that matches the caller wins
OUTRIGHT, it is not merged with the levels below it:

    user  >  team  >  role  >  global  >  (no policies at all)

The last case is the important one for a fresh install: when no policy row
matches a user at any level, they get *every active model*. An admin narrows
access by adding policies, rather than having to grant everything before anyone
can work.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from sqlalchemy import text

from utils.logger import get_logger

log = get_logger(__name__)

# Long enough that a busy run reuses one read; short enough that an admin's
# change is live before they finish reading the confirmation toast.
_TTL_SECONDS = 60.0

# After a failed read the empty result is cached too, briefly. Without this a
# database that is down or unmigrated means a fresh connection attempt on every
# single lookup — which is the hot path of every agent step.
_FAILURE_TTL_SECONDS = 10.0

# Env var consulted when a model row carries no key of its own, so a
# deployment that would rather keep its credentials in .env can leave the
# column blank and keep working.
_DEFAULT_KEY_ENV = {
    "azure": "AZURE_OPENAI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

_MILLION = Decimal(1_000_000)


@dataclass(frozen=True)
class ModelConfig:
    """One row of `model_configs`, plus the behaviour that belongs with it."""

    id: int
    model_key: str
    display_name: str
    provider: str
    model_name: str
    endpoint_url: Optional[str]
    api_version: Optional[str]
    api_key: Optional[str]
    context_window: int
    max_output_tokens: int
    supports_temperature: bool
    tokens_param: str
    supports_vision: bool
    tier: str
    input_cost_per_1m: Decimal
    cached_input_cost_per_1m: Decimal
    output_cost_per_1m: Decimal
    is_active: bool
    is_default: bool

    @property
    def resolved_api_key(self) -> Optional[str]:
        """The key to authenticate with: the row's own, else the provider's
        env var.

        The row wins so that adding a deployment in the admin UI is enough to
        make it work — no matching .env edit, no backend restart. The env
        fallback keeps .env-only setups (and the no-catalogue path) working
        unchanged.

        Never log or serialise this. `api_key_masked` is what any human-facing
        surface should show.
        """
        if self.api_key:
            return self.api_key
        var = _DEFAULT_KEY_ENV.get(self.provider, "")
        return os.getenv(var) if var else None

    @property
    def api_key_masked(self) -> Optional[str]:
        """Last 4 characters, for telling two keys apart without revealing one.
        None when no key is configured at all."""
        key = self.resolved_api_key
        return f"…{key[-4:]}" if key else None

    @property
    def api_key_from_env(self) -> bool:
        """True when the key came from .env rather than the row — worth
        surfacing, because such a model breaks if it moves to another host."""
        return not self.api_key and bool(self.resolved_api_key)

    def cost_usd(self, prompt_tokens: int, completion_tokens: int, cached_tokens: int = 0) -> Decimal:
        """Dollar cost of one LLM call.

        `cached_tokens` is a SUBSET of `prompt_tokens` (Azure reports it inside
        `prompt_tokens_details`), so the fresh-input portion is the difference —
        adding them would bill the cached tokens twice, at both rates.
        """
        fresh = max(0, prompt_tokens - cached_tokens)
        return (
            Decimal(fresh) * self.input_cost_per_1m
            + Decimal(max(0, cached_tokens)) * self.cached_input_cost_per_1m
            + Decimal(max(0, completion_tokens)) * self.output_cost_per_1m
        ) / _MILLION

    def to_dict(self) -> dict:
        """Wire shape for the API. Never carries the key in any form — this
        is what non-admin callers receive; see `router/admin.py` for the admin
        view, which adds a masked hint but still never the value."""
        return {
            "id": self.id,
            "key": self.model_key,
            "display_name": self.display_name,
            "provider": self.provider,
            "model_name": self.model_name,
            "context_window": self.context_window,
            "max_output_tokens": self.max_output_tokens,
            "supports_vision": self.supports_vision,
            "tier": self.tier,
            "is_default": self.is_default,
        }


# ── Catalogue cache ──────────────────────────────────────────────────────────

_lock = threading.Lock()
_cache: Optional[list[ModelConfig]] = None
_cache_at: float = 0.0
# Set once the tables are found to be missing, so an unmigrated database costs
# one failed query rather than one per lookup for the life of the process.
_tables_missing = False


_SELECT_MODELS = """
    SELECT id, model_key, display_name, provider, model_name, endpoint_url,
           api_version, api_key, context_window, max_output_tokens,
           supports_temperature, tokens_param, supports_vision, tier,
           input_cost_per_1m, cached_input_cost_per_1m, output_cost_per_1m,
           is_active, is_default
    FROM model_configs
    WHERE is_active
    ORDER BY is_default DESC, model_key
"""


def _row_to_config(row) -> ModelConfig:
    m = row._mapping
    return ModelConfig(
        id=int(m["id"]),
        model_key=m["model_key"],
        display_name=m["display_name"],
        provider=(m["provider"] or "azure").lower(),
        model_name=m["model_name"],
        endpoint_url=m["endpoint_url"],
        api_version=m["api_version"],
        api_key=m["api_key"],
        context_window=int(m["context_window"]),
        max_output_tokens=int(m["max_output_tokens"]),
        supports_temperature=bool(m["supports_temperature"]),
        tokens_param=m["tokens_param"],
        supports_vision=bool(m["supports_vision"]),
        tier=m["tier"],
        input_cost_per_1m=Decimal(m["input_cost_per_1m"] or 0),
        cached_input_cost_per_1m=Decimal(m["cached_input_cost_per_1m"] or 0),
        output_cost_per_1m=Decimal(m["output_cost_per_1m"] or 0),
        is_active=bool(m["is_active"]),
        is_default=bool(m["is_default"]),
    )


def load_active() -> list[ModelConfig]:
    """Every active model, cached. Empty list = "no DB models, use .env"."""
    global _cache, _cache_at, _tables_missing

    if _tables_missing:
        return []

    now = time.monotonic()
    with _lock:
        if _cache is not None and (now - _cache_at) < _TTL_SECONDS:
            return _cache

    try:
        from workspace_studio.repositories.database import get_session

        with get_session() as session:
            rows = session.execute(text(_SELECT_MODELS)).fetchall()
        configs = [_row_to_config(r) for r in rows]
    except Exception as exc:  # noqa: BLE001 — see rule 1 in the module docstring
        message = str(exc).lower()
        if "model_configs" in message and ("does not exist" in message or "undefined" in message):
            _tables_missing = True
            log.info(
                "model_configs table not found — running on the .env model. "
                "Apply db/migrations/005_model_governance.sql to manage models "
                "from the database."
            )
        else:
            log.warning("Could not load model catalogue (%s) — falling back to .env", exc)
            with _lock:
                _cache = []
                _cache_at = time.monotonic() - (_TTL_SECONDS - _FAILURE_TTL_SECONDS)
        return []

    with _lock:
        _cache = configs
        _cache_at = time.monotonic()
    return configs


def invalidate() -> None:
    """Drop the cache. Called after any admin write, and by tests."""
    global _cache, _cache_at, _tables_missing
    with _lock:
        _cache = None
        _cache_at = 0.0
        _tables_missing = False


def by_key(model_key: str) -> Optional[ModelConfig]:
    """An active model by its slug, ignoring access policies."""
    key = (model_key or "").strip().lower()
    if not key:
        return None
    for cfg in load_active():
        if cfg.model_key.lower() == key:
            return cfg
    return None


def by_id(model_config_id: Optional[int]) -> Optional[ModelConfig]:
    if model_config_id is None:
        return None
    for cfg in load_active():
        if cfg.id == model_config_id:
            return cfg
    return None


# ── Subject resolution ───────────────────────────────────────────────────────

_SELECT_SUBJECT = """
    SELECT role FROM users WHERE id = :user_id
"""

_SELECT_TEAMS = """
    SELECT team_id FROM team_members WHERE user_id = :user_id
"""

_SELECT_POLICIES = """
    SELECT subject_type, subject_ref, model_config_id, is_default_for_subject
    FROM model_access_policies
"""

# user > team > role > global. Used to pick the single winning level.
_SPECIFICITY = {"user": 3, "team": 2, "role": 1, "global": 0}


def _numeric_user_id(user_id: str | int | None) -> Optional[int]:
    """`router/auth.py` hands out user ids as strings, and in `api_key` /
    `disabled` auth modes they aren't numeric at all ('local-user'). Those
    callers have no role and no teams, so they resolve to the global level."""
    try:
        return int(user_id)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Subject:
    """Who the caller is, for both model access and quota lookups."""

    user_id: Optional[int]
    role: str = "user"
    team_ids: tuple[int, ...] = ()

    def matches(self, subject_type: str, subject_ref: str) -> bool:
        if subject_type == "global":
            return True
        if subject_type == "role":
            return subject_ref.lower() == (self.role or "").lower()
        if subject_type == "user":
            return self.user_id is not None and subject_ref == str(self.user_id)
        if subject_type == "team":
            return any(subject_ref == str(t) for t in self.team_ids)
        return False


def resolve_subject(user_id: str | int | None) -> Subject:
    """The caller's role and team memberships. Degrades to a bare global
    subject on any failure, so a lookup problem can never block a run."""
    numeric = _numeric_user_id(user_id)
    if numeric is None:
        return Subject(user_id=None)

    try:
        from workspace_studio.repositories.database import get_session

        with get_session() as session:
            row = session.execute(text(_SELECT_SUBJECT), {"user_id": numeric}).fetchone()
            role = row._mapping["role"] if row else "user"
            teams = session.execute(text(_SELECT_TEAMS), {"user_id": numeric}).fetchall()
        return Subject(
            user_id=numeric,
            role=role or "user",
            team_ids=tuple(int(t._mapping["team_id"]) for t in teams),
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("Subject lookup failed for user %s (%s) — treating as global", user_id, exc)
        return Subject(user_id=numeric)


def _policies() -> list[dict]:
    try:
        from workspace_studio.repositories.database import get_session

        with get_session() as session:
            rows = session.execute(text(_SELECT_POLICIES)).fetchall()
        return [dict(r._mapping) for r in rows]
    except Exception as exc:  # noqa: BLE001
        log.debug("Access policy lookup failed (%s) — allowing all active models", exc)
        return []


def allowed_for_user(user_id: str | int | None, subject: Optional[Subject] = None) -> list[ModelConfig]:
    """The models this caller may run on.

    When no policy matches them at any level they get every active model —
    an install with models but no policies is usable, not locked out.
    """
    catalogue = load_active()
    if not catalogue:
        return []

    subject = subject or resolve_subject(user_id)
    matching = [p for p in _policies() if subject.matches(p["subject_type"], p["subject_ref"])]
    if not matching:
        return catalogue

    # One level wins outright; a user-level grant is an override, not an
    # addition to what their team or role already had.
    winning_level = max(_SPECIFICITY.get(p["subject_type"], 0) for p in matching)
    winners = [p for p in matching if _SPECIFICITY.get(p["subject_type"], 0) == winning_level]

    by_id_map = {c.id: c for c in catalogue}
    allowed = [by_id_map[p["model_config_id"]] for p in winners if p["model_config_id"] in by_id_map]
    # Every model the policy named is inactive or deleted — better to fall back
    # to the full catalogue than to hand back nothing and fail the run.
    return allowed or catalogue


def default_for_user(user_id: str | int | None, subject: Optional[Subject] = None) -> Optional[ModelConfig]:
    """The model to use when the caller doesn't name one."""
    subject = subject or resolve_subject(user_id)
    allowed = allowed_for_user(user_id, subject=subject)
    if not allowed:
        return None

    matching = [
        p for p in _policies()
        if p["is_default_for_subject"] and subject.matches(p["subject_type"], p["subject_ref"])
    ]
    if matching:
        best = max(matching, key=lambda p: _SPECIFICITY.get(p["subject_type"], 0))
        for cfg in allowed:
            if cfg.id == best["model_config_id"]:
                return cfg

    for cfg in allowed:
        if cfg.is_default:
            return cfg
    return allowed[0]


def resolve(
    user_id: str | int | None,
    requested_key: Optional[str] = None,
    subject: Optional[Subject] = None,
) -> Optional[ModelConfig]:
    """The model a run should use. `None` means "fall back to .env".

    A requested key that doesn't exist, or that the caller isn't allowed, is
    NOT an error — it silently resolves to their default. A stale client, a
    model an admin just deactivated, or an agent naming a model from its own
    imagination must not cost the user their turn.
    """
    subject = subject or resolve_subject(user_id)
    allowed = allowed_for_user(user_id, subject=subject)
    if not allowed:
        return None

    key = (requested_key or "").strip().lower()
    if key:
        for cfg in allowed:
            if cfg.model_key.lower() == key:
                return cfg
        log.info(
            "Model '%s' is not available to user %s (allowed: %s) — using their default",
            requested_key, user_id, ", ".join(c.model_key for c in allowed),
        )

    return default_for_user(user_id, subject=subject)
