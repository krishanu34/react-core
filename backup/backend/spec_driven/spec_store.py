"""
Spec workflow persistence — PostgreSQL (``spec_workflows``, db/migrations/001_init.sql).

Records where every spec-driven workflow is (feature, phase, status, gate
decisions) so that:
  - the UI can render a progress bar from GET /api/agent/spec/{thread}/status,
  - a workflow paused at a gate can be resumed after a restart,
  - any worker/replica can answer status questions (multi-worker safe).

Design notes:
  - Unified schema: the agent's ``thread_id`` IS a workspace's ``tracking_id``
    (see persistence/postgres_agent.py). The table is ``spec_workflows`` and the
    key column is ``tracking_id``, with an FK into ``workspaces(tracking_id)`` —
    so writes call ``_ensure_thread()`` first, exactly like the agent stores.
    Public method signatures keep the name ``thread_id``; its value is the
    workspace ``tracking_id``.
  - NO runtime DDL. The schema is owned by db/migrations/001_init.sql, applied
    by the postgres container's init hook (or by hand with psql). An app role
    without CREATE on ``public`` is the correct production posture, so trying to
    self-heal here only produced a recurring InsufficientPrivilege warning.
  - Every method is defensive: if the table can't be reached the feature must
    still WORK (files are the user-visible output). Failures are logged ONCE per
    process with an actionable hint, not on every request.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from sqlalchemy import text

from persistence.postgres_agent import _ensure_thread
from workspace_studio.repositories.database import get_session
from utils.logger import get_logger

log = get_logger(__name__)

_MIGRATION_HINT = (
    "spec workflow tracking is disabled for this process — apply the schema with "
    "`psql \"$DATABASE_URL\" -f db/migrations/001_init.sql` "
    "(the spec files in the workspace are still written normally)"
)

# One warning per failing operation per process. Without this the same
# UndefinedTable/InsufficientPrivilege error is logged on every single request
# and drowns out the agent's own log lines.
_warned: set[str] = set()


def _warn_once(operation: str, error: Exception) -> None:
    """Log a store failure once per process, with the fix in the message."""
    if operation in _warned:
        log.debug(f"SpecWorkflowStore.{operation} failed again: {error}")
        return
    _warned.add(operation)
    log.warning(
        f"SpecWorkflowStore.{operation} failed: {error} — {_MIGRATION_HINT}",
        extra={"operation": operation},
    )


class SpecWorkflowStore:

    def upsert(
        self,
        thread_id: str,
        feature_slug: str,
        feature_number: str,
        current_phase: str,
        status: str,
        gates: Optional[dict] = None,
    ) -> None:
        """Create or update the one workflow row per (tracking id, feature)."""
        try:
            with get_session() as session:
                # spec_workflows.tracking_id FKs into workspaces(tracking_id);
                # agent-initiated threads may not have a workspace row yet.
                _ensure_thread(session, thread_id)
                session.execute(
                    text(
                        """
                        INSERT INTO spec_workflows
                            (tracking_id, feature_slug, feature_number,
                             current_phase, status, gates, created_at, updated_at)
                        VALUES
                            (:thread_id, :feature_slug, :feature_number,
                             :current_phase, :status,
                             -- gates is NOT NULL: a missing param means
                             -- "no gates yet" on insert ('{}') and "keep
                             -- the existing gates" on update (COALESCE on
                             -- the PARAM below, not on EXCLUDED — EXCLUDED
                             -- would already be '{}' and wipe decisions).
                             COALESCE(CAST(:gates AS jsonb), '{}'::jsonb),
                             NOW(), NOW())
                        ON CONFLICT (tracking_id, feature_number) DO UPDATE SET
                            current_phase = EXCLUDED.current_phase,
                            status        = EXCLUDED.status,
                            gates         = COALESCE(CAST(:gates AS jsonb), spec_workflows.gates),
                            updated_at    = NOW()
                        """
                    ),
                    {
                        "thread_id": thread_id,
                        "feature_slug": feature_slug,
                        "feature_number": feature_number,
                        "current_phase": current_phase,
                        "status": status,
                        "gates": json.dumps(gates) if gates is not None else None,
                    },
                )
        except Exception as e:
            _warn_once("upsert", e)

    def record_gate(self, thread_id: str, feature_number: str, gate: str, decision: dict) -> None:
        """Merge one gate decision into the gates JSONB."""
        try:
            with get_session() as session:
                session.execute(
                    text(
                        """
                        UPDATE spec_workflows
                        SET gates = gates || CAST(:patch AS jsonb), updated_at = NOW()
                        WHERE tracking_id = :thread_id AND feature_number = :feature_number
                        """
                    ),
                    {
                        "thread_id": thread_id,
                        "feature_number": feature_number,
                        "patch": json.dumps({gate: decision}),
                    },
                )
        except Exception as e:
            _warn_once("record_gate", e)

    def get(self, thread_id: str, feature_number: Optional[str] = None) -> Optional[dict]:
        """Latest workflow for the thread (or a specific feature)."""
        try:
            with get_session() as session:
                if feature_number:
                    row = session.execute(
                        text(
                            """
                            SELECT feature_slug, feature_number, current_phase,
                                   status, gates, created_at, updated_at
                            FROM spec_workflows
                            WHERE tracking_id = :thread_id AND feature_number = :feature_number
                            """
                        ),
                        {"thread_id": thread_id, "feature_number": feature_number},
                    ).fetchone()
                else:
                    row = session.execute(
                        text(
                            """
                            SELECT feature_slug, feature_number, current_phase,
                                   status, gates, created_at, updated_at
                            FROM spec_workflows
                            WHERE tracking_id = :thread_id
                            ORDER BY id DESC LIMIT 1
                            """
                        ),
                        {"thread_id": thread_id},
                    ).fetchone()
            if not row:
                return None
            data: dict[str, Any] = dict(row._mapping)
            if isinstance(data.get("gates"), str):
                data["gates"] = json.loads(data["gates"])
            for key in ("created_at", "updated_at"):
                if data.get(key) is not None and hasattr(data[key], "isoformat"):
                    data[key] = data[key].isoformat()
            return data
        except Exception as e:
            _warn_once("get", e)
            return None

    def next_feature_number(self, thread_id: str) -> str:
        """Fallback numbering when the workspace can't be scanned server-side
        (Pattern C client workspaces): count this thread's workflows."""
        try:
            with get_session() as session:
                row = session.execute(
                    text(
                        "SELECT COUNT(*) AS n FROM spec_workflows "
                        "WHERE tracking_id = :thread_id"
                    ),
                    {"thread_id": thread_id},
                ).fetchone()
            return f"{int(row._mapping['n']) + 1:03d}"
        except Exception as e:
            _warn_once("next_feature_number", e)
            return "001"
