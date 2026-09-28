"""Debug recorder unit tests + end-to-end via the stream endpoint's answer hook."""
from __future__ import annotations

import json
import os
import threading

import pytest


def test_recorder_writes_and_appends(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_DEBUG_RECORDING", "1")
    from react_core.debug_recorder import DebugRecorder

    rec = DebugRecorder(tmp_path, "tid-abc")
    rec.record("user_turn", {"message": "hello"})
    rec.record("thinking", {"step": 1})
    rec.record("tool_start", {"tool": "read_file", "input": {"path": "a.txt"}})
    rec.record("tool_result", {"tool": "read_file", "result": {"lines": [[1, "x"]]}})
    rec.record("final", {"answer": "done", "steps": 2})

    p = tmp_path / "debug" / "threads" / "tid-abc.json"
    assert p.exists()
    data = json.loads(p.read_text(encoding="utf-8"))
    assert data["thread_id"] == "tid-abc"
    kinds = [e["kind"] for e in data["events"]]
    assert kinds == ["user_turn", "thinking", "tool_start", "tool_result", "final"]

    # Append across a second "run" — same file grows, kinds preserved in order.
    rec2 = DebugRecorder(tmp_path, "tid-abc")
    rec2.record("user_turn", {"message": "follow-up"})
    rec2.record("final", {"answer": "done again", "steps": 1})
    data2 = json.loads(p.read_text(encoding="utf-8"))
    assert len(data2["events"]) == 7
    assert data2["events"][-1]["kind"] == "final"
    assert data2["events"][-1]["answer"] == "done again"


def test_recorder_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_DEBUG_RECORDING", "0")
    from react_core.debug_recorder import DebugRecorder

    rec = DebugRecorder(tmp_path, "tid-off")
    rec.record("user_turn", {"message": "hi"})
    assert not (tmp_path / "debug").exists()
    assert rec.read_snapshot() is None


def test_recorder_read_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_DEBUG_RECORDING", "1")
    from react_core.debug_recorder import DebugRecorder

    rec = DebugRecorder(tmp_path, "tid-snap")
    rec.record("user_turn", {"message": "hi"})
    snap = rec.read_snapshot()
    assert snap is not None
    assert snap["thread_id"] == "tid-snap"
    assert snap["events"][0]["kind"] == "user_turn"


def test_recorder_shrinks_large_payloads(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_DEBUG_RECORDING", "1")
    monkeypatch.setenv("REACT_CORE_DEBUG_MAX_EVENT_KB", "1")  # 1 KB cap
    from react_core.debug_recorder import DebugRecorder

    rec = DebugRecorder(tmp_path, "tid-big")
    huge = "x" * 50_000
    rec.record("tool_result", {"tool": "read_file", "result": {"content": huge}})

    data = json.loads((tmp_path / "debug" / "threads" / "tid-big.json").read_text())
    stored = data["events"][0]["result"]["content"]
    assert "chars omitted" in stored, "long strings must be truncated with a marker"
    assert len(stored) < len(huge)


def test_recorder_concurrent_appends_same_thread(tmp_path, monkeypatch):
    """Two threads writing concurrently must not corrupt the JSON."""
    monkeypatch.setenv("REACT_CORE_DEBUG_RECORDING", "1")
    from react_core.debug_recorder import DebugRecorder

    N = 50

    def writer(tag: str):
        rec = DebugRecorder(tmp_path, "tid-race")
        for i in range(N):
            rec.record("thinking", {"step": i, "tag": tag})

    t1 = threading.Thread(target=writer, args=("A",))
    t2 = threading.Thread(target=writer, args=("B",))
    t1.start(); t2.start(); t1.join(); t2.join()

    data = json.loads((tmp_path / "debug" / "threads" / "tid-race.json").read_text())
    assert len(data["events"]) == 2 * N
    tags = {e.get("tag") for e in data["events"]}
    assert tags == {"A", "B"}


def test_stream_answer_and_debug_endpoints(tmp_path, monkeypatch):
    """Hitting /api/agent/answer records user_answer; GET /debug/{tid} returns the JSON."""
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("REACT_CORE_DEBUG_RECORDING", "1")
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)

    from fastapi.testclient import TestClient
    from react_core.app.main import app
    from react_core.tools.ask_user import ask_user_broker

    client = TestClient(app)

    # 404 before any recording.
    r = client.get("/api/agent/debug/tid-unseen")
    assert r.status_code == 404

    # Seed a debug file directly (bypassing the LLM-driven stream).
    from react_core.debug_recorder import DebugRecorder
    rec = DebugRecorder(tmp_path, "tid-e2e")
    rec.record("user_turn", {"message": "hi"})

    # /answer with no pending question → 404 but the recorder should stay untouched.
    r = client.post("/api/agent/answer", json={
        "thread_id": "tid-e2e", "call_id": "no-such", "answer": "yes",
    })
    assert r.status_code == 404

    # Now simulate a pending ask_user + POST /answer → recorder captures user_answer.
    import asyncio
    async def _prime():
        return ask_user_broker.create("tid-e2e", "call-1")
    asyncio.run(_prime())

    r = client.post("/api/agent/answer", json={
        "thread_id": "tid-e2e", "call_id": "call-1", "answer": "approve",
    })
    assert r.status_code == 200

    # GET /debug/tid-e2e — must have user_turn + user_answer.
    r = client.get("/api/agent/debug/tid-e2e")
    assert r.status_code == 200
    data = r.json()
    kinds = [e["kind"] for e in data["events"]]
    assert kinds[0] == "user_turn"
    assert "user_answer" in kinds
    ua = next(e for e in data["events"] if e["kind"] == "user_answer")
    assert ua["answer"] == "approve"
    assert ua["call_id"] == "call-1"
