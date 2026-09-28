"""
Background sub-agents.

A foreground spawn holds the parent's step until the child returns, serialising
the parent behind its slowest child. A background spawn returns an id at once and
the report arrives as a notification on a later turn.

The invariant these exist to protect: a run must NEVER finish while a background
child is still working. If it could, the parent's answer would describe work that
hadn't happened — the exact class of confidently-wrong output the verification
rules elsewhere are built to prevent.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from tools import subagent_registry as reg
from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
import tools.sub_agent_tool as sat
from tools.sub_agent_tool import SubAgentTool, reset_session_spawns


class _StubTool(BaseTool):
    def __init__(self, workspace, name="read_file"):
        super().__init__(workspace)
        self.name = name
        self.description = "stub"

    def parameters(self):
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs):
        return "ok"


class _FakeLLM:
    deployment = "fake"

    def __init__(self, delay: float = 0.0):
        self.delay = delay

    async def stream_with_tools(self, messages, **kwargs):
        if self.delay:
            await asyncio.sleep(self.delay)
        yield "content", '{"summary": "did the thing", "files_changed": []}'
        yield "usage", {"total_tokens": 1}

    async def invoke(self, messages, **kwargs):
        return "", {"total_tokens": 0}


@pytest.fixture(autouse=True)
def _clean():
    reg.clear()
    reset_session_spawns()
    yield
    reg.clear()
    reset_session_spawns()


def _spawner(tmp_path, llm=None, thread_id="root"):
    return SubAgentTool(
        str(tmp_path), llm=llm or _FakeLLM(),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id=thread_id,
    )


# ── Returning immediately ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_background_spawn_returns_before_the_child_finishes(tmp_path):
    tool = _spawner(tmp_path, llm=_FakeLLM(delay=0.3))

    started = asyncio.get_event_loop().time()
    result = await tool.run(task="slow work", role="worker", run_in_background=True)
    elapsed = asyncio.get_event_loop().time() - started

    assert result["status"] == "started"
    assert result["agent_id"]
    assert result["background"] is True
    assert elapsed < 0.2, f"background spawn blocked for {elapsed:.2f}s"

    # And it really is still running.
    assert reg.pending("root")
    await reg.wait_all("root")


@pytest.mark.asyncio
async def test_foreground_spawn_still_blocks(tmp_path):
    """The default must not change — a parent that needs the result waits."""
    tool = _spawner(tmp_path)
    result = await tool.run(task="quick work", role="worker")
    assert result["status"] in ("done", "unverified")
    assert reg.pending("root") == []


# ── Reporting back ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_report_is_drained_once_and_only_once(tmp_path):
    tool = _spawner(tmp_path)
    await tool.run(task="work", role="worker", run_in_background=True)
    await reg.wait_all("root")

    first = reg.drain("root")
    assert len(first) == 1
    assert first[0]["role"] == "worker"
    assert first[0]["report"]["summary"] == "did the thing"

    # A second drain must not re-deliver it, or the parent sees the same
    # completion on every subsequent turn.
    assert reg.drain("root") == []


@pytest.mark.asyncio
async def test_a_crashed_child_still_reports_something(tmp_path):
    """A background child whose task raises must not vanish silently — the
    parent has to learn it failed."""

    class _Exploding:
        deployment = "fake"

        async def stream_with_tools(self, messages, **kwargs):
            raise RuntimeError("boom")
            yield  # pragma: no cover

        async def invoke(self, messages, **kwargs):
            return "", {}

    tool = _spawner(tmp_path, llm=_Exploding())
    await tool.run(task="doomed", role="worker", run_in_background=True)
    await reg.wait_all("root")

    drained = reg.drain("root")
    assert len(drained) == 1
    # "failed" (loop caught it) or "error" (tool caught it) — the guarantee is
    # that it does NOT read as success, so the parent can't claim the work landed.
    assert drained[0]["report"]["status"] in ("failed", "error")
    assert drained[0]["report"]["status"] not in ("done", "unverified")


@pytest.mark.asyncio
async def test_pending_is_empty_only_after_children_finish(tmp_path):
    tool = _spawner(tmp_path, llm=_FakeLLM(delay=0.2))
    await tool.run(task="a", role="a", run_in_background=True)
    await tool.run(task="b", role="b", run_in_background=True)

    assert len(reg.pending("root")) == 2
    await reg.wait_all("root")
    assert reg.pending("root") == []
    assert len(reg.undelivered("root")) == 2


# ── Isolation and cancellation ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_one_conversation_never_sees_anothers_children(tmp_path):
    a = _spawner(tmp_path, thread_id="conv-a")
    b = _spawner(tmp_path, thread_id="conv-b")

    await a.run(task="a's work", role="a", run_in_background=True)
    await reg.wait_all("conv-a")

    assert len(reg.drain("conv-a")) == 1
    assert reg.drain("conv-b") == [], "conversation b saw a's child"
    await b.run(task="b's work", role="b", run_in_background=True)
    await reg.wait_all("conv-b")
    assert len(reg.drain("conv-b")) == 1


@pytest.mark.asyncio
async def test_children_are_scoped_to_their_spawner_not_the_root(tmp_path):
    """
    Regression for a self-await deadlock. Keying by ROOT thread made a background
    child's own exit gate see ITSELF as pending, so it waited for itself and
    `wait_all` gathered its own task — an unbounded self-await.

    Each agent must see only the children it spawned. Whole-tree coverage comes
    from transitivity: the root waits for its child, which waits for its own.
    """
    nested = _spawner(tmp_path, thread_id="root::sub::child-1", llm=_FakeLLM(delay=0.2))
    await nested.run(task="deep work", role="deep", run_in_background=True)

    # The grandchild belongs to the child's bucket...
    assert reg.pending("root::sub::child-1")
    # ...and is NOT in the root's, which is what made the root's own gate hang.
    assert reg.pending("root") == []

    await reg.wait_all("root::sub::child-1")


@pytest.mark.asyncio
async def test_a_background_child_does_not_wait_for_itself(tmp_path):
    """The deadlock stated directly: a child asking its OWN thread id for
    pending work must never find itself listed."""
    tool = _spawner(tmp_path, llm=_FakeLLM(delay=0.2))
    result = await tool.run(task="work", role="w", run_in_background=True)
    child_thread = f"root::sub::{result['agent_id']}"

    assert reg.pending(child_thread) == [], "child sees itself as pending"
    await reg.wait_all(child_thread)   # must return immediately, not hang
    await reg.wait_all("root")


@pytest.mark.asyncio
async def test_cancel_reaches_grandchildren(tmp_path):
    """Cancellation is the one operation that must span the whole lineage:
    cancelling a child interrupts it mid-await, so its own background children
    would otherwise keep working after the run reported stopped."""
    child = _spawner(tmp_path, thread_id="root::sub::c1", llm=_FakeLLM(delay=5.0))
    await child.run(task="deep", role="deep", run_in_background=True)
    assert reg.pending("root::sub::c1")

    await reg.cancel_all("root")      # cancel from the TOP
    assert reg.pending("root::sub::c1") == [], "grandchild survived cancellation"


@pytest.mark.asyncio
async def test_cancel_all_stops_running_children(tmp_path):
    tool = _spawner(tmp_path, llm=_FakeLLM(delay=5.0))
    await tool.run(task="long", role="worker", run_in_background=True)
    assert reg.pending("root")

    await reg.cancel_all("root")
    assert reg.pending("root") == []


@pytest.mark.asyncio
async def test_wait_all_times_out_without_raising(tmp_path):
    """A hung child must degrade the answer, not kill the run."""
    tool = _spawner(tmp_path, llm=_FakeLLM(delay=10.0))
    await tool.run(task="hangs", role="worker", run_in_background=True)

    await reg.wait_all("root", timeout=0.2)   # must return, not raise
    await reg.cancel_all("root")


# ── Tool scoping ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_background_children_lose_session_mutating_tools(tmp_path):
    """A background child changing project memory or the shared todo list would
    alter state the user is reading with no visible cause."""
    names = []

    async def on_event(kind, data):
        if kind == "subagent_start":
            names.extend(data["tools"])

    tools = [
        _StubTool(str(tmp_path), name="read_file"),
        _StubTool(str(tmp_path), name="remember"),
        _StubTool(str(tmp_path), name="task_manager"),
    ]
    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM(),
        tool_registry=ToolRegistry(tools), thread_id="root",
    )
    await tool.run(task="x", role="w", run_in_background=True, on_event=on_event)
    await reg.wait_all("root")

    assert "read_file" in names
    assert "remember" not in names
    assert "task_manager" not in names


@pytest.mark.asyncio
async def test_foreground_children_keep_those_tools(tmp_path):
    """The restriction is specific to background execution, not a blanket ban."""
    names = []

    async def on_event(kind, data):
        if kind == "subagent_start":
            names.extend(data["tools"])

    tools = [
        _StubTool(str(tmp_path), name="read_file"),
        _StubTool(str(tmp_path), name="task_manager"),
    ]
    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM(),
        tool_registry=ToolRegistry(tools), thread_id="root",
    )
    await tool.run(task="x", role="w", on_event=on_event)
    assert "task_manager" in names


@pytest.mark.asyncio
async def test_start_event_marks_background_spawns(tmp_path):
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    tool = _spawner(tmp_path)
    await tool.run(task="x", role="w", run_in_background=True, on_event=on_event)
    await reg.wait_all("root")
    assert seen["background"] is True


# ── Notification rendering ───────────────────────────────────────────────

def test_notification_names_the_agent_and_its_outcome():
    text = reg.format_notification({
        "agent_id": "api-1", "role": "api-builder", "task": "build the API",
        "report": {
            "status": "done", "summary": "Created 4 endpoints",
            "files_changed": ["api/routes.py"],
            "verification": [{"command": "pytest", "exit_code": 0}],
            "findings": [], "follow_ups": [],
        },
    })
    assert "api-builder" in text
    assert "done" in text
    assert "Created 4 endpoints" in text
    assert "api/routes.py" in text
    assert "pytest" in text


def test_notification_flags_unverified_code_changes():
    """Parity with the foreground path's unverified downgrade — a background
    child that wrote code and ran nothing must not read as a clean success."""
    text = reg.format_notification({
        "agent_id": "x", "role": "writer", "task": "write it",
        "report": {
            "status": "unverified", "summary": "wrote the module",
            "files_changed": ["src/a.py"], "verification": [],
            "findings": [], "follow_ups": [],
        },
    })
    assert "unverified" in text.lower()
    assert "NONE RUN" in text


def test_notification_survives_a_malformed_report():
    text = reg.format_notification({"agent_id": "x", "role": "", "task": "", "report": {}})
    assert "unknown" in text
