"""PostgreSQL persistence for DevSphere agent threads.

Unified model: the agent's ``thread_id`` IS a workspace's ``tracking_id``. Every
agent artifact (messages, snapshots, memory, token usage, run-state) is keyed by
``tracking_id`` and FKs into ``workspaces(tracking_id)``, so a workspace and its
full agent history are one trackable unit. The public method signatures keep the
name ``thread_id`` — its value is the workspace ``tracking_id``.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from utils.logger import get_logger
from workspace_studio.repositories.database import get_session
from token_tracking.base_tracking import (
    TokenUsage,
    cached_tokens_from,
    reasoning_tokens_from,
)


log = get_logger(__name__)

GLOBAL_THREAD_ID = "__global__"


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _json(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
    return value


def _iso(value: Any) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _ensure_thread(session, thread_id: str) -> None:
    """Ensure a workspace row exists for this tracking id.

    Agent-initiated threads (and the synthetic ``__global__`` / ``__chat__``
    accounting ids) create a metadata-only workspace; ``name`` defaults to '' and
    ``owner_user_id`` stays NULL until claimed by the first authenticated user.
    """
    session.execute(
        text(
            """
            INSERT INTO workspaces (tracking_id, created_at, updated_at)
            VALUES (:thread_id, NOW(), NOW())
            ON CONFLICT (tracking_id) DO NOTHING
            """
        ),
        {"thread_id": thread_id},
    )


class PostgresConversationHistory:
    """Conversation and thread metadata storage backed by PostgreSQL."""

    def create_conversation(self) -> str:
        thread_id = str(uuid.uuid4())
        with get_session() as session:
            _ensure_thread(session, thread_id)
        return thread_id

    def add_message(
        self,
        thread_id: str,
        role: str,
        content: str,
        tool_calls=None,
        tool_call_id=None,
    ) -> None:
        with get_session() as session:
            _ensure_thread(session, thread_id)
            session.execute(
                text(
                    """
                    INSERT INTO agent_messages (
                        tracking_id, role, content, tool_calls, tool_call_id, created_at
                    )
                    VALUES (
                        :thread_id, :role, :content, CAST(:tool_calls AS jsonb), :tool_call_id, NOW()
                    )
                    """
                ),
                {
                    "thread_id": thread_id,
                    "role": role,
                    "content": content,
                    "tool_calls": _dump(tool_calls) if tool_calls else None,
                    "tool_call_id": tool_call_id,
                },
            )
            session.execute(
                text("UPDATE workspaces SET updated_at = NOW() WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            )

    def get_messages(self, thread_id: str) -> list[dict[str, Any]]:
        with get_session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT role, content, tool_calls, tool_call_id
                    FROM agent_messages
                    WHERE tracking_id = :thread_id
                    ORDER BY id
                    """
                ),
                {"thread_id": thread_id},
            ).fetchall()

        messages: list[dict[str, Any]] = []
        for row in rows:
            data = row._mapping
            msg: dict[str, Any] = {"role": data["role"], "content": data["content"] or ""}
            tool_calls = _json(data.get("tool_calls"), None)
            if tool_calls:
                msg["tool_calls"] = tool_calls
            if data.get("tool_call_id"):
                msg["tool_call_id"] = data["tool_call_id"]
            messages.append(msg)
        return messages

    def clear_conversation(self, thread_id: str) -> None:
        with get_session() as session:
            session.execute(
                text("DELETE FROM agent_messages WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            )

    def delete_conversation(self, thread_id: str) -> None:
        """Delete the workspace for this tracking id (agent history cascades)."""
        with get_session() as session:
            session.execute(
                text("DELETE FROM workspaces WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            )

    def save_agent_session(self, thread_id: str, messages: list[dict[str, Any]]) -> None:
        non_system = [m for m in messages if m.get("role") != "system"]
        if not non_system:
            return
        with get_session() as session:
            _ensure_thread(session, thread_id)
            session.execute(
                text(
                    """
                    INSERT INTO agent_session_snapshots (tracking_id, messages_json, created_at)
                    VALUES (:thread_id, CAST(:messages_json AS jsonb), NOW())
                    """
                ),
                {"thread_id": thread_id, "messages_json": _dump(non_system)},
            )
            session.execute(
                text("UPDATE workspaces SET updated_at = NOW() WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            )

    def load_prior_agent_messages(self, thread_id: str, max_messages: int = 40) -> list[dict[str, Any]]:
        with get_session() as session:
            row = session.execute(
                text(
                    """
                    SELECT messages_json
                    FROM agent_session_snapshots
                    WHERE tracking_id = :thread_id
                    ORDER BY id DESC
                    LIMIT 1
                    """
                ),
                {"thread_id": thread_id},
            ).fetchone()
        if not row:
            return []

        messages = _json(row._mapping["messages_json"], [])
        if not isinstance(messages, list):
            return []

        recent = messages[-max_messages:]
        start = 0
        while start < len(recent) and recent[start].get("role") == "tool":
            start += 1

        while start < len(recent):
            msg = recent[start]
            if msg.get("role") == "assistant" and msg.get("tool_calls"):
                expected_ids = {tc["id"] for tc in msg["tool_calls"]}
                j = start + 1
                found_ids: set[str] = set()
                while j < len(recent) and recent[j].get("role") == "tool":
                    found_ids.add(recent[j].get("tool_call_id", ""))
                    j += 1
                if expected_ids <= found_ids:
                    break
                start = j
            else:
                break

        return recent[start:]

    # ── Thread ownership (multi-user) ─────────────────────────────

    def get_thread_user(self, thread_id: str) -> str | None:
        """Owner of the workspace as a string, or None if it doesn't exist or has
        not been claimed yet (agent-created, owner still NULL)."""
        with get_session() as session:
            row = session.execute(
                text("SELECT owner_user_id FROM workspaces WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            ).fetchone()
        if not row:
            return None
        owner = row._mapping["owner_user_id"]
        return str(owner) if owner is not None else None

    def thread_exists(self, thread_id: str) -> bool:
        with get_session() as session:
            row = session.execute(
                text("SELECT 1 FROM workspaces WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            ).fetchone()
        return row is not None

    def claim_thread(self, thread_id: str, user_id: str) -> str:
        """
        Atomically create the workspace owned by user_id, or claim an unowned
        (agent-created) workspace. Returns the EFFECTIVE owner as a string — if it
        differs from user_id, the workspace belongs to someone else and the caller
        must reject the request.
        """
        with get_session() as session:
            row = session.execute(
                text(
                    """
                    INSERT INTO workspaces (tracking_id, owner_user_id, created_at, updated_at)
                    VALUES (:thread_id, CAST(:user_id AS INTEGER), NOW(), NOW())
                    ON CONFLICT (tracking_id) DO UPDATE
                        SET owner_user_id = COALESCE(workspaces.owner_user_id, EXCLUDED.owner_user_id),
                            updated_at = NOW()
                    RETURNING owner_user_id
                    """
                ),
                {"thread_id": thread_id, "user_id": user_id},
            ).fetchone()
        owner = row._mapping["owner_user_id"]
        return str(owner) if owner is not None else user_id

    def save_workspace_path(self, thread_id: str, workspace_path: str) -> None:
        with get_session() as session:
            _ensure_thread(session, thread_id)
            session.execute(
                text(
                    """
                    UPDATE workspaces
                    SET local_fs_path = :workspace_path, updated_at = NOW()
                    WHERE tracking_id = :thread_id
                    """
                ),
                {"workspace_path": workspace_path, "thread_id": thread_id},
            )

    def get_workspace_path(self, thread_id: str) -> str | None:
        with get_session() as session:
            row = session.execute(
                text("SELECT local_fs_path FROM workspaces WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            ).fetchone()
        return row._mapping["local_fs_path"] if row else None

    def list_threads(self) -> list[dict[str, Any]]:
        with get_session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT tracking_id AS id, local_fs_path AS workspace_path, created_at, updated_at
                    FROM workspaces
                    ORDER BY updated_at DESC
                    """
                )
            ).fetchall()
        return [dict(row._mapping) for row in rows]


class PostgresRunStateStore:
    """
    Partial-run state (stop → resume) persisted to PostgreSQL.

    Replaces the in-process dict inside StopRegistry so that:
      - a stopped run survives a server restart, and
      - /resume works on ANY worker/replica, not just the process
        that handled the original /stream.

    Stores plain dicts (JSON); StopRegistry converts RunState <-> dict.
    """

    def save(self, thread_id: str, state: dict[str, Any]) -> None:
        with get_session() as session:
            _ensure_thread(session, thread_id)
            session.execute(
                text(
                    """
                    INSERT INTO run_states (tracking_id, state, created_at, updated_at)
                    VALUES (:thread_id, CAST(:state AS jsonb), NOW(), NOW())
                    ON CONFLICT (tracking_id) DO UPDATE
                        SET state = EXCLUDED.state, updated_at = NOW()
                    """
                ),
                {"thread_id": thread_id, "state": _dump(state)},
            )

    def peek(self, thread_id: str) -> dict[str, Any] | None:
        with get_session() as session:
            row = session.execute(
                text("SELECT state FROM run_states WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            ).fetchone()
        if not row:
            return None
        return _json(row._mapping["state"], None)

    def consume(self, thread_id: str) -> dict[str, Any] | None:
        """Atomically fetch AND delete — the same state can't be resumed twice,
        even if two /resume calls race on different workers."""
        with get_session() as session:
            row = session.execute(
                text(
                    """
                    DELETE FROM run_states
                    WHERE tracking_id = :thread_id
                    RETURNING state
                    """
                ),
                {"thread_id": thread_id},
            ).fetchone()
        if not row:
            return None
        return _json(row._mapping["state"], None)

    def clear(self, thread_id: str) -> None:
        with get_session() as session:
            session.execute(
                text("DELETE FROM run_states WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            )

    def exists(self, thread_id: str) -> bool:
        with get_session() as session:
            row = session.execute(
                text("SELECT 1 FROM run_states WHERE tracking_id = :thread_id"),
                {"thread_id": thread_id},
            ).fetchone()
        return row is not None


class PostgresAgentCheckpointStore:
    """
    Per-agent checkpoints (crash/restart resume) persisted to PostgreSQL.

    Complements PostgresRunStateStore rather than replacing it: run_states is
    `tracking_id PRIMARY KEY`, one row per workspace, which cannot represent a
    fan-out where a parent and N sub-agents are each mid-flight. This table is
    keyed (thread_id, agent_id), so every agent in a run gets its own row and a
    resume can re-run only the branches that never finished.

    Files under .devaccel/{thread}/tmp/ remain the fast in-run cache; this is
    the durable record that survives a pod restart or a second replica.
    """

    def save(
        self,
        thread_id: str,
        agent_id: str,
        messages: list[dict[str, Any]],
        *,
        status: str = "running",
        parent_agent_id: str | None = None,
        role: str = "",
        task: str = "",
        usage: dict[str, Any] | None = None,
        steps_taken: int = 0,
    ) -> None:
        with get_session() as session:
            _ensure_thread(session, thread_id)
            session.execute(
                text(
                    """
                    INSERT INTO agent_checkpoints (
                        tracking_id, thread_id, agent_id, parent_agent_id,
                        role, task, status, messages_json, usage, steps_taken,
                        created_at, updated_at
                    )
                    VALUES (
                        :thread_id, :thread_id, :agent_id, :parent_agent_id,
                        :role, :task, :status, CAST(:messages AS jsonb),
                        CAST(:usage AS jsonb), :steps_taken, NOW(), NOW()
                    )
                    ON CONFLICT (thread_id, agent_id) DO UPDATE SET
                        status        = EXCLUDED.status,
                        messages_json = EXCLUDED.messages_json,
                        usage         = EXCLUDED.usage,
                        steps_taken   = EXCLUDED.steps_taken,
                        updated_at    = NOW()
                    """
                ),
                {
                    "thread_id": thread_id,
                    "agent_id": agent_id,
                    "parent_agent_id": parent_agent_id,
                    "role": role,
                    "task": task[:2000],
                    "status": status,
                    "messages": _dump(messages),
                    "usage": _dump(usage or {}),
                    "steps_taken": steps_taken,
                },
            )

    def load(self, thread_id: str, agent_id: str) -> dict[str, Any] | None:
        with get_session() as session:
            row = session.execute(
                text(
                    """
                    SELECT agent_id, parent_agent_id, role, task, status,
                           messages_json, usage, steps_taken
                    FROM agent_checkpoints
                    WHERE thread_id = :thread_id AND agent_id = :agent_id
                    """
                ),
                {"thread_id": thread_id, "agent_id": agent_id},
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def list_unfinished(self, thread_id: str) -> list[dict[str, Any]]:
        """Agents that never reached a terminal state — what a resume re-runs."""
        with get_session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT agent_id, parent_agent_id, role, task, status,
                           messages_json, usage, steps_taken
                    FROM agent_checkpoints
                    WHERE thread_id = :thread_id
                      AND status NOT IN ('done', 'unverified')
                    ORDER BY updated_at DESC
                    """
                ),
                {"thread_id": thread_id},
            ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def clear(self, thread_id: str) -> None:
        """Drop a thread's checkpoints — called when a run completes on its own."""
        with get_session() as session:
            session.execute(
                text("DELETE FROM agent_checkpoints WHERE thread_id = :thread_id"),
                {"thread_id": thread_id},
            )

    @staticmethod
    def _row_to_dict(row) -> dict[str, Any]:
        m = row._mapping
        return {
            "agent_id": m["agent_id"],
            "parent_agent_id": m["parent_agent_id"],
            "role": m["role"] or "",
            "task": m["task"] or "",
            "status": m["status"],
            "messages": _json(m["messages_json"], []),
            "usage": _json(m["usage"], {}),
            "steps_taken": m["steps_taken"] or 0,
        }


class PostgresLongTermMemory:
    """Long-term memory scoped to one workspace tracking id."""

    def __init__(self, thread_id: str):
        self.thread_id = thread_id

    def load(self) -> list[dict[str, Any]]:
        with get_session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT content, tags, created_at
                    FROM long_term_memory
                    WHERE tracking_id = :thread_id
                    ORDER BY id
                    """
                ),
                {"thread_id": self.thread_id},
            ).fetchall()
        return [
            {
                "content": row._mapping["content"],
                "tags": _json(row._mapping["tags"], []),
                "created_at": _iso(row._mapping["created_at"]),
            }
            for row in rows
        ]

    def add(self, content: str, tags=None) -> None:
        with get_session() as session:
            _ensure_thread(session, self.thread_id)
            session.execute(
                text(
                    """
                    INSERT INTO long_term_memory (tracking_id, content, tags, created_at)
                    VALUES (:thread_id, :content, CAST(:tags AS jsonb), NOW())
                    """
                ),
                {"thread_id": self.thread_id, "content": content, "tags": _dump(tags or [])},
            )

    def search(self, tag: str) -> list[dict[str, Any]]:
        return [memory for memory in self.load() if tag in memory.get("tags", [])]

    def save_all(self, memories: list[dict[str, Any]]) -> None:
        with get_session() as session:
            _ensure_thread(session, self.thread_id)
            session.execute(
                text("DELETE FROM long_term_memory WHERE tracking_id = :thread_id"),
                {"thread_id": self.thread_id},
            )
            for memory in memories:
                session.execute(
                    text(
                        """
                        INSERT INTO long_term_memory (
                            tracking_id, content, tags, created_at
                        )
                        VALUES (
                            :thread_id, :content, CAST(:tags AS jsonb), :created_at
                        )
                        """
                    ),
                    {
                        "thread_id": self.thread_id,
                        "content": memory["content"],
                        "tags": _dump(memory.get("tags", [])),
                        "created_at": memory.get("created_at", datetime.now(timezone.utc).isoformat()),
                    },
                )


def _as_int_user_id(user_id: Any) -> int | None:
    """`router/auth.py` hands out user ids as strings, and in `api_key` /
    `disabled` auth modes they aren't numeric at all ('local-user'). Usage from
    such a caller is still recorded — just not attributed to a `users` row,
    which is honest rather than crashing the run over an accounting detail."""
    try:
        return int(user_id)
    except (TypeError, ValueError):
        return None


class PostgresTokenTracker:
    """Per-thread token usage tracking backed by PostgreSQL.

    The tracker also carries WHO the run belongs to. That is the whole reason
    this class grew arguments: `token_usage` was keyed only by `tracking_id`,
    so it could say what a workspace consumed but never what a person did — the
    one question a quota has to answer.
    """

    def __init__(
        self,
        thread_id: str = GLOBAL_THREAD_ID,
        user_id: Any = None,
        run_id: str | None = None,
        model_config=None,
        agent_id: str | None = None,
        is_subagent: bool = False,
    ):
        self.thread_id = thread_id
        self.user_id = _as_int_user_id(user_id)
        self.run_id = run_id
        self.model_config = model_config
        self.agent_id = agent_id
        self.is_subagent = is_subagent

    def _cost(self, prompt: int, completion: int, cached: int) -> float:
        if self.model_config is None:
            return 0.0
        try:
            return float(self.model_config.cost_usd(prompt, completion, cached))
        except Exception:  # noqa: BLE001 — pricing must never fail a run
            return 0.0

    def _write(self, params: dict[str, Any]) -> None:
        """Detail row + rollup, in ONE transaction so the two can never
        disagree. The rollup exists because quotas are re-checked at every
        agent step: against `token_usage` that is a SUM over a growing table on
        every LLM call, against `token_usage_daily` it is one PK lookup."""
        with get_session() as session:
            _ensure_thread(session, self.thread_id)
            session.execute(
                text(
                    """
                    INSERT INTO token_usage (
                        tracking_id, model, prompt_tokens, completion_tokens, total_tokens,
                        cached_tokens, reasoning_tokens, cost_usd,
                        user_id, run_id, agent_id, is_subagent, model_config_id, created_at
                    )
                    VALUES (
                        :thread_id, :model, :prompt_tokens, :completion_tokens, :total_tokens,
                        :cached_tokens, :reasoning_tokens, :cost_usd,
                        :user_id, :run_id, :agent_id, :is_subagent, :model_config_id, NOW()
                    )
                    """
                ),
                params,
            )

            if params.get("user_id") is not None:
                session.execute(
                    text(
                        """
                        INSERT INTO token_usage_daily (
                            user_id, usage_date, prompt_tokens, completion_tokens,
                            cached_tokens, total_tokens, cost_usd, request_count, updated_at
                        )
                        VALUES (
                            :user_id, CURRENT_DATE, :prompt_tokens, :completion_tokens,
                            :cached_tokens, :total_tokens, :cost_usd, 1, NOW()
                        )
                        ON CONFLICT (user_id, usage_date) DO UPDATE SET
                            prompt_tokens     = token_usage_daily.prompt_tokens + EXCLUDED.prompt_tokens,
                            completion_tokens = token_usage_daily.completion_tokens + EXCLUDED.completion_tokens,
                            cached_tokens     = token_usage_daily.cached_tokens + EXCLUDED.cached_tokens,
                            total_tokens      = token_usage_daily.total_tokens + EXCLUDED.total_tokens,
                            cost_usd          = token_usage_daily.cost_usd + EXCLUDED.cost_usd,
                            request_count     = token_usage_daily.request_count + 1,
                            updated_at        = NOW()
                        """
                    ),
                    params,
                )

    def record_usage(
        self,
        raw_usage: dict,
        model: str = "unknown",
        agent_id: str | None = None,
        is_subagent: bool | None = None,
    ) -> TokenUsage:
        prompt = int(raw_usage.get("prompt_tokens", 0) or 0)
        completion = int(raw_usage.get("completion_tokens", 0) or 0)
        total = int(raw_usage.get("total_tokens", prompt + completion) or 0)
        cached = cached_tokens_from(raw_usage)
        reasoning = reasoning_tokens_from(raw_usage)
        cost = self._cost(prompt, completion, cached)

        params = {
            "thread_id": self.thread_id,
            "model": model,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
            "cached_tokens": cached,
            "reasoning_tokens": reasoning,
            "cost_usd": cost,
            "user_id": self.user_id,
            "run_id": self.run_id,
            "agent_id": agent_id or self.agent_id,
            "is_subagent": self.is_subagent if is_subagent is None else is_subagent,
            "model_config_id": getattr(self.model_config, "id", None),
        }

        # Accounting must never cost a user their run.
        #
        # This write now carries a FK to `users`, so it has failure modes the
        # old tracking_id-only insert didn't: a token minted for a user who has
        # since been deleted, a model row removed mid-run. Those are worth a
        # log line and a lost ledger entry — they are not worth aborting work
        # the user is in the middle of, which is what an exception here would
        # do (it propagates through the agent loop's usage accumulator).
        try:
            self._write(params)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Token usage not recorded for thread %s (user=%s): %s",
                self.thread_id, self.user_id, exc,
            )

        return TokenUsage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=total,
            cached_tokens=cached,
            reasoning_tokens=reasoning,
            cost_usd=cost,
            model=model,
        )

    def get_total(self) -> dict[str, int]:
        with get_session() as session:
            row = session.execute(
                text(
                    """
                    SELECT
                        COALESCE(SUM(prompt_tokens), 0) AS prompt,
                        COALESCE(SUM(completion_tokens), 0) AS completion,
                        COALESCE(SUM(total_tokens), 0) AS total,
                        COALESCE(SUM(cached_tokens), 0) AS cached,
                        COALESCE(SUM(cost_usd), 0) AS cost,
                        COUNT(*) AS request_count
                    FROM token_usage
                    WHERE tracking_id = :thread_id
                    """
                ),
                {"thread_id": self.thread_id},
            ).fetchone()
        data = row._mapping
        return {
            "prompt_tokens": int(data["prompt"] or 0),
            "completion_tokens": int(data["completion"] or 0),
            "total_tokens": int(data["total"] or 0),
            "cached_tokens": int(data["cached"] or 0),
            "cost_usd": float(data["cost"] or 0),
            "request_count": int(data["request_count"] or 0),
        }

    def get_history(self) -> list[dict[str, Any]]:
        with get_session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT model, prompt_tokens, completion_tokens, total_tokens,
                           cached_tokens, cost_usd, created_at
                    FROM token_usage
                    WHERE tracking_id = :thread_id
                    ORDER BY id
                    """
                ),
                {"thread_id": self.thread_id},
            ).fetchall()
        return [dict(row._mapping) for row in rows]


class PostgresTokenTrackerStore:
    """Registry that creates per-thread PostgreSQL token trackers."""

    def __init__(self):
        self._global = PostgresTokenTracker(GLOBAL_THREAD_ID)

    def get(
        self,
        thread_id: str,
        user_id: Any = None,
        run_id: str | None = None,
        model_config=None,
    ):
        """A tracker for one run.

        `user_id`, `run_id` and `model_config` are optional so every existing
        caller keeps working unchanged — they just record usage that isn't
        attributed to a person or priced, exactly as before.
        """
        return _DualPostgresTracker(
            PostgresTokenTracker(
                thread_id, user_id=user_id, run_id=run_id, model_config=model_config
            ),
            self._global,
        )

    def get_thread_total(self, thread_id: str) -> dict[str, int]:
        return PostgresTokenTracker(thread_id).get_total()

    def get_global_total(self) -> dict[str, int]:
        return self._global.get_total()

    def get_global_history(self) -> list[dict[str, Any]]:
        return self._global.get_history()


class _DualPostgresTracker:
    """Records usage to a thread tracker and the shared global tracker."""

    def __init__(self, thread_tracker: PostgresTokenTracker, global_tracker: PostgresTokenTracker):
        self._thread = thread_tracker
        self._global = global_tracker

    @property
    def user_id(self) -> int | None:
        return self._thread.user_id

    @property
    def model_config(self):
        return self._thread.model_config

    def record_usage(
        self,
        raw_usage: dict,
        model: str = "unknown",
        agent_id: str | None = None,
        is_subagent: bool | None = None,
    ) -> TokenUsage:
        if self._thread.thread_id != self._global.thread_id:
            # The '__global__' mirror is a process-wide total, not a per-user
            # ledger — attributing it to a user would double-count them in the
            # rollup and silently halve everyone's quota.
            self._global.record_usage(raw_usage, model=model)
        return self._thread.record_usage(
            raw_usage, model=model, agent_id=agent_id, is_subagent=is_subagent
        )

    def get_total(self) -> dict[str, int]:
        return self._thread.get_total()

    def get_history(self) -> list[dict[str, Any]]:
        return self._thread.get_history()
