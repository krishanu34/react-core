"""
Context spill (§8a) — offload instead of destroy.

The behaviour being locked in: when the loop sheds content to free context, the
bytes survive on disk and the message keeps a POINTER, not a tombstone. Before
this, eviction told the agent to "re-read the file or re-run the search".
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from context import context_spill
from tools.restore_context_tool import RestoreContextTool


@pytest.fixture(autouse=True)
def _isolated_root(tmp_path, monkeypatch):
    """Point DEVACCEL_ROOT at a temp dir so tests never touch the real one."""
    monkeypatch.setattr("agents.workspace_paths.DEVACCEL_ROOT", str(tmp_path))
    yield


# ── Round trip ───────────────────────────────────────────────────────────

def test_spill_restore_returns_exact_bytes():
    original = "line one\nline two\n" * 500
    ref = context_spill.spill("t1", original, label="grep result")
    assert ref
    assert context_spill.restore("t1", ref) == original


def test_spill_preserves_unicode():
    original = "认证モジュール — naïve café\n"
    ref = context_spill.spill("t1", original)
    assert context_spill.restore("t1", ref) == original


def test_metadata_is_recorded():
    ref = context_spill.spill("t1", "x" * 100, label="grep 'authMiddleware'")
    meta = context_spill.describe("t1", ref)
    assert meta["chars"] == 100
    assert meta["label"] == "grep 'authMiddleware'"


def test_threads_do_not_see_each_others_spills():
    ref = context_spill.spill("thread-a", "secret")
    assert context_spill.restore("thread-b", ref) is None


def test_unknown_ref_returns_none():
    assert context_spill.restore("t1", "ctx-does-not-exist") is None


# ── The ref is LLM-authored, so treat it as untrusted ────────────────────

@pytest.mark.parametrize("bad", [
    "../../../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/passwd",
    "ctx/../../escape",
    "a" * 200,
    "",
    None,
])
def test_path_traversal_refs_are_rejected(bad):
    assert context_spill.restore("t1", bad) is None
    assert context_spill.describe("t1", bad) == {}


# ── The pointer, not a tombstone ─────────────────────────────────────────

def test_pointer_tells_the_agent_how_to_get_it_back():
    text = context_spill.pointer("ctx-abc", 18_800, "earlier tool result")
    assert "restore_context" in text
    assert "ctx-abc" in text
    assert "18.4 KB" in text
    assert "re-run" not in text, "must not tell the agent to redo the work"


# ── Lifecycle ────────────────────────────────────────────────────────────

def test_clear_thread_removes_the_spill_area():
    ref = context_spill.spill("t-done", "content")
    assert context_spill.restore("t-done", ref) == "content"
    context_spill.clear_thread("t-done")
    assert context_spill.restore("t-done", ref) is None


def test_sweep_removes_stale_tmp_dirs(tmp_path):
    context_spill.spill("old-thread", "x")
    tmp_dir = tmp_path / "old-thread" / "tmp"
    assert tmp_dir.is_dir()

    # Backdate past the TTL.
    old = time.time() - (48 * 3600)
    import os
    os.utime(tmp_dir, (old, old))

    assert context_spill.sweep_stale(root=str(tmp_path), ttl_hours=24) == 1
    assert not tmp_dir.is_dir()


def test_sweep_keeps_fresh_tmp_dirs(tmp_path):
    context_spill.spill("fresh-thread", "x")
    assert context_spill.sweep_stale(root=str(tmp_path), ttl_hours=24) == 0
    assert (tmp_path / "fresh-thread" / "tmp").is_dir()


# ── The tool ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_restore_tool_returns_content(tmp_path):
    ref = context_spill.spill("t-tool", "the original content")
    tool = RestoreContextTool(str(tmp_path), thread_id="t-tool")
    result = await tool.run(ref=ref)
    assert result["content"] == "the original content"


@pytest.mark.asyncio
async def test_restore_tool_caps_huge_content(tmp_path):
    from tools.restore_context_tool import _MAX_RESTORE_CHARS
    ref = context_spill.spill("t-big", "x" * (_MAX_RESTORE_CHARS * 2))
    tool = RestoreContextTool(str(tmp_path), thread_id="t-big")
    result = await tool.run(ref=ref)
    assert len(result["content"]) == _MAX_RESTORE_CHARS
    assert result["truncated"] is True


@pytest.mark.asyncio
async def test_restore_tool_explains_a_missing_ref(tmp_path):
    tool = RestoreContextTool(str(tmp_path), thread_id="t-missing")
    result = await tool.run(ref="ctx-nope")
    assert "error" in result
    assert "ctx-nope" in result["error"]


@pytest.mark.asyncio
async def test_restore_tool_requires_a_ref(tmp_path):
    result = await RestoreContextTool(str(tmp_path)).run()
    assert "error" in result
