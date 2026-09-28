"""
Read-side queries over the token ledger.

`token_usage` holds one row per LLM call and `token_usage_daily` the per-user
per-day rollup written alongside it. Everything a usage page, an admin
dashboard or a quota check needs to READ lives here, so the aggregation SQL
exists once rather than being re-derived at each call site.

Two windows, both calendar-aligned: today, and the current month. Rolling
windows (Claude's own 5-hour / 7-day buckets) smooth bursts better, but "when
does my limit reset" stops having an answer a user can act on.

Every function degrades to zeros rather than raising. A usage panel that can't
load must not take the IDE down with it.
"""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import text

from utils.logger import get_logger

log = get_logger(__name__)

_EMPTY = {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "cached_tokens": 0,
    "total_tokens": 0,
    "cost_usd": 0.0,
    "request_count": 0,
}

# CURRENT_DATE / date_trunc are evaluated by the database, so a client with a
# skewed clock can't shift its own quota window.
_WINDOW_PREDICATE = {
    "day": "usage_date = CURRENT_DATE",
    "month": "usage_date >= date_trunc('month', CURRENT_DATE)::date",
    "all": "TRUE",
}


def _session():
    from workspace_studio.repositories.database import get_session

    return get_session()


def _totals_row(row) -> dict[str, Any]:
    if row is None:
        return dict(_EMPTY)
    m = row._mapping
    return {
        "prompt_tokens": int(m["prompt_tokens"] or 0),
        "completion_tokens": int(m["completion_tokens"] or 0),
        "cached_tokens": int(m["cached_tokens"] or 0),
        "total_tokens": int(m["total_tokens"] or 0),
        "cost_usd": float(m["cost_usd"] or 0),
        "request_count": int(m["request_count"] or 0),
    }


def usage_for_user(user_id: int, window: str = "day") -> dict[str, Any]:
    """One user's totals over a calendar window. The hot path for quotas."""
    predicate = _WINDOW_PREDICATE.get(window, _WINDOW_PREDICATE["day"])
    try:
        with _session() as session:
            row = session.execute(
                text(
                    f"""
                    SELECT COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
                           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                           COALESCE(SUM(cached_tokens), 0)     AS cached_tokens,
                           COALESCE(SUM(total_tokens), 0)      AS total_tokens,
                           COALESCE(SUM(cost_usd), 0)          AS cost_usd,
                           COALESCE(SUM(request_count), 0)     AS request_count
                    FROM token_usage_daily
                    WHERE user_id = :user_id AND {predicate}
                    """
                ),
                {"user_id": user_id},
            ).fetchone()
        return _totals_row(row)
    except Exception as exc:  # noqa: BLE001
        log.debug("usage_for_user(%s, %s) failed: %s", user_id, window, exc)
        return dict(_EMPTY)


def usage_for_run(run_id: str) -> int:
    """Total tokens spent by one agent run, for the per-run ceiling.

    Reads `token_usage` rather than the rollup: a run is not a calendar day,
    and it is the only thing the per-run limit is about.
    """
    if not run_id:
        return 0
    try:
        with _session() as session:
            row = session.execute(
                text("SELECT COALESCE(SUM(total_tokens), 0) AS t FROM token_usage WHERE run_id = :run_id"),
                {"run_id": run_id},
            ).fetchone()
        return int(row._mapping["t"] or 0)
    except Exception as exc:  # noqa: BLE001
        log.debug("usage_for_run(%s) failed: %s", run_id, exc)
        return 0


