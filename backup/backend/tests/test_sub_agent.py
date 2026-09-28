"""
Sub-agent spawning — the invariants that must not regress.

The important one is test_sibling_cannot_inherit_reads: it FAILS on the
pre-change code, where every child shared the parent's thread_id and therefore
its read-before-overwrite tracker. That made one child's read authorize another
child's blind overwrite — parallelism silently defeating the write-safety
invariant.
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import pytest

from agents.factory import build_agent
from context import read_tracker
from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
from tools.sub_agent_tool import SubAgentTool, _paths_overlap


# ── Fakes ────────────────────────────────────────────────────────────────

class _StubTool(BaseTool):
    """Minimal tool that records the thread it was invoked under."""

    def __init__(self, workspace, name="read_file", description="stub"):
        super().__init__(workspace)
        self.name = name
        self.description = description

    def parameters(self):
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs):
        return "ok"


class _FakeLLM:
    """
    Drives ToolUseAgent without a network call.

    `script` is a list of turns; each is either a string (final text answer) or
    a list of (tool_name, args) to call. Consumed one turn per loop iteration.
    """

    deployment = "fake"

    def __init__(self, script=None):
        self.script = list(script or ["done"])
        self.calls = 0

    async def stream_with_tools(self, messages, **kwargs):
        self.calls += 1
        turn = self.script.pop(0) if self.script else "done"
        if isinstance(turn, str):
            yield "content", turn
        else:
            calls = [
                SimpleNamespace(id=f"c{i}", name=name, arguments=args)
                for i, (name, args) in enumerate(turn)
            ]
            yield "tool_calls", calls
        yield "usage", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}

    async def invoke(self, messages, **kwargs):
        return "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def _parent_registry(tmp_path, names=("read_file", "file_write", "grep_search", "ask_user")):
    return ToolRegistry([_StubTool(str(tmp_path), name=n) for n in names])


def _spawner(tmp_path, llm=None, depth=0, thread_id="t1"):
    return SubAgentTool(
        str(tmp_path),
        llm=llm or _FakeLLM(),
        tool_registry=_parent_registry(tmp_path),
        thread_id=thread_id,
        depth=depth,
    )


# ── §2 child parity ──────────────────────────────────────────────────────

def test_factory_honours_agent_mode(monkeypatch):
    monkeypatch.setenv("AGENT_MODE", "tool_use")
    assert type(build_agent(llm=None)).__name__ == "ToolUseAgent"
    monkeypatch.setenv("AGENT_MODE", "react")
    assert type(build_agent(llm=None)).__name__ == "ReActAgent"


# ── §10a tool scoping ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_child_without_owns_paths_is_read_only(tmp_path):
    tool = _spawner(tmp_path)
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    await tool.run(task="look around", on_event=on_event)
    assert "read_file" in seen["tools"]
    assert "file_write" not in seen["tools"], "no owns_paths → must not get write tools"


@pytest.mark.asyncio
async def test_child_with_owns_paths_gets_write_tools(tmp_path):
    tool = _spawner(tmp_path)
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    await tool.run(task="edit", owns_paths=["src/**"], on_event=on_event)
    assert "file_write" in seen["tools"]


@pytest.mark.asyncio
async def test_ask_user_never_reaches_a_child(tmp_path):
    tool = _spawner(tmp_path)
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    await tool.run(task="x", tools=["ask_user", "read_file"], owns_paths=["a/**"],
                   on_event=on_event)
    assert "ask_user" not in seen["tools"]


@pytest.mark.asyncio
async def test_child_cannot_gain_a_tool_the_parent_lacks(tmp_path):
    tool = _spawner(tmp_path)
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    await tool.run(task="x", tools=["run_terminal"], on_event=on_event)
    assert "run_terminal" not in seen.get("tools", [])


# ── §3 depth ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_depth_cap_refuses_further_spawning(tmp_path, monkeypatch):
    import tools.sub_agent_tool as sat
    monkeypatch.setattr(sat, "MAX_SUBAGENT_DEPTH", 1)
    result = await _spawner(tmp_path, depth=1).run(task="deeper")
    assert result["status"] == "error"
    assert "depth" in result["error"].lower()


@pytest.mark.asyncio
async def test_child_below_cap_can_spawn_grandchild(tmp_path):
    tool = _spawner(tmp_path)
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    await tool.run(task="x", on_event=on_event)
    assert "sub_agent" in seen["tools"], "depth 1 of 2 should still be able to delegate"


# ── §7b state isolation — the regression test ────────────────────────────

def test_sibling_cannot_inherit_reads():
    """Fails on the pre-change code: children shared the parent's thread_id."""
    read_tracker.clear_thread("root")
    read_tracker.clear_thread("root::sub::a")
    read_tracker.clear_thread("root::sub::b")

    read_tracker.mark_read("root::sub::a", "foo.py")

    assert read_tracker.has_been_read("root::sub::a", "foo.py")
    assert not read_tracker.has_been_read("root::sub::b", "foo.py"), (
        "sibling must NOT be able to overwrite a file only its sibling read"
    )
    assert not read_tracker.has_been_read("root", "foo.py")

    read_tracker.merge_thread("root::sub::a", "root")
    assert read_tracker.has_been_read("root", "foo.py"), (
        "parent inherits what its delegate read on its behalf"
    )


