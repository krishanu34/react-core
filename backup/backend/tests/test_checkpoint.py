"""
Agent checkpoints (§8b) — resume instead of restart.

These run WITHOUT a database on purpose: the file tier must keep a run
resumable on its own, because that is the configuration most deployments and
every local dev run are in.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from context import checkpoint


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("agents.workspace_paths.DEVACCEL_ROOT", str(tmp_path))
    # No DB in these tests — exercise the file tier alone.
    monkeypatch.setattr(checkpoint, "_db_disabled", True)
    checkpoint._last_db_flush.clear()
    yield


def _messages(n=3):
    return [{"role": "user", "content": f"turn {i}"} for i in range(n)]


# ── Round trip ───────────────────────────────────────────────────────────

def test_save_then_load_round_trips():
    checkpoint.save("t1", "__root__", _messages(), status="running", steps_taken=4)
    cp = checkpoint.load("t1", "__root__")
    assert cp["steps_taken"] == 4
    assert cp["messages"][0]["content"] == "turn 0"


def test_load_returns_none_for_unknown_agent():
    assert checkpoint.load("t1", "never-existed") is None


def test_save_overwrites_the_previous_checkpoint():
    checkpoint.save("t2", "a", _messages(1), steps_taken=1)
    checkpoint.save("t2", "a", _messages(5), steps_taken=5)
    cp = checkpoint.load("t2", "a")
    assert cp["steps_taken"] == 5
    assert len(cp["messages"]) == 5


def test_lineage_is_recorded():
    checkpoint.save("t3", "child-1", _messages(), parent_agent_id="__root__",
                    role="api-builder", task="build endpoints")
    cp = checkpoint.load("t3", "child-1")
    assert cp["parent_agent_id"] == "__root__"
    assert cp["role"] == "api-builder"


def test_agent_id_is_sanitized_into_a_safe_dirname(tmp_path):
    """agent_id reaches this from a generated value — it must not escape."""
    checkpoint.save("t4", "../../escape", _messages())
    assert not (tmp_path.parent / "escape").exists()
    written = list((tmp_path / "t4" / "tmp").iterdir())
    assert written and all(".." not in p.name for p in written)


# ── Crash safety ─────────────────────────────────────────────────────────

def test_write_is_atomic(tmp_path):
    """A truncated checkpoint would make the run UNresumable — the exact
    failure this exists to prevent. Writes go through a temp file + rename."""
    checkpoint.save("t5", "a", _messages())
    agent_dir = tmp_path / "t5" / "tmp" / "a"
    assert (agent_dir / "checkpoint.json").is_file()
    assert not list(agent_dir.glob("*.tmp")), "temp file should be renamed away"
    json.loads((agent_dir / "checkpoint.json").read_text(encoding="utf-8"))


def test_checkpointing_never_raises_on_a_bad_path(monkeypatch):
    """Checkpointing sits in the agent's hot loop — it must never be the thing
    that kills a run."""
    monkeypatch.setattr(
        checkpoint, "_agent_dir",
        lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")),
    )
    checkpoint.save("t6", "a", _messages())  # must not raise


# ── Resume selection ─────────────────────────────────────────────────────

def test_unfinished_excludes_completed_agents():
    checkpoint.save("t7", "done-one", _messages(), status="done")
    checkpoint.save("t7", "still-going", _messages(), status="running")
    ids = {a["agent_id"] for a in checkpoint.unfinished_agents("t7")}
    assert ids == {"still-going"}


def test_unverified_counts_as_finished():
    """It produced work; re-running would duplicate edits. The parent decides
    what to do about the missing verification."""
    checkpoint.save("t8", "u", _messages(), status="unverified")
    assert checkpoint.unfinished_agents("t8") == []


@pytest.mark.parametrize("status", ["failed", "stopped"])
def test_failed_and_stopped_are_terminal_but_not_resumed(status):
    checkpoint.save("t9", "x", _messages(), status=status)
    assert checkpoint.unfinished_agents("t9") == []


def test_unfinished_is_empty_for_an_unknown_thread():
    assert checkpoint.unfinished_agents("no-such-thread") == []


# ── Derived sub-agent threads must not partition the checkpoints ─────────

def test_subagent_checkpoints_land_under_the_run_root():
    """
    Sub-agents run under a DERIVED thread ("root::sub::id") so their tool state
    is isolated. Checkpoints must NOT follow that split, or a resume looking at
    the root thread would find no children at all.
    """
    checkpoint.save("run-1", "__root__", _messages(), status="running")
    checkpoint.save("run-1::sub::api-9f", "api-9f", _messages(),
                    status="running", parent_agent_id="__root__", role="api")

    ids = {a["agent_id"] for a in checkpoint.unfinished_agents("run-1")}
    assert ids == {"__root__", "api-9f"}, (
        "the child's checkpoint must be visible from the run root"
    )


def test_load_finds_a_child_from_either_thread_form():
    checkpoint.save("run-2::sub::worker-1", "worker-1", _messages(2))
    assert checkpoint.load("run-2", "worker-1")["steps_taken"] == 0
    assert checkpoint.load("run-2::sub::worker-1", "worker-1") is not None


def test_root_thread_normalization():
    assert checkpoint.root_thread("abc") == "abc"
    assert checkpoint.root_thread("abc::sub::child-1") == "abc"
    assert checkpoint.root_thread("abc::sub::c1::sub::c2") == "abc"
    assert checkpoint.root_thread("") == "default"


def test_finished_child_is_not_resumed_but_running_sibling_is():
    checkpoint.save("run-3::sub::a", "a", _messages(), status="done",
                    parent_agent_id="__root__")
    checkpoint.save("run-3::sub::b", "b", _messages(), status="running",
                    parent_agent_id="__root__")
    ids = {x["agent_id"] for x in checkpoint.unfinished_agents("run-3")}
    assert ids == {"b"}, "a completed child must not be re-run — it would duplicate edits"


# ── Circuit breaker ──────────────────────────────────────────────────────

def test_db_circuit_opens_after_repeated_failures(monkeypatch):
    """An unreachable DB blocks on connect timeout. Since a checkpoint runs
    every step, we stop trying rather than pay that per step."""
    checkpoint.reset_db_circuit()

    class _Broken:
        def save(self, *a, **k):
            raise ConnectionError("db down")

    monkeypatch.setattr(checkpoint, "_store", _Broken())
    monkeypatch.setattr(checkpoint, "_store_tried", True)
    monkeypatch.setattr(checkpoint, "_db_disabled", False)
    monkeypatch.setattr(checkpoint, "_DB_FAILURE_LIMIT", 2)

    for _ in range(3):
        checkpoint.save("t10", "a", _messages(), status="done")

    assert checkpoint._db_disabled, "breaker should be open after repeated failures"
    assert checkpoint._db_store() is None
    checkpoint.reset_db_circuit()


def test_file_tier_still_works_when_the_db_is_down(monkeypatch):
    checkpoint.reset_db_circuit()
    monkeypatch.setattr(checkpoint, "_db_disabled", True)
    checkpoint.save("t11", "a", _messages(2), status="running")
    assert checkpoint.load("t11", "a")["messages"][1]["content"] == "turn 1"


@pytest.mark.asyncio
async def test_db_flush_never_blocks_the_event_loop(monkeypatch):
    """
    Regression: `save()` is called from inside the async agent loop after every
    step. A synchronous DB write there stalls the WHOLE loop for the connect
    timeout, freezing every concurrently running sub-agent — which is how a
    nested fan-out appeared to hang. The file tier is already durable, so the
    DB flush must never gate progress.
    """
    import asyncio
    import time as _time

    checkpoint.reset_db_circuit()

    class _Slow:
        def save(self, *a, **k):
            _time.sleep(1.0)      # stands in for a DB connect timeout

    monkeypatch.setattr(checkpoint, "_store", _Slow())
    monkeypatch.setattr(checkpoint, "_store_tried", True)
    monkeypatch.setattr(checkpoint, "_db_disabled", False)

    started = _time.monotonic()
    checkpoint.save("t12", "a", _messages(), status="done")
    elapsed = _time.monotonic() - started

    assert elapsed < 0.5, (
        f"save() blocked the event loop for {elapsed:.2f}s — the DB flush must "
        f"be offloaded, not awaited inline"
    )
    # The file tier is synchronous and must still have landed.
    assert checkpoint.load("t12", "a") is not None
    # Let the offloaded write finish so it doesn't leak into another test.
    await asyncio.sleep(0)
    checkpoint.reset_db_circuit()