def daily_series(user_id: int, days: int = 30) -> list[dict[str, Any]]:
    """Per-day totals for a usage chart. Days with no activity are omitted."""
    try:
        with _session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT usage_date, total_tokens, cached_tokens, cost_usd, request_count
                    FROM token_usage_daily
                    WHERE user_id = :user_id
                      AND usage_date >= CURRENT_DATE - CAST(:days AS INTEGER)
                    ORDER BY usage_date
                    """
                ),
                {"user_id": user_id, "days": days},
            ).fetchall()
        return [
            {
                "date": str(r._mapping["usage_date"]),
                "total_tokens": int(r._mapping["total_tokens"] or 0),
                "cached_tokens": int(r._mapping["cached_tokens"] or 0),
                "cost_usd": float(r._mapping["cost_usd"] or 0),
                "request_count": int(r._mapping["request_count"] or 0),
            }
            for r in rows
        ]
    except Exception as exc:  # noqa: BLE001
        log.debug("daily_series(%s) failed: %s", user_id, exc)
        return []


def usage_by_model(user_id: Optional[int] = None, window: str = "month") -> list[dict[str, Any]]:
    """Split by model — "what is actually costing money".

    Goes to `token_usage` because the rollup deliberately has no model axis:
    adding one would multiply its row count by the number of models and cost
    the O(1) quota lookup it exists to provide.
    """
    since = {
        "day": "created_at >= CURRENT_DATE",
        "month": "created_at >= date_trunc('month', CURRENT_DATE)",
        "all": "TRUE",
    }.get(window, "created_at >= date_trunc('month', CURRENT_DATE)")
    user_clause = "AND user_id = :user_id" if user_id is not None else ""

    try:
        with _session() as session:
            rows = session.execute(
                text(
                    f"""
                    SELECT COALESCE(model, 'unknown') AS model,
                           COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
                           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                           COALESCE(SUM(cached_tokens), 0)     AS cached_tokens,
                           COALESCE(SUM(total_tokens), 0)      AS total_tokens,
                           COALESCE(SUM(cost_usd), 0)          AS cost_usd,
                           COUNT(*)                            AS request_count
                    FROM token_usage
                    WHERE {since} {user_clause}
                    GROUP BY 1
                    ORDER BY total_tokens DESC
                    """
                ),
                {"user_id": user_id} if user_id is not None else {},
            ).fetchall()
        return [{"model": r._mapping["model"], **_totals_row(r)} for r in rows]
    except Exception as exc:  # noqa: BLE001
        log.debug("usage_by_model failed: %s", exc)
        return []


def usage_by_user(window: str = "month", limit: int = 100) -> list[dict[str, Any]]:
    """Admin dashboard: every user's spend, biggest first."""
    predicate = _WINDOW_PREDICATE.get(window, _WINDOW_PREDICATE["month"])
    try:
        with _session() as session:
            rows = session.execute(
                text(
                    f"""
                    SELECT u.id AS user_id, u.username, u.email, u.role,
                           COALESCE(SUM(d.prompt_tokens), 0)     AS prompt_tokens,
                           COALESCE(SUM(d.completion_tokens), 0) AS completion_tokens,
                           COALESCE(SUM(d.cached_tokens), 0)     AS cached_tokens,
                           COALESCE(SUM(d.total_tokens), 0)      AS total_tokens,
                           COALESCE(SUM(d.cost_usd), 0)          AS cost_usd,
                           COALESCE(SUM(d.request_count), 0)     AS request_count
                    FROM users u
                    LEFT JOIN token_usage_daily d
                           ON d.user_id = u.id AND {predicate}
                    GROUP BY u.id, u.username, u.email, u.role
                    ORDER BY total_tokens DESC
                    LIMIT :limit
                    """
                ),
                {"limit": limit},
            ).fetchall()
        return [
            {
                "user_id": int(r._mapping["user_id"]),
                "username": r._mapping["username"],
                "email": r._mapping["email"],
                "role": r._mapping["role"],
                **_totals_row(r),
            }
            for r in rows
        ]
    except Exception as exc:  # noqa: BLE001
        log.debug("usage_by_user failed: %s", exc)
        return []


def usage_by_team(window: str = "month") -> list[dict[str, Any]]:
    """Admin dashboard, aggregated over team membership.

    A user in two teams is counted in both — the alternative (splitting their
    spend) would make every team's number wrong in a subtler way.
    """
    predicate = _WINDOW_PREDICATE.get(window, _WINDOW_PREDICATE["month"])
    try:
        with _session() as session:
            rows = session.execute(
                text(
                    f"""
                    SELECT t.id AS team_id, t.name,
                           COUNT(DISTINCT tm.user_id)            AS member_count,
                           COALESCE(SUM(d.prompt_tokens), 0)     AS prompt_tokens,
                           COALESCE(SUM(d.completion_tokens), 0) AS completion_tokens,
                           COALESCE(SUM(d.cached_tokens), 0)     AS cached_tokens,
                           COALESCE(SUM(d.total_tokens), 0)      AS total_tokens,
                           COALESCE(SUM(d.cost_usd), 0)          AS cost_usd,
                           COALESCE(SUM(d.request_count), 0)     AS request_count
                    FROM teams t
                    LEFT JOIN team_members tm ON tm.team_id = t.id
                    LEFT JOIN token_usage_daily d
                           ON d.user_id = tm.user_id AND {predicate}
                    GROUP BY t.id, t.name
                    ORDER BY total_tokens DESC
                    """
                ),
            ).fetchall()
        return [
            {
                "team_id": int(r._mapping["team_id"]),
                "name": r._mapping["name"],
                "member_count": int(r._mapping["member_count"] or 0),
                **_totals_row(r),
            }
            for r in rows
        ]
    except Exception as exc:  # noqa: BLE001
        log.debug("usage_by_team failed: %s", exc)
        return []
