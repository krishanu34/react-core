"""
Nested spawns must never deadlock (regression).

Reproduces the hang seen on a real run: three top-level agents (backend,
frontend, infrastructure) each spawned their OWN sub-agents, and the whole run
stopped making progress.

Cause: a parent held its concurrency slot for the entire duration of
child_agent.run(), and the grandchild spawned inside that run tried to acquire
the SAME global semaphore. Once (top-level agents + their children) exceeded
MAX_CONCURRENT_SUBAGENTS, the blocked grandchildren could only proceed when a
slot freed — and slots only free when parents finish, which needs those very
grandchildren. Classic hold-and-wait.

The same shape applies to write claims: a grandchild owning a path its own
ancestor already claimed would wait on a claim that can never be released.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
import tools.sub_agent_tool as sat
from tools.sub_agent_tool import SubAgentTool


class _StubTool(BaseTool):
    def __init__(self, workspace, name="read_file"):
        super().__init__(workspace)
        self.name = name
        self.description = "stub"

    def parameters(self):
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs):
        return "ok"


class _SpawningLLM:
    """First turn: call sub_agent. Second turn: answer. So every agent this
    drives spawns exactly one child before finishing."""

    deployment = "fake"

    def __init__(self, depth_budget: int):
        self.depth_budget = depth_budget
        self.turns = 0

    async def stream_with_tools(self, messages, **kwargs):
        self.turns += 1
        names = {t["function"]["name"] for t in (kwargs.get("tools") or [])}
        if self.turns == 1 and self.depth_budget > 0 and "sub_agent" in names:
            yield "tool_calls", [SimpleNamespace(
                id="c0", name="sub_agent",
                arguments={"task": "nested work", "role": "worker"},
            )]
        else:
            yield "content", "done"
        yield "usage", {"total_tokens": 1}


def _spawner(tmp_path, llm, thread_id="root"):
    registry = ToolRegistry([_StubTool(str(tmp_path))])
    return SubAgentTool(
        str(tmp_path), llm=llm, tool_registry=registry, thread_id=thread_id,
    )


@pytest.fixture(autouse=True)
def _reset_gate(monkeypatch):
    """The semaphore is module-global and lazily bound to the running loop."""
    monkeypatch.setattr(sat, "_concurrency_gate", None)
    sat._active_claims.clear()
    sat._claim_cv.clear()
    yield
    monkeypatch.setattr(sat, "_concurrency_gate", None)


@pytest.mark.asyncio
async def test_nested_spawn_does_not_deadlock_on_a_single_slot(tmp_path, monkeypatch):
    """
    One slot, a parent that spawns a child. Before the fix the parent held the
    only slot while its child waited for one — forever.
    """
    monkeypatch.setattr(sat, "MAX_CONCURRENT_SUBAGENTS", 1)
    monkeypatch.setattr(sat, "MAX_SUBAGENT_DEPTH", 3)

    tool = _spawner(tmp_path, _SpawningLLM(depth_budget=1))
    result = await asyncio.wait_for(tool.run(task="top level"), timeout=10)
    assert result["status"] in ("done", "unverified")


@pytest.mark.asyncio
async def test_wide_fanout_with_nested_children_completes(tmp_path, monkeypatch):
    """
    The exact shape of the real run: 3 concurrent top-level agents, each
    spawning its own children, against a semaphore smaller than the total.
    """
    monkeypatch.setattr(sat, "MAX_CONCURRENT_SUBAGENTS", 2)
    monkeypatch.setattr(sat, "MAX_SUBAGENT_DEPTH", 3)

    tools = [_spawner(tmp_path, _SpawningLLM(depth_budget=1)) for _ in range(3)]
    results = await asyncio.wait_for(
        asyncio.gather(*[t.run(task=f"stream {i}") for i, t in enumerate(tools)]),
        timeout=15,
    )
    assert all(r["status"] in ("done", "unverified") for r in results)


@pytest.mark.asyncio
async def test_descendant_may_write_inside_an_ancestors_claim(tmp_path, monkeypatch):
    """
    A grandchild owning a path its ancestor already claimed must not block:
    that claim is only released when the ancestor finishes, which requires the
    grandchild. The lineage is the same agent's work, so it is not a conflict.
    """
    monkeypatch.setattr(sat, "MAX_CONCURRENT_SUBAGENTS", 4)
    monkeypatch.setattr(sat, "MAX_SUBAGENT_DEPTH", 3)

    class _NestedWriter(_SpawningLLM):
        async def stream_with_tools(self, messages, **kwargs):
            self.turns += 1
            names = {t["function"]["name"] for t in (kwargs.get("tools") or [])}
            if self.turns == 1 and self.depth_budget > 0 and "sub_agent" in names:
                yield "tool_calls", [SimpleNamespace(
                    id="c0", name="sub_agent",
                    arguments={
                        "task": "nested write",
                        "role": "writer",
                        "owns_paths": ["backend/**"],   # same path as the parent
                    },
                )]
            else:
                yield "content", "done"
            yield "usage", {"total_tokens": 1}

    tool = _spawner(tmp_path, _NestedWriter(depth_budget=1))
    result = await asyncio.wait_for(
        tool.run(task="build backend", owns_paths=["backend/**"]), timeout=10,
    )
    assert result["status"] in ("done", "unverified")


@pytest.mark.asyncio
async def test_unrelated_writers_on_the_same_path_still_serialize(tmp_path, monkeypatch):
    """The deadlock fix must not weaken the write-conflict guarantee between
    SIBLINGS, which is the whole point of owns_paths."""
    monkeypatch.setattr(sat, "MAX_CONCURRENT_SUBAGENTS", 4)

    concurrent = 0
    peak = 0

    class _SlowLLM:
        deployment = "fake"

        async def stream_with_tools(self, messages, **kwargs):
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            await asyncio.sleep(0.05)
            concurrent -= 1
            yield "content", "done"
            yield "usage", {"total_tokens": 1}

    tool = _spawner(tmp_path, _SlowLLM())
    await asyncio.gather(
        tool.run(task="a", owns_paths=["src/**"]),
        tool.run(task="b", owns_paths=["src/**"]),
    )
    assert peak == 1, f"sibling writers on the same path ran concurrently (peak={peak})"
