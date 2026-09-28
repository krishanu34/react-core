"""
Agent checkpoints — resume a run instead of restarting it.

Every agent (the top-level one and each sub-agent) writes its progress after
each step. If the process dies — a pod restart, an OOM kill, a deploy — the run
picks up from the last checkpoint rather than redoing work the user already
paid for.

TWO TIERS, deliberately not interchangeable:

  file  .devaccel/{thread}/tmp/{agent_id}/checkpoint.json
        Written every step. Cheap, local, no round-trip. Lives on the backend
        pod's EPHEMERAL disk, so it survives a crash of the PROCESS but not of
        the POD, and a second replica cannot see it.

  DB    agent_checkpoints (db/migrations/004_agent_context.sql)
        Written at a coarser interval and ALWAYS on a terminal state. Survives
        pod restarts and is readable from any replica — which is what makes
        this work on AKS at all.

Writing to the DB every step would put a network round-trip in the hot loop for
no benefit, so the file is the working record and the DB is the durable one.
Both are best-effort: checkpointing must never be the thing that breaks a run.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

from agents.workspace_paths import ThreadWorkspace
from utils.logger import get_logger

log = get_logger(__name__)

# The top-level agent's id. Children use the id SubAgentTool generates.
ROOT_AGENT_ID = "__root__"

# Flush to the database at most this often per agent (seconds). Terminal states
# always flush regardless.
DB_FLUSH_INTERVAL_SECONDS = float(os.getenv("CHECKPOINT_DB_INTERVAL", "20"))

# Statuses that mean "this agent is finished" — always flushed, and excluded
# from the unfinished set a resume re-runs.
TERMINAL_STATUSES = {"done", "unverified", "failed", "stopped"}

_last_db_flush: dict[str, float] = {}
_store = None
_store_tried = False

# Circuit breaker. If the database is unreachable, get_session() blocks for the
# connect timeout — and a checkpoint sits in the agent's hot loop, so every step
# would pay that. After this many consecutive failures we stop trying and run
# file-only; the files still make a run resumable within a live pod.
_DB_FAILURE_LIMIT = int(os.getenv("CHECKPOINT_DB_FAILURE_LIMIT", "3"))
_db_failures = 0
_db_disabled = False


def _db_store():
    """The Postgres store, or None when no database is configured/reachable.

    Resolved lazily and cached: a file-only deployment must keep working
    exactly as before, the way StopRegistry already degrades to in-memory.
    """
    global _store, _store_tried
    if _db_disabled:
        return None
    if _store_tried:
        return _store
    _store_tried = True
    try:
        from persistence.postgres_agent import PostgresAgentCheckpointStore
        _store = PostgresAgentCheckpointStore()
    except Exception as e:  # noqa: BLE001 — no DB is a supported configuration
        log.info(f"Agent checkpoints: database unavailable, using files only ({e})")
        _store = None
    return _store


def _note_db_failure(exc: Exception) -> None:
    global _db_failures, _db_disabled
    _db_failures += 1
    if _db_failures >= _DB_FAILURE_LIMIT and not _db_disabled:
        _db_disabled = True
        log.warning(
            f"Agent checkpoints: database failed {_db_failures}× "
            f"({type(exc).__name__}) — falling back to file-only checkpoints. "
            f"Runs stay resumable within this pod but not across a restart."
        )


def _note_db_success() -> None:
    global _db_failures
    _db_failures = 0


def reset_db_circuit() -> None:
    """Re-enable DB checkpointing (tests, or after an operator fixes the DB)."""
    global _db_failures, _db_disabled, _store, _store_tried
    _db_failures = 0
    _db_disabled = False
    _store = None
    _store_tried = False


def root_thread(thread_id: str) -> str:
    """
    The run's root thread id.

    Sub-agents run under a DERIVED thread ("root::sub::<agent_id>") so their
    tool state — read tracker, task list, permission approvals — is isolated
    from their siblings (see tools/sub_agent_tool.py). Checkpoints must NOT be
    partitioned that way: a resume has to enumerate every agent in the run from
    one place, and agent_id already tells them apart. So all checkpoints for a
    run live under the root.
    """
    return (thread_id or "default").split("::sub::")[0]


def _agent_dir(thread_id: str, agent_id: str) -> Path:
    safe = "".join(c for c in agent_id if c.isalnum() or c in "-_")[:80] or "agent"
    path = Path(ThreadWorkspace.for_thread(root_thread(thread_id)).tmp_dir) / safe
    path.mkdir(parents=True, exist_ok=True)
    return path


def save(
    thread_id: str,
    agent_id: str,
    messages: list,
    *,
    status: str = "running",
    parent_agent_id: Optional[str] = None,
    role: str = "",
    task: str = "",
    usage: Optional[dict] = None,
    steps_taken: int = 0,
) -> None:
    """Checkpoint one agent. Always writes the file; flushes to the DB on the
    interval or on a terminal status."""
    payload: dict[str, Any] = {
        "agent_id": agent_id,
        "parent_agent_id": parent_agent_id,
        "role": role,
        "task": task,
        "status": status,
        "messages": messages,
        "usage": usage or {},
        "steps_taken": steps_taken,
        "saved_at": time.time(),
    }

    try:
        path = _agent_dir(thread_id, agent_id) / "checkpoint.json"
        # Write-then-rename: a crash mid-write must not leave a truncated file
        # that makes the run UNresumable — the exact failure this exists to fix.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(path)
    except Exception as e:  # noqa: BLE001
        log.debug(f"Checkpoint file write skipped ({agent_id}): {e}")

    terminal = status in TERMINAL_STATUSES
    key = f"{root_thread(thread_id)}:{agent_id}"
    due = time.time() - _last_db_flush.get(key, 0.0) >= DB_FLUSH_INTERVAL_SECONDS
    if not (terminal or due):
        return

    def _flush() -> None:
        """The blocking part: connect + write. Runs off the event loop."""
        store = _db_store()
        if store is None:
            return
        try:
            store.save(
                root_thread(thread_id), agent_id, messages,
                status=status, parent_agent_id=parent_agent_id, role=role,
                task=task, usage=usage or {}, steps_taken=steps_taken,
            )
            _last_db_flush[key] = time.time()
            _note_db_success()
        except Exception as e:  # noqa: BLE001
            log.debug(f"Checkpoint DB flush skipped ({agent_id}): {e}")
            _note_db_failure(e)

    # NEVER block the event loop on the database. This is called from inside the
    # agent loop after every step; an unreachable DB takes the full connect
    # timeout, and doing that inline froze EVERY concurrently running sub-agent
    # for its duration — the file checkpoint above is already durable, so the DB
    # flush is strictly an extra and must never gate progress.
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None          # sync caller (CLI, tests) — inline is correct

    if loop is None:
        _flush()
    else:
        # Fire-and-forget: _flush swallows its own errors and drives the circuit
        # breaker, so nothing is lost by not awaiting it.
        loop.run_in_executor(None, _flush)


def load(thread_id: str, agent_id: str = ROOT_AGENT_ID) -> Optional[dict]:
    """
    The newest checkpoint for one agent, file first then database.

    File first because it is strictly fresher when present (written every step
    vs. every interval). The DB is the fallback that covers the case the file
    cannot: the pod that wrote it is gone.
    """
    try:
        path = _agent_dir(thread_id, agent_id) / "checkpoint.json"
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        log.debug(f"Checkpoint file read failed ({agent_id}): {e}")

    store = _db_store()
    if store is None:
        return None
    try:
        result = store.load(root_thread(thread_id), agent_id)
        _note_db_success()
        return result
    except Exception as e:  # noqa: BLE001
        log.debug(f"Checkpoint DB read failed ({agent_id}): {e}")
        _note_db_failure(e)
        return None


def unfinished_agents(thread_id: str) -> list:
    """Sub-agents that never reached a terminal state — what a resume re-runs.

    A completed child must NOT be re-run: its work is already on disk and
    redoing it would duplicate edits.
    """
    store = _db_store()
    if store is not None:
        try:
            result = store.list_unfinished(root_thread(thread_id))
            _note_db_success()
            return result
        except Exception as e:  # noqa: BLE001
            log.debug(f"Checkpoint DB scan failed: {e}")
            _note_db_failure(e)

    # File fallback — scan the thread's tmp dir.
    out = []
    try:
        base = Path(ThreadWorkspace.for_thread(root_thread(thread_id)).tmp_dir)
        for agent_dir in base.iterdir():
            cp = agent_dir / "checkpoint.json"
            if not cp.is_file():
                continue
            data = json.loads(cp.read_text(encoding="utf-8"))
            if data.get("status") not in TERMINAL_STATUSES:
                out.append(data)
    except Exception as e:  # noqa: BLE001
        log.debug(f"Checkpoint file scan failed: {e}")
    return out


def clear_thread(thread_id: str) -> None:
    """Drop a thread's checkpoints. Called on successful completion only —
    the files go with the tmp dir (context_spill.clear_thread)."""
    root = root_thread(thread_id)
    for key in [k for k in _last_db_flush if k.startswith(f"{root}:")]:
        _last_db_flush.pop(key, None)
    store = _db_store()
    if store is None:
        return
    try:
        store.clear(root_thread(thread_id))
        _note_db_success()
    except Exception as e:  # noqa: BLE001
        log.debug(f"Checkpoint clear skipped: {e}")
        _note_db_failure(e)
