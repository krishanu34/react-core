"""
Per-conversation spawn budget.

The concurrency gate cannot see the failure mode this guards: an agent that
spawns SERIALLY in a loop never exceeds the concurrent cap, so nothing stops it
burning budget indefinitely. This is the total-work backstop.
"""

from __future__ import annotations

import pytest

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

    async def stream_with_tools(self, messages, **kwargs):
        yield "content", "done"
        yield "usage", {"total_tokens": 1}

    async def invoke(self, messages, **kwargs):
        return "", {"total_tokens": 0}


@pytest.fixture(autouse=True)
def _clean_budget():
    reset_session_spawns()
    yield
    reset_session_spawns()


def _spawner(tmp_path, thread_id="root"):
    return SubAgentTool(
        str(tmp_path), llm=_FakeLLM(),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id=thread_id,
    )


@pytest.mark.asyncio
async def test_spawns_are_refused_once_the_budget_is_spent(tmp_path, monkeypatch):
    monkeypatch.setattr(sat, "MAX_SUBAGENTS_PER_SESSION", 2)
    tool = _spawner(tmp_path)

    first = await tool.run(task="one")
    second = await tool.run(task="two")
    third = await tool.run(task="three")

    assert first["status"] in ("done", "unverified")
    assert second["status"] in ("done", "unverified")
    # Refused, NOT errored — the parent must be able to continue inline.
    assert third["status"] == "refused"
    assert "spawn limit reached" in third["error"].lower()
    assert "do not retry" in third["error"].lower()


@pytest.mark.asyncio
async def test_budget_is_per_conversation_not_global(tmp_path, monkeypatch):
    """One user's fan-out must never exhaust another's allowance."""
    monkeypatch.setattr(sat, "MAX_SUBAGENTS_PER_SESSION", 1)

    a = _spawner(tmp_path, thread_id="conversation-a")
    b = _spawner(tmp_path, thread_id="conversation-b")

    await a.run(task="spend a's budget")
    exhausted = await a.run(task="a again")
    fresh = await b.run(task="b's first")

    assert exhausted["status"] == "refused"
    assert fresh["status"] in ("done", "unverified"), "b's budget was spent by a"


@pytest.mark.asyncio
async def test_nested_spawns_charge_the_same_conversation(tmp_path, monkeypatch):
    """A grandchild is spawned on a derived thread id ("root::sub::x"), which
    must still bill the root — otherwise nesting is an unlimited bypass."""
    monkeypatch.setattr(sat, "MAX_SUBAGENTS_PER_SESSION", 1)

    root = _spawner(tmp_path, thread_id="root")
    nested = _spawner(tmp_path, thread_id="root::sub::child-abc")

    await root.run(task="top level")
    result = await nested.run(task="nested work")

    assert result["status"] == "refused", "nesting bypassed the session budget"


@pytest.mark.asyncio
async def test_a_spawn_with_no_usable_tools_does_not_charge_the_budget(tmp_path, monkeypatch):
    """Rejected before any agent ran, so it must not consume an allowance."""
    monkeypatch.setattr(sat, "MAX_SUBAGENTS_PER_SESSION", 1)
    tool = _spawner(tmp_path)

    wasted = await tool.run(task="x", tools=["nonexistent_tool"])
    assert "error" in wasted

    real = await tool.run(task="y")
    assert real["status"] in ("done", "unverified")


def test_reset_clears_a_single_conversation(tmp_path):
    sat._session_spawns["keep"] = 5
    sat._session_spawns["drop"] = 5
    reset_session_spawns("drop::sub::whatever")
    assert "drop" not in sat._session_spawns
    assert sat._session_spawns["keep"] == 5


def test_budget_cannot_be_configured_to_zero(monkeypatch):
    """A cap of 0 would deadlock every run; the floor of 1 makes that
    unreachable regardless of what an operator sets."""
    assert sat.MAX_SUBAGENTS_PER_SESSION >= 1
