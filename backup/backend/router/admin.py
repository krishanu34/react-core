"""
Admin API — models, teams, access policies, quotas and usage.

This is the write side of everything `llm/model_registry.py` and
`quota/service.py` read. It exists so the answers to "which model does this
person run on" and "how much may they spend" are operational settings an admin
changes in a UI, rather than `.env` values that need a redeploy.

Two rules run through the whole file:

  * **Every write invalidates the caches.** Both readers cache for up to a
    minute; without the invalidation an admin's change appears to do nothing
    for a minute, and they change it again.
  * **API keys are write-only.** A model row stores the key itself, so a
    deployment added here works with no .env edit and no restart. The key can
    be SET through this API and is never READ back: responses carry
    `api_key_set` and a 4-character `api_key_hint` instead. Returning the
    value would put a live credential in every admin's browser, in its cache,
    and in any screenshot of this page — none of which the database needs.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from router.auth import get_current_admin
from utils.logger import get_logger

log = get_logger(__name__)

admin_router = APIRouter(prefix="/api/admin", tags=["admin"])


def _session():
    from workspace_studio.repositories.database import get_session

    return get_session()


def _invalidate() -> None:
    """Drop both caches after a write. Cheap, and the alternative is an admin
    watching their own change fail to take effect."""
    try:
        from llm.model_registry import invalidate as invalidate_models
        from quota.service import invalidate as invalidate_quotas

        invalidate_models()
        invalidate_quotas()
    except Exception as e:  # noqa: BLE001
        log.warning(f"Cache invalidation after admin write failed: {e}")


def _rows(result) -> list[dict[str, Any]]:
    return [dict(r._mapping) for r in result.fetchall()]


def _missing(kind: str, identifier: Any):
    return HTTPException(status_code=404, detail=f"{kind} {identifier} not found")


# ── Models ───────────────────────────────────────────────────────────────────

class ModelIn(BaseModel):
    model_key: str = Field(..., min_length=1, max_length=64)
    display_name: str
    provider: str = "azure"
    model_name: str
    endpoint_url: Optional[str] = None
    api_version: Optional[str] = None
    # The provider key itself. Blank falls back to the provider's env var.
    api_key: Optional[str] = None
    context_window: int = 128000
    max_output_tokens: int = 16384
    supports_temperature: bool = True
    tokens_param: str = "max_tokens"
    supports_vision: bool = False
    tier: str = "balanced"
    input_cost_per_1m: float = 0
    cached_input_cost_per_1m: float = 0
    output_cost_per_1m: float = 0
    is_active: bool = True
    is_default: bool = False


class ModelPatch(BaseModel):
    display_name: Optional[str] = None
    provider: Optional[str] = None
    model_name: Optional[str] = None
    endpoint_url: Optional[str] = None
    api_version: Optional[str] = None
    # Omit to leave the stored key untouched; send "" to clear it and fall
    # back to the provider env var.
    api_key: Optional[str] = None
    context_window: Optional[int] = None
    max_output_tokens: Optional[int] = None
    supports_temperature: Optional[bool] = None
    tokens_param: Optional[str] = None
    supports_vision: Optional[bool] = None
    tier: Optional[str] = None
    input_cost_per_1m: Optional[float] = None
    cached_input_cost_per_1m: Optional[float] = None
    output_cost_per_1m: Optional[float] = None
    is_active: Optional[bool] = None
    is_default: Optional[bool] = None


# The response projection. `api_key` is deliberately absent: it is replaced by
# a boolean and a 4-character hint, which is enough for an admin to tell "a key
# is set" and "which key" apart without the value ever leaving the server.
_MODEL_COLUMNS = """
    id, model_key, display_name, provider, model_name, endpoint_url, api_version,
    (api_key IS NOT NULL AND api_key <> '') AS api_key_set,
    RIGHT(COALESCE(api_key, ''), 4) AS api_key_hint,
    context_window, max_output_tokens, supports_temperature,
    tokens_param, supports_vision, tier, input_cost_per_1m,
    cached_input_cost_per_1m, output_cost_per_1m, is_active, is_default,
    created_at, updated_at
