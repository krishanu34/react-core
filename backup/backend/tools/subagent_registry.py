"""
Background sub-agent registry — spawn without blocking the parent.

A foreground spawn holds the parent's tool-call step until the child returns.
That serialises the parent behind its slowest child even when it has useful work
left, and it is why a wide fan-out felt like a stall: the parent had nothing to
say for minutes because it was structurally unable to proceed.

A background spawn returns immediately with an agent id. The child runs as its
own task; when it finishes, its report is queued here and injected into the
parent's next turn as a completion notification. The parent keeps working in
between.

The one invariant that makes this safe: a run NEVER finishes with children still
in flight. `pending()` gates the parent's natural exit, so a background child's
work can't be silently dropped when the parent decides it's done. (This mirrors
Claude Code, where a background subagent's results reach the model as a
completion notification in a later turn, and the model waits for it before
reporting results.)

SCOPING — this is subtle and was a deadlock the first time round. Children are
keyed by the exact thread id of the agent that SPAWNED them, not by the root of
the conversation. Keying by root means a background child's own agent loop, which
runs the same `pending()` exit gate as its parent, sees ITSELF listed as pending
and waits for itself to finish. `wait_all` then gathers its own task, producing an
unbounded self-await (observed as RecursionError in asyncio's cancellation walk).

Per-spawner keying makes each agent wait only for the children it created, and
transitivity covers the whole tree: the root waits for its child, which waits for
its own grandchildren before returning. Cancellation is the one operation that
deliberately spans the whole lineage — see `cancel_all`.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from utils.logger import get_logger

log = get_logger(__name__)


def _key(thread_id: str) -> str:
    """Bucket for one spawner. Exact thread id — see SCOPING in the module docstring."""
    return thread_id or "default"


def _lineage_keys(thread_id: str) -> list[str]:
    """Every bucket at or below `thread_id` — this agent and its descendants."""
    root = _key(thread_id)
    prefix = root + "::sub::"
    return [k for k in _entries if k == root or k.startswith(prefix)]


class _Entry:
    """One background child: its task while running, its report once done."""

    __slots__ = ("agent_id", "role", "task_text", "task", "report", "delivered")

    def __init__(self, agent_id: str, role: str, task_text: str, task: asyncio.Task):
        self.agent_id = agent_id
        self.role = role
        self.task_text = task_text
        self.task = task
        self.report: Optional[dict] = None
        self.delivered = False


# spawner thread id → {agent_id: _Entry}. NOT keyed by root — see SCOPING above.
_entries: dict[str, dict[str, _Entry]] = {}


def register(thread_id: str, agent_id: str, role: str, task_text: str,
             task: asyncio.Task) -> None:
    """Track a child that is now running in the background."""
    _entries.setdefault(_key(thread_id), {})[agent_id] = _Entry(agent_id, role, task_text, task)
    log.info(f"Background subagent registered: {agent_id} (role={role})")


def record_result(thread_id: str, agent_id: str, report: dict) -> None:
    """Store a finished child's report, pending delivery to the parent."""
    entry = _entries.get(_key(thread_id), {}).get(agent_id)
    if entry is not None:
        entry.report = report


def pending(thread_id: str) -> list[str]:
    """Agent ids still running. The parent must not finish while non-empty."""
    bucket = _entries.get(_key(thread_id), {})
    return [aid for aid, e in bucket.items() if not e.task.done()]


def undelivered(thread_id: str) -> list[str]:
    """Finished children whose report the parent hasn't been told about yet."""
    bucket = _entries.get(_key(thread_id), {})
    return [
        aid for aid, e in bucket.items()
        if e.task.done() and not e.delivered
    ]


def drain(thread_id: str) -> list[dict]:
    """
    Take every finished-but-undelivered report, marking them delivered.

    Returns a list of {agent_id, role, task, report} ready to be rendered into
    the parent's message history. Called once per loop iteration, so a child that
    finishes mid-turn is picked up on the next one.
    """
    bucket = _entries.get(_key(thread_id), {})
    out: list[dict] = []

    for entry in bucket.values():
        if not entry.task.done() or entry.delivered:
            continue
        entry.delivered = True

        report = entry.report
        if report is None:
            # The task finished without recording a report — surface the
            # exception rather than pretending the child succeeded.
            exc = None
            try:
                exc = entry.task.exception()
            except asyncio.CancelledError:
                exc = asyncio.CancelledError("cancelled")
            except Exception:  # noqa: BLE001 — defensive
                exc = None
            report = {
                "status": "error",
                "summary": (
                    f"{type(exc).__name__}: {exc}" if exc
                    else "The background agent ended without producing a report."
                ),
                "files_changed": [], "findings": [], "follow_ups": [],
                "verification": [],
            }

        out.append({
            "agent_id": entry.agent_id,
            "role": entry.role,
            "task": entry.task_text,
            "report": report,
        })

    return out


