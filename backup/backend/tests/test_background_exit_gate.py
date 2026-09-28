"""
The parent loop must never answer while background children are still working.

This is THE invariant that makes background spawning safe. Without it the parent
produces a final answer describing work that hasn't happened — a confidently
wrong completion, which is the exact failure the verification rules elsewhere
exist to prevent.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from agents.tool_use_agent import ToolUseAgent
from tools import subagent_registry as reg
from tools.base_tool import BaseTool
from tools.registry import ToolRegistry


class _SlowBackgroundTool(BaseTool):
    """Stands in for sub_agent: registers a background child, returns at once."""

    def __init__(self, workspace, delay=0.3):
        super().__init__(workspace)
        self.name = "sub_agent"
        self.description = "spawn"
        self.delay = delay
        self.finished = False

    def parameters(self):
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs):
        # ONE task, mirroring sub_agent_tool: a wrapper awaiting a second inner
        # task would make cancellation stop only the wrapper while the real work
        # ran on — which is exactly the bug this harness must not fake away.
        async def _work():
            await asyncio.sleep(self.delay)
            self.finished = True
            report = {"status": "done", "summary": "background work done",
                      "files_changed": [], "findings": [], "follow_ups": [],
                      "verification": []}
            reg.record_result(self.thread_id, "bg-1", report)
            return report

        task = asyncio.create_task(_work())
        reg.register(self.thread_id, "bg-1", "worker", "background work", task)
        return {"status": "started", "agent_id": "bg-1"}


class _SpawnThenAnswerLLM:
    """Turn 1: spawn in background. Every turn after: answer with text only."""

    deployment = "fake"

    def __init__(self):
        self.turns = 0
        self.saw_notification = False

    async def stream_with_tools(self, messages, **kwargs):
        self.turns += 1
        # Did a completion notification reach the message history?
        for m in messages:
            if isinstance(m.get("content"), str) and "Background agent" in m["content"]:
                self.saw_notification = True
        if self.turns == 1:
            yield "tool_calls", [SimpleNamespace(id="c0", name="sub_agent", arguments={})]
        else:
            yield "content", "All done."
        yield "usage", {"total_tokens": 1}

    async def invoke(self, messages, **kwargs):
        return "", {"total_tokens": 0}


@pytest.fixture(autouse=True)
def _clean():
    reg.clear()
    yield
    reg.clear()


def _agent(tmp_path, llm, tool):
    return ToolUseAgent(
        llm=llm, tool_registry=ToolRegistry([tool]),
        context_window=16000, thread_id="root", agent_id="__root__",
    )


@pytest.mark.asyncio
async def test_run_does_not_finish_while_a_child_is_running(tmp_path):
    llm = _SpawnThenAnswerLLM()
    tool = _SlowBackgroundTool(str(tmp_path), delay=0.4)
    tool.thread_id = "root"

    result = await asyncio.wait_for(
        _agent(tmp_path, llm, tool).run("do the thing"), timeout=20,
    )

    assert result["status"] == "done"
    assert tool.finished, "the run answered before its background child finished"
    assert reg.pending("root") == []


@pytest.mark.asyncio
async def test_the_model_sees_the_completion_notification(tmp_path):
    """Waiting is not enough — the report has to reach the model so its final
    answer can actually reflect what the child did."""
    llm = _SpawnThenAnswerLLM()
    tool = _SlowBackgroundTool(str(tmp_path), delay=0.2)
    tool.thread_id = "root"

    await asyncio.wait_for(_agent(tmp_path, llm, tool).run("do it"), timeout=20)

    assert llm.saw_notification, "the child's report never reached the model"


@pytest.mark.asyncio
async def test_stop_cancels_background_children(tmp_path):
    """Stop must not leave work running against the user's workspace."""
    llm = _SpawnThenAnswerLLM()
    tool = _SlowBackgroundTool(str(tmp_path), delay=5.0)
    tool.thread_id = "root"

    stop = {"v": False}
    calls = {"n": 0}

    def should_stop():
        # Let the first turn through (so the spawn happens), then stop.
        calls["n"] += 1
        return stop["v"] or calls["n"] > 2

    result = await asyncio.wait_for(
        _agent(tmp_path, llm, tool).run("do it", should_stop=should_stop),
        timeout=20,
    )

    assert result["status"] == "stopped"
    assert reg.pending("root") == [], "background child survived Stop"
    assert not tool.finished, "child completed despite being cancelled"