"""


def _clear_other_defaults(session, keep_id: Optional[int] = None) -> None:
    """Only one row may be `is_default` (ux_model_configs_one_default). Clearing
    the old one here turns what would be a 500 into the obvious behaviour:
    setting a new default unsets the previous one."""
    session.execute(
        text("UPDATE model_configs SET is_default = FALSE WHERE is_default AND id IS DISTINCT FROM :keep"),
        {"keep": keep_id},
    )


@admin_router.get("/models")
async def list_models(_: str = Depends(get_current_admin)):
    """Every model, active or not — the admin view, unlike GET /api/agent/models
    which shows one caller their own entitlements."""
    with _session() as session:
        return _rows(session.execute(text(f"SELECT {_MODEL_COLUMNS} FROM model_configs ORDER BY model_key")))


@admin_router.post("/models", status_code=201)
async def create_model(body: ModelIn, admin_id: str = Depends(get_current_admin)):
    params = body.model_dump()
    params["created_by"] = int(admin_id) if admin_id.isdigit() else None

    with _session() as session:
        if body.is_default:
            _clear_other_defaults(session)
        try:
            row = session.execute(
                text(
                    f"""
                    INSERT INTO model_configs (
                        model_key, display_name, provider, model_name, endpoint_url,
                        api_version, api_key, context_window, max_output_tokens,
                        supports_temperature, tokens_param, supports_vision, tier,
                        input_cost_per_1m, cached_input_cost_per_1m, output_cost_per_1m,
                        is_active, is_default, created_by
                    ) VALUES (
                        :model_key, :display_name, :provider, :model_name, :endpoint_url,
                        :api_version, :api_key, :context_window, :max_output_tokens,
                        :supports_temperature, :tokens_param, :supports_vision, :tier,
                        :input_cost_per_1m, :cached_input_cost_per_1m, :output_cost_per_1m,
                        :is_active, :is_default, :created_by
                    )
                    RETURNING {_MODEL_COLUMNS}
                    """
                ),
                params,
            ).fetchone()
        except Exception as e:  # noqa: BLE001
            if "model_key" in str(e).lower():
                raise HTTPException(status_code=409, detail=f"A model with key '{body.model_key}' already exists.")
            raise
    _invalidate()
    return dict(row._mapping)


@admin_router.put("/models/{model_id}")
async def update_model(model_id: int, body: ModelPatch, _: str = Depends(get_current_admin)):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=422, detail="No fields to update.")

    assignments = ", ".join(f"{k} = :{k}" for k in fields)
    with _session() as session:
        if fields.get("is_default"):
            _clear_other_defaults(session, keep_id=model_id)
        row = session.execute(
            text(f"UPDATE model_configs SET {assignments}, updated_at = NOW() "
                 f"WHERE id = :id RETURNING {_MODEL_COLUMNS}"),
            {**fields, "id": model_id},
        ).fetchone()
    if row is None:
        raise _missing("Model", model_id)
    _invalidate()
    return dict(row._mapping)


@admin_router.delete("/models/{model_id}", status_code=204)
async def delete_model(model_id: int, _: str = Depends(get_current_admin)):
    """Delete a model. Access policies referencing it cascade away; historical
    `token_usage` rows keep their totals and lose only the FK, so deleting a
    model never rewrites what it already cost."""
    with _session() as session:
        row = session.execute(
            text("DELETE FROM model_configs WHERE id = :id RETURNING id"), {"id": model_id}
        ).fetchone()
    if row is None:
        raise _missing("Model", model_id)
    _invalidate()


@admin_router.post("/models/{model_id}/test")
async def test_model(model_id: int, _: str = Depends(get_current_admin)):
    """Send one trivial completion through this model's real configuration.

    A model row can be syntactically perfect and still be unusable — wrong
    endpoint, a key env var that isn't set on this host, a deployment name that
    doesn't exist. Finding that out here beats finding out inside a user's run.
    """
    from llm.factory import LLMFactory
    from llm.model_registry import by_id, invalidate

    invalidate()  # test what is in the DB right now, not what was cached
    cfg = by_id(model_id)
    if cfg is None:
        raise _missing("Model", model_id)

    llm = LLMFactory.from_config(cfg)
    if llm is None:
        return {
            "success": False,
            "message": (
                "Could not build a client. Check the endpoint URL and that an API "
                "key is set on this model"
                + ("" if cfg.api_key else " (it currently has none, so it relies on "
                                          "the provider's environment variable)")
                + "."
            ),
        }

    try:
        reply, usage = await llm.invoke(
            [{"role": "user", "content": "Reply with the single word: ok"}],
            max_tokens=16,
        )
    except Exception as e:  # noqa: BLE001 — the failure IS the result here
        return {"success": False, "message": f"{type(e).__name__}: {e}"}

    return {
        "success": True,
        "message": f"{cfg.display_name} responded in {usage.get('total_tokens', 0)} tokens.",
        "response_preview": (reply or "").strip()[:200],
        "usage": usage,
    }


# ── Teams ────────────────────────────────────────────────────────────────────

class TeamIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    description: Optional[str] = None
    is_active: bool = True


class TeamMemberIn(BaseModel):
    user_id: int
    role_in_team: str = "member"


@admin_router.get("/teams")
async def list_teams(_: str = Depends(get_current_admin)):
    with _session() as session:
        return _rows(session.execute(
            text(
                """
                SELECT t.id, t.name, t.description, t.is_active, t.created_at,
                       COUNT(tm.user_id) AS member_count
                FROM teams t
                LEFT JOIN team_members tm ON tm.team_id = t.id
                GROUP BY t.id
                ORDER BY t.name
                """
            )
        ))


@admin_router.post("/teams", status_code=201)
async def create_team(body: TeamIn, _: str = Depends(get_current_admin)):
    with _session() as session:
        try:
            row = session.execute(
                text(
                    """
                    INSERT INTO teams (name, description, is_active)
                    VALUES (:name, :description, :is_active)
                    RETURNING id, name, description, is_active, created_at
                    """
                ),
                body.model_dump(),
            ).fetchone()
        except Exception as e:  # noqa: BLE001
            if "teams_name_key" in str(e):
                raise HTTPException(status_code=409, detail=f"A team named '{body.name}' already exists.")
            raise
    return dict(row._mapping)


@admin_router.delete("/teams/{team_id}", status_code=204)
async def delete_team(team_id: int, _: str = Depends(get_current_admin)):
    with _session() as session:
        row = session.execute(
            text("DELETE FROM teams WHERE id = :id RETURNING id"), {"id": team_id}
        ).fetchone()
    if row is None:
        raise _missing("Team", team_id)
    _invalidate()


@admin_router.get("/teams/{team_id}/members")
async def team_members(team_id: int, _: str = Depends(get_current_admin)):
    with _session() as session:
        return _rows(session.execute(
            text(
                """
                SELECT u.id, u.username, u.email, u.full_name, tm.role_in_team
                FROM team_members tm
                JOIN users u ON u.id = tm.user_id
                WHERE tm.team_id = :team_id
                ORDER BY u.username
                """
            ),
            {"team_id": team_id},
        ))


@admin_router.post("/teams/{team_id}/members", status_code=204)
async def add_team_member(team_id: int, body: TeamMemberIn, _: str = Depends(get_current_admin)):
    with _session() as session:
        session.execute(
            text(
                """
                INSERT INTO team_members (team_id, user_id, role_in_team)
                VALUES (:team_id, :user_id, :role_in_team)
                ON CONFLICT (team_id, user_id) DO UPDATE SET role_in_team = EXCLUDED.role_in_team
                """
            ),
            {"team_id": team_id, **body.model_dump()},
        )
    # Membership decides model access and which quota applies, so it is
    # cache-invalidating like any other policy change.
    _invalidate()


@admin_router.delete("/teams/{team_id}/members/{user_id}", status_code=204)
async def remove_team_member(team_id: int, user_id: int, _: str = Depends(get_current_admin)):
    with _session() as session:
        session.execute(
            text("DELETE FROM team_members WHERE team_id = :team_id AND user_id = :user_id"),
            {"team_id": team_id, "user_id": user_id},
        )
    _invalidate()


@admin_router.get("/users")
async def list_users(_: str = Depends(get_current_admin)):
    """Users, for the team and policy pickers."""
    with _session() as session:
        return _rows(session.execute(
            text(
                """
                SELECT id, username, email, full_name, role, is_active, last_login
                FROM users ORDER BY username
                """
            )
        ))


# ── Model access policies ────────────────────────────────────────────────────

class PolicyIn(BaseModel):
    subject_type: str  # global | role | team | user
    subject_ref: str = "*"
    model_config_id: int
    is_default_for_subject: bool = False


@admin_router.get("/model-access")
async def list_policies(_: str = Depends(get_current_admin)):
    with _session() as session:
        return _rows(session.execute(
            text(
                """
                SELECT p.id, p.subject_type, p.subject_ref, p.model_config_id,
                       p.is_default_for_subject, m.model_key, m.display_name
                FROM model_access_policies p
                JOIN model_configs m ON m.id = p.model_config_id
                ORDER BY p.subject_type, p.subject_ref, m.model_key
                """
            )
        ))


@admin_router.post("/model-access", status_code=201)
async def create_policy(body: PolicyIn, _: str = Depends(get_current_admin)):
    if body.subject_type not in ("global", "role", "team", "user"):
        raise HTTPException(status_code=422, detail="subject_type must be global, role, team or user.")

    with _session() as session:
        if body.is_default_for_subject:
            # ux_model_access_one_default_per_subject allows exactly one.
            session.execute(
                text(
                    """
                    UPDATE model_access_policies SET is_default_for_subject = FALSE
                    WHERE subject_type = :subject_type AND subject_ref = :subject_ref
                    """
                ),
                {"subject_type": body.subject_type, "subject_ref": body.subject_ref},
            )
        row = session.execute(
            text(
                """
                INSERT INTO model_access_policies (
                    subject_type, subject_ref, model_config_id, is_default_for_subject
                ) VALUES (
                    :subject_type, :subject_ref, :model_config_id, :is_default_for_subject
                )
                ON CONFLICT (subject_type, subject_ref, model_config_id) DO UPDATE
                    SET is_default_for_subject = EXCLUDED.is_default_for_subject
                RETURNING id, subject_type, subject_ref, model_config_id, is_default_for_subject
                """
            ),
            body.model_dump(),
        ).fetchone()
    _invalidate()
    return dict(row._mapping)


@admin_router.delete("/model-access/{policy_id}", status_code=204)
async def delete_policy(policy_id: int, _: str = Depends(get_current_admin)):
    with _session() as session:
        row = session.execute(
            text("DELETE FROM model_access_policies WHERE id = :id RETURNING id"), {"id": policy_id}
        ).fetchone()
    if row is None:
        raise _missing("Policy", policy_id)
    _invalidate()


# ── Quotas ───────────────────────────────────────────────────────────────────

class QuotaIn(BaseModel):
    subject_type: str
    subject_ref: str = "*"
    daily_token_limit: Optional[int] = None
    monthly_token_limit: Optional[int] = None
    per_run_token_limit: Optional[int] = None
    warn_pct: int = 75
    critical_pct: int = 90
    degrade_model_config_id: Optional[int] = None
    hard_block_tokens: Optional[int] = None
    is_active: bool = True


@admin_router.get("/quotas")
async def list_quotas(_: str = Depends(get_current_admin)):
    with _session() as session:
        return _rows(session.execute(
            text(
                """
                SELECT q.*, m.model_key AS degrade_model_key, m.display_name AS degrade_model_name
                FROM token_quotas q
                LEFT JOIN model_configs m ON m.id = q.degrade_model_config_id
                ORDER BY q.subject_type, q.subject_ref
                """
            )
        ))


@admin_router.post("/quotas", status_code=201)
async def upsert_quota(body: QuotaIn, _: str = Depends(get_current_admin)):
    """Create or replace the quota for one subject.

    Upsert rather than insert because `ux_token_quotas_one_active_per_subject`
    permits exactly one active row per subject — two would make "the limit"
    ambiguous, which is the one thing a limit must never be.
    """
    if body.subject_type not in ("global", "role", "team", "user"):
        raise HTTPException(status_code=422, detail="subject_type must be global, role, team or user.")
    if body.warn_pct > body.critical_pct:
        raise HTTPException(status_code=422, detail="warn_pct must be at or below critical_pct.")

    with _session() as session:
        session.execute(
            text(
                """
                UPDATE token_quotas SET is_active = FALSE
                WHERE subject_type = :subject_type AND subject_ref = :subject_ref AND is_active
                """
            ),
            {"subject_type": body.subject_type, "subject_ref": body.subject_ref},
        )
        row = session.execute(
            text(
                """
                INSERT INTO token_quotas (
                    subject_type, subject_ref, daily_token_limit, monthly_token_limit,
                    per_run_token_limit, warn_pct, critical_pct,
                    degrade_model_config_id, hard_block_tokens, is_active
                ) VALUES (
                    :subject_type, :subject_ref, :daily_token_limit, :monthly_token_limit,
                    :per_run_token_limit, :warn_pct, :critical_pct,
                    :degrade_model_config_id, :hard_block_tokens, :is_active
                )
                RETURNING *
                """
            ),
            body.model_dump(),
        ).fetchone()
    _invalidate()
    return dict(row._mapping)


@admin_router.delete("/quotas/{quota_id}", status_code=204)
async def delete_quota(quota_id: int, _: str = Depends(get_current_admin)):
    with _session() as session:
        row = session.execute(
            text("DELETE FROM token_quotas WHERE id = :id RETURNING id"), {"id": quota_id}
        ).fetchone()
    if row is None:
        raise _missing("Quota", quota_id)
    _invalidate()


# ── Usage dashboard ──────────────────────────────────────────────────────────

@admin_router.get("/usage")
async def usage_dashboard(window: str = "month", _: str = Depends(get_current_admin)):
    """Spend across the whole install, split three ways.

    A user in two teams counts toward both team totals, so the team numbers
    sum to more than the user numbers. That is deliberate — see
    token_tracking/usage_queries.usage_by_team.
    """
    from token_tracking.usage_queries import usage_by_model, usage_by_team, usage_by_user

    return {
        "window": window,
        "by_user": usage_by_user(window),
        "by_team": usage_by_team(window),
        "by_model": usage_by_model(None, window),
    }