async def wait_all(thread_id: str, timeout: float = 600.0, should_stop=None) -> None:
    """
    Block until every background child of this run has finished.

    Called before the parent's natural exit. A timeout does NOT raise: the
    parent still reports what it has, and `drain()` will surface whatever those
    children did manage to record, so a hung child degrades the answer rather
    than losing the whole run.

    `should_stop` is polled while waiting. Without it, pressing Stop did nothing
    until the slowest child finished on its own — the parent was parked here and
    never got back to its own stop check, so a Stop during a long fan-out felt
    ignored.
    """
    tasks = [e.task for e in _entries.get(_key(thread_id), {}).values()
             if not e.task.done()]
    if not tasks:
        return
    log.info(f"Waiting on {len(tasks)} background subagent(s) before finishing")

    gathered = asyncio.gather(*tasks, return_exceptions=True)

    if should_stop is None:
        try:
            await asyncio.wait_for(gathered, timeout)
        except asyncio.TimeoutError:
            log.warning(
                f"{len([t for t in tasks if not t.done()])} background "
                f"subagent(s) did not finish within {timeout}s"
            )
        return

    # Poll in slices so a Stop is noticed promptly rather than at the end.
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        if should_stop():
            log.info("Stop requested while waiting on background subagents")
            await cancel_all(thread_id)
            return
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            log.warning(
                f"{len([t for t in tasks if not t.done()])} background "
                f"subagent(s) did not finish within {timeout}s"
            )
            return
        try:
            await asyncio.wait_for(asyncio.shield(gathered), min(0.1, remaining))
            return
        except asyncio.TimeoutError:
            continue


async def cancel_all(thread_id: str) -> None:
    """Stop every background child — the user pressed stop, or the run failed."""
    # Cancellation spans the WHOLE lineage: cancelling a child interrupts it
    # mid-await, so its own background grandchildren would otherwise keep running
    # against the user's workspace after the run reported stopped.
    tasks = [
        e.task
        for k in _lineage_keys(thread_id)
        for e in _entries.get(k, {}).values()
        if not e.task.done()
    ]
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info(f"Cancelled {len(tasks)} background subagent(s)")


def snapshot(thread_id: str) -> list[dict]:
    """Status of every background child, for the UI / a /tasks-style view."""
    bucket = _entries.get(_key(thread_id), {})
    return [
        {
            "agent_id": e.agent_id,
            "role": e.role,
            "task": e.task_text,
            "running": not e.task.done(),
            "status": (e.report or {}).get("status") if e.task.done() else "running",
        }
        for e in bucket.values()
    ]


def clear(thread_id: str = "") -> None:
    """Drop tracking for a finished run (or everything, for test isolation)."""
    if thread_id:
        for k in _lineage_keys(thread_id):
            _entries.pop(k, None)
    else:
        _entries.clear()


def format_notification(item: dict) -> str:
    """
    Render one completion as the text the parent actually reads.

    Deliberately the same shape as a foreground sub_agent tool result, so the
    model needs no separate convention for background work — only the framing
    differs, telling it which agent this refers to.
    """
    report: dict[str, Any] = item.get("report") or {}
    lines = [
        f"[Background agent '{item.get('role') or item.get('agent_id')}' finished "
        f"— status: {report.get('status', 'unknown')}]",
        f"Task: {item.get('task', '')}",
    ]
    if report.get("summary"):
        lines.append(f"Summary: {report['summary']}")
    if report.get("files_changed"):
        lines.append(f"Files changed: {', '.join(report['files_changed'])}")
    if report.get("findings"):
        lines.append("Findings: " + " | ".join(report["findings"]))
    if report.get("follow_ups"):
        lines.append("Follow-ups: " + " | ".join(report["follow_ups"]))
    if report.get("verification"):
        ver = ", ".join(
            f"{v.get('command')} → exit {v.get('exit_code')}"
            for v in report["verification"] if isinstance(v, dict)
        )
        lines.append(f"Verification: {ver}")
    elif report.get("files_changed"):
        lines.append("Verification: NONE RUN — this work is unverified.")
    return "\n".join(lines)