def test_merge_is_one_way():
    read_tracker.clear_thread("p")
    read_tracker.clear_thread("p::sub::c")
    read_tracker.mark_read("p", "parent_only.py")
    read_tracker.merge_thread("p::sub::c", "p")
    assert not read_tracker.has_been_read("p::sub::c", "parent_only.py")


@pytest.mark.asyncio
async def test_child_tools_carry_a_derived_thread_id(tmp_path):
    """
    The wiring behind the isolation: every tool handed to a child must be
    stamped with the child's OWN thread, not the parent's. Before the change
    they all shared the parent's, which is what let siblings authorize each
    other's writes.
    """
    captured = {}
    tool = _spawner(tmp_path, thread_id="root")

    # Intercept the agent build to inspect the registry the child receives.
    import agents.factory as factory
    original = factory.build_agent

    def _spy(**kwargs):
        captured["threads"] = {
            t.name: getattr(t, "thread_id", None)
            for t in kwargs["tool_registry"].list_tools()
        }
        return original(**kwargs)

    factory.build_agent = _spy
    try:
        await tool.run(task="x")
    finally:
        factory.build_agent = original

    threads = captured["threads"]
    assert threads, "child registry was empty"
    for name, tid in threads.items():
        assert tid is not None and tid.startswith("root::sub::"), (
            f"tool {name} still carries the parent thread ({tid})"
        )
    # The parent's own tools are untouched.
    assert all(t.thread_id != list(threads.values())[0]
               for t in tool._parent_registry.list_tools())


@pytest.mark.asyncio
async def test_child_state_is_cleaned_up_after_run(tmp_path):
    tool = _spawner(tmp_path, thread_id="cleanup")
    ids = []

    async def on_event(kind, data):
        if kind == "subagent_start":
            ids.append(data["agent_id"])

    await tool.run(task="x", on_event=on_event)
    child_thread = f"cleanup::sub::{ids[0]}"
    assert child_thread not in read_tracker._read_paths


# ── §7c report contract ──────────────────────────────────────────────────

def test_report_parses_structured_block():
    answer = (
        "Did the thing.\n"
        '```json\n{"summary": "migrated schema", "files_changed": ["db/x.sql"], '
        '"verification": [{"command": "pytest", "exit_code": 0}]}\n```'
    )
    r = SubAgentTool._parse_report(answer)
    assert r["summary"] == "migrated schema"
    assert r["files_changed"] == ["db/x.sql"]
    assert r["verification"][0]["exit_code"] == 0


def test_report_degrades_when_model_ignores_the_format():
    r = SubAgentTool._parse_report("I just wrote some prose.")
    assert r["summary"] == "I just wrote some prose."
    assert r["files_changed"] == []


def test_report_summary_is_capped():
    from tools.sub_agent_tool import _SUMMARY_CAP
    r = SubAgentTool._parse_report("x" * (_SUMMARY_CAP * 3))
    assert len(r["summary"]) <= _SUMMARY_CAP


@pytest.mark.asyncio
async def test_code_change_without_verification_is_unverified(tmp_path):
    llm = _FakeLLM(script=[
        '```json\n{"summary": "wrote it", "files_changed": ["a.py"], "verification": []}\n```'
    ])
    result = await _spawner(tmp_path, llm=llm).run(task="write", owns_paths=["**"])
    assert result["status"] == "unverified", (
        "a child that changed code but ran nothing must not report done"
    )


@pytest.mark.asyncio
async def test_verified_code_change_stays_done(tmp_path):
    llm = _FakeLLM(script=[
        '```json\n{"summary": "wrote it", "files_changed": ["a.py"], '
        '"verification": [{"command": "pytest", "exit_code": 0}]}\n```'
    ])
    result = await _spawner(tmp_path, llm=llm).run(task="write", owns_paths=["**"])
    assert result["status"] == "done"


# ── §10a write-conflict serialization ────────────────────────────────────

def test_overlap_detection():
    assert _paths_overlap(["src/**"], ["src/**"])
    assert _paths_overlap(["src/api/**"], ["src/**"])
    assert not _paths_overlap(["src/api/**"], ["tests/**"])
    assert not _paths_overlap([], ["src/**"])


