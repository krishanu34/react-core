"""
Token budgets: how much a user may spend, what happens as they approach it,
and what happens when they pass it.

WHY DEGRADE RATHER THAN BLOCK
-----------------------------
The obvious design is a hard stop at 100%. It is also the wrong one, and Claude
Code's own behaviour is the evidence: it warns as a limit approaches and then
falls back to a cheaper model, because a developer halted mid-task loses the
whole task, not just the tokens. A budget exists to cap COST, and a cheaper
model caps cost without throwing away work.

So the ladder is:

    ok  →  warn (warn_pct)  →  critical (critical_pct)  →  exceeded  →  blocked

`exceeded` swaps in the quota's `degrade_model_config_id` and keeps going.
`blocked` — a refused run, HTTP 429 — happens only in two cases an admin chose
explicitly: usage passed `hard_block_tokens`, or the quota was configured with
no degrade model, which is how an admin says "stop means stop".

PRECEDENCE
----------
    user  >  team  >  role  >  global

The most specific ACTIVE row wins outright. Quotas are not summed or
intersected: a user-level row is an override for that person, not an extra
constraint layered on top of their team's.

Like `llm/model_registry`, nothing here raises. A quota system that fails
closed on a database hiccup would take the product down; one that fails open
costs money it can reconcile later.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from sqlalchemy import text

from utils.logger import get_logger

log = get_logger(__name__)

# Quota rows change rarely; usage changes constantly. Both are cached, but the
# usage cache is short: it is re-read at every agent step, and the worst case
# is overshooting a limit by whatever a user can spend in this window.
_CONFIG_TTL_SECONDS = 60.0
_USAGE_TTL_SECONDS = 15.0

LEVELS = ("ok", "warn", "critical", "exceeded", "blocked")

_lock = threading.Lock()
_config_cache: dict[str, tuple[float, Any]] = {}
_usage_cache: dict[int, tuple[float, dict]] = {}
_tables_missing = False

_SPECIFICITY = {"user": 3, "team": 2, "role": 1, "global": 0}

_SELECT_QUOTAS = """
    SELECT id, subject_type, subject_ref, daily_token_limit, monthly_token_limit,
           per_run_token_limit, warn_pct, critical_pct, degrade_model_config_id,
           hard_block_tokens
    FROM token_quotas
    WHERE is_active