@pytest.mark.asyncio
async def test_overlapping_writers_are_serialized(tmp_path):
    """Two children owning the same paths must never be in flight together."""
    concurrent = 0
    peak = 0

    class _SlowLLM(_FakeLLM):
        async def stream_with_tools(self, messages, **kwargs):
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            await asyncio.sleep(0.05)
            concurrent -= 1
            yield "content", "done"
            yield "usage", {"total_tokens": 1}

    tool = _spawner(tmp_path, llm=_SlowLLM())
    await asyncio.gather(
        tool.run(task="a", owns_paths=["src/**"]),
        tool.run(task="b", owns_paths=["src/**"]),
    )
    assert peak == 1, f"overlapping writers ran concurrently (peak={peak})"


@pytest.mark.asyncio
async def test_disjoint_writers_run_in_parallel(tmp_path):
    concurrent = 0
    peak = 0

    class _SlowLLM(_FakeLLM):
        async def stream_with_tools(self, messages, **kwargs):
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            await asyncio.sleep(0.05)
            concurrent -= 1
            yield "content", "done"
            yield "usage", {"total_tokens": 1}

    tool = _spawner(tmp_path, llm=_SlowLLM())
    await asyncio.gather(
        tool.run(task="a", owns_paths=["src/**"]),
        tool.run(task="b", owns_paths=["tests/**"]),
    )
    assert peak == 2, "disjoint writers should not block each other"


# ── §10d retry with feedback ─────────────────────────────────────────────

class _FailingThenOKLLM(_FakeLLM):
    """Fails the first run, succeeds the second."""

    def __init__(self):
        super().__init__()
        self.prompts = []
        self.runs = 0

    async def stream_with_tools(self, messages, **kwargs):
        self.prompts.append(messages[-1].get("content", "") if messages else "")
        self.runs += 1
        if self.runs == 1:
            raise RuntimeError("boom")
        yield "content", '```json\n{"summary": "fixed on retry"}\n```'
        yield "usage", {"total_tokens": 1}


@pytest.mark.asyncio
async def test_failed_child_is_retried_once_with_the_failure_in_context(tmp_path):
    llm = _FailingThenOKLLM()
    events = []

    async def on_event(kind, data):
        events.append(kind)

    result = await _spawner(tmp_path, llm=llm).run(task="do it", on_event=on_event)

    assert llm.runs == 2, "a failed child should get exactly one retry"
    assert "subagent_retry" in events
    assert "Previous attempt FAILED" in llm.prompts[1]
    assert result["summary"] == "fixed on retry"


@pytest.mark.asyncio
async def test_successful_child_is_not_retried(tmp_path):
    llm = _FakeLLM(script=['```json\n{"summary": "first time"}\n```'])
    await _spawner(tmp_path, llm=llm).run(task="do it")
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_stop_reaches_the_child_before_it_calls_the_llm(tmp_path):
    """
    §2/§3: should_stop is threaded all the way into the child's loop, so a
    cancelled run costs nothing. Before this it was never passed down and the
    child ran to completion after the user pressed Stop.
    """
    llm = _FailingThenOKLLM()
    result = await _spawner(tmp_path, llm=llm).run(
        task="do it", should_stop=lambda: True,
    )
    assert llm.runs == 0, "a stopped child must not call the LLM at all"
    assert result["status"] == "stopped"


@pytest.mark.asyncio
async def test_no_retry_once_the_user_stops_mid_run(tmp_path):
    """Retrying after Stop would keep burning tokens the user cancelled."""
    stopped = {"yes": False}

    class _FailsThenStopped(_FailingThenOKLLM):
        async def stream_with_tools(self, messages, **kwargs):
            self.runs += 1
            stopped["yes"] = True      # user hits Stop during the first attempt
            raise RuntimeError("boom")
            yield  # pragma: no cover — makes this an async generator

    llm = _FailsThenStopped()
    await _spawner(tmp_path, llm=llm).run(
        task="do it", should_stop=lambda: stopped["yes"],
    )
    assert llm.runs == 1, "must not retry after the user has stopped"


# ── §7a briefing ─────────────────────────────────────────────────────────

def test_brief_excludes_parent_history_and_caps(tmp_path):
    from tools.sub_agent_tool import _BRIEF_CAP
    tool = _spawner(tmp_path)
    brief = tool._build_brief(
        task="t", role="r", system_prompt="p" * 20_000,
        context="c", owns_paths=["src/**"],
    )
    assert len(brief) <= _BRIEF_CAP
    assert "src/**" in tool._build_brief("t", "r", "p", "c", ["src/**"])


def test_brief_tells_the_child_it_cannot_ask(tmp_path):
    brief = _spawner(tmp_path)._build_brief("t", "r", "", "", [])
    assert "cannot ask the user" in brief