"""


@dataclass
class QuotaDecision:
    """The answer to "may this run proceed, and on what?"."""

    level: str = "ok"
    # False ONLY for `blocked`. `exceeded` is allowed — on a cheaper model.
    allowed: bool = True
    used: int = 0
    limit: Optional[int] = None
    window: str = "day"
    pct: float = 0.0
    per_run_limit: Optional[int] = None
    # The model the run should actually use. Identical to the requested one
    # unless a budget forced a substitution.
    effective_model: Any = None
    degraded: bool = False
    message: str = ""
    detail: dict = field(default_factory=dict)

    @property
    def should_notify(self) -> bool:
        return self.level != "ok"

    def to_event(self) -> dict:
        """The `quota_notice` SSE payload."""
        return {
            "level": self.level,
            "used": self.used,
            "limit": self.limit,
            "window": self.window,
            "pct": round(self.pct * 100, 1),
            "degraded": self.degraded,
            "model": getattr(self.effective_model, "display_name", None)
            or getattr(self.effective_model, "model_key", None),
            "message": self.message,
        }


def invalidate() -> None:
    """Drop cached quota rows and usage. Called after an admin write."""
    global _tables_missing
    with _lock:
        _config_cache.clear()
        _usage_cache.clear()
        _tables_missing = False


def _load_quotas() -> list[dict]:
    global _tables_missing
    if _tables_missing:
        return []

    now = time.monotonic()
    with _lock:
        cached = _config_cache.get("__all__")
        if cached and (now - cached[0]) < _CONFIG_TTL_SECONDS:
            return cached[1]

    try:
        from workspace_studio.repositories.database import get_session

        with get_session() as session:
            rows = session.execute(text(_SELECT_QUOTAS)).fetchall()
        quotas = [dict(r._mapping) for r in rows]
    except Exception as exc:  # noqa: BLE001
        message = str(exc).lower()
        if "token_quotas" in message and ("does not exist" in message or "undefined" in message):
            _tables_missing = True
            log.info(
                "token_quotas table not found — no budgets are enforced. Apply "
                "db/migrations/005_model_governance.sql to manage quotas."
            )
        else:
            log.warning("Could not load quotas (%s) — not enforcing budgets", exc)
        with _lock:
            _config_cache["__all__"] = (now, [])
        return []

    with _lock:
        _config_cache["__all__"] = (time.monotonic(), quotas)
    return quotas


def _quota_for(subject) -> Optional[dict]:
    """The single quota row governing this subject, or None."""
    matching = [q for q in _load_quotas() if subject.matches(q["subject_type"], q["subject_ref"])]
    if not matching:
        return None
    return max(matching, key=lambda q: _SPECIFICITY.get(q["subject_type"], 0))


def _usage(user_id: int) -> dict:
    """Today's and this month's totals, briefly cached."""
    now = time.monotonic()
    with _lock:
        cached = _usage_cache.get(user_id)
        if cached and (now - cached[0]) < _USAGE_TTL_SECONDS:
            return cached[1]

    from token_tracking.usage_queries import usage_for_user

    totals = {
        "day": usage_for_user(user_id, "day"),
        "month": usage_for_user(user_id, "month"),
    }
    with _lock:
        _usage_cache[user_id] = (time.monotonic(), totals)
    return totals


def note_spend(user_id: Optional[int]) -> None:
    """Drop one user's cached usage so the next check re-reads it.

    Called after a run finishes. Without it a short run's whole spend can land
    inside one cache window and be invisible to the next run's opening check.
    """
    if user_id is None:
        return
    with _lock:
        _usage_cache.pop(user_id, None)


def per_run_limit_for(user_id: Any) -> Optional[int]:
    """The per-run token ceiling for this user, or None for no ceiling.

    Generalises `MAX_AGENT_TOKENS` from one process-wide env var to a
    per-subject setting, so one runaway agent loop can't burn a month's budget
    while every daily total still looks fine.
    """
    try:
        from llm.model_registry import resolve_subject

        quota = _quota_for(resolve_subject(user_id))
    except Exception as exc:  # noqa: BLE001
        log.debug("per-run limit lookup failed for %s: %s", user_id, exc)
        return None
    if not quota:
        return None
    limit = quota.get("per_run_token_limit")
    return int(limit) if limit else None


def _level_for(pct: float, warn_pct: int, critical_pct: int) -> str:
    if pct >= 1.0:
        return "exceeded"
    if pct >= critical_pct / 100:
        return "critical"
    if pct >= warn_pct / 100:
        return "warn"
    return "ok"


def _fmt(n: int) -> str:
    return f"{n / 1_000_000:.1f}M" if n >= 1_000_000 else f"{n / 1_000:.0f}k" if n >= 1_000 else str(n)


def check(user_id: Any, model_cfg=None, subject=None) -> QuotaDecision:
    """Whether this user may run, and on which model.

    `model_cfg` is what model resolution picked; the returned
    `effective_model` is what should actually be used. They differ only when a
    budget forced a downgrade.
    """
    decision = QuotaDecision(effective_model=model_cfg)

    try:
        from llm.model_registry import resolve_subject

        subject = subject or resolve_subject(user_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("Quota subject lookup failed for %s: %s", user_id, exc)
        return decision

    quota = _quota_for(subject)
    if not quota or subject.user_id is None:
        # No quota row, or a caller with no `users` row to meter (api_key /
        # disabled auth modes). Nothing to enforce.
        return decision

    decision.per_run_limit = int(quota["per_run_token_limit"]) if quota.get("per_run_token_limit") else None

    totals = _usage(subject.user_id)
    warn_pct = int(quota.get("warn_pct") or 75)
    critical_pct = int(quota.get("critical_pct") or 90)

    # Both windows are evaluated and the WORSE one binds — a user who is fine
    # for the day but out of month is out.
    worst: Optional[tuple[float, str, int, int]] = None
    for window, limit_key in (("day", "daily_token_limit"), ("month", "monthly_token_limit")):
        limit = quota.get(limit_key)
        if not limit:
            continue
        used = int(totals[window]["total_tokens"])
        pct = used / int(limit)
        if worst is None or pct > worst[0]:
            worst = (pct, window, used, int(limit))

    if worst is None:
        # A quota row with no limits — warning thresholds only, nothing to
        # measure them against. This is the seeded default.
        return decision

    pct, window, used, limit = worst
    decision.pct, decision.window, decision.used, decision.limit = pct, window, used, limit
    decision.level = _level_for(pct, warn_pct, critical_pct)

    if decision.level in ("warn", "critical"):
        decision.message = (
            f"You've used {_fmt(used)} of your {_fmt(limit)} {window} token budget "
            f"({pct * 100:.0f}%)."
        )
        return decision

    if decision.level != "exceeded":
        return decision

    # ── Over the limit ───────────────────────────────────────────────────────
    hard_block = quota.get("hard_block_tokens")
    if hard_block and used >= int(hard_block):
        decision.level = "blocked"
        decision.allowed = False
        decision.message = (
            f"Your {window} token budget is exhausted ({_fmt(used)} of "
            f"{_fmt(limit)}) and the {_fmt(int(hard_block))} hard limit has been "
            f"reached. It resets "
            f"{'tomorrow' if window == 'day' else 'at the start of next month'}."
        )
        return decision

    degrade = None
    try:
        from llm.model_registry import by_id

        degrade = by_id(quota.get("degrade_model_config_id"))
    except Exception as exc:  # noqa: BLE001
        log.debug("Degrade model lookup failed: %s", exc)

    if degrade is None:
        # No fallback configured. An admin who sets a limit without a degrade
        # model is asking for a hard stop — honour that rather than inventing
        # a substitute model on their behalf.
        decision.level = "blocked"
        decision.allowed = False
        decision.message = (
            f"Your {window} token budget is exhausted ({_fmt(used)} of {_fmt(limit)}). "
            f"It resets {'tomorrow' if window == 'day' else 'at the start of next month'}. "
            f"Ask an admin to raise it if you need more."
        )
        return decision

    if model_cfg is not None and getattr(model_cfg, "id", None) == degrade.id:
        # Already on the cheap model — degrading again would be a no-op, and
        # calling it a downgrade in the UI would be a lie.
        decision.message = (
            f"Your {window} token budget is exhausted ({_fmt(used)} of {_fmt(limit)}) — "
            f"still running on {degrade.display_name}."
        )
        decision.effective_model = degrade
        return decision

    decision.effective_model = degrade
    decision.degraded = True
    decision.message = (
        f"Your {window} token budget is exhausted ({_fmt(used)} of {_fmt(limit)}) — "
        f"continuing on {degrade.display_name} so your work isn't interrupted."
    )
    return decision


def status_for_user(user_id: Any) -> dict:
    """Everything the usage page shows: limits, spend, and where that lands.

    Kept next to `check()` on purpose — a usage page whose numbers are computed
    somewhere else drifts from the numbers actually being enforced.
    """
    try:
        from llm.model_registry import resolve_subject

        subject = resolve_subject(user_id)
    except Exception:  # noqa: BLE001
        return {"has_quota": False}

    if subject.user_id is None:
        return {"has_quota": False}

    quota = _quota_for(subject)
    totals = _usage(subject.user_id)
    decision = check(user_id, subject=subject)

    def _window(name: str, limit_key: str) -> dict:
        limit = quota.get(limit_key) if quota else None
        used = int(totals[name]["total_tokens"])
        return {
            "used": used,
            "limit": int(limit) if limit else None,
            "pct": round(used / int(limit) * 100, 1) if limit else None,
            "cost_usd": round(float(totals[name]["cost_usd"]), 4),
            "cached_tokens": int(totals[name]["cached_tokens"]),
            "prompt_tokens": int(totals[name]["prompt_tokens"]),
            "completion_tokens": int(totals[name]["completion_tokens"]),
            "request_count": int(totals[name]["request_count"]),
        }

    return {
        "has_quota": quota is not None,
        "scope": f"{quota['subject_type']}:{quota['subject_ref']}" if quota else None,
        "level": decision.level,
        "message": decision.message,
        "day": _window("day", "daily_token_limit"),
        "month": _window("month", "monthly_token_limit"),
        "per_run_limit": decision.per_run_limit,
        "warn_pct": int(quota["warn_pct"]) if quota else None,
        "critical_pct": int(quota["critical_pct"]) if quota else None,
    }
