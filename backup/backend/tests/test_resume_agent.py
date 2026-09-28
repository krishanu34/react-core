"""
resume_agent — continue a finished sub-agent with its history intact.

Spawning a fresh agent for follow-up work starts blind: it re-reads the same
files, re-derives the same conclusions, and can contradict what the first agent
decided. Resuming carries the original reasoning forward.

History comes from the child's checkpoint, so resume reuses the durability layer
built for crash recovery rather than inventing a second store.
"""

from __future__ import annotations

import pytest

from context import checkpoint
from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
from tools.resume_agent_tool import ResumeAgentTool


class _StubTool(BaseTool):
    def __init__(self, workspace, name="read_file"):
        super().__init__(workspace)
        self.name = name
        self.description = "stub"

    def parameters(self):
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs):
        return "ok"


class _CapturingLLM:
    """Records the prompt it was given so we can assert what the agent saw."""

    deployment = "fake"

    def __init__(self):
        self.prompts: list[str] = []

    async def stream_with_tools(self, messages, **kwargs):
        for m in messages:
            if m.get("role") == "user" and isinstance(m.get("content"), str):
                self.prompts.append(m["content"])
        yield "content", '{"summary": "continued the work", "files_changed": []}'
        yield "usage", {"total_tokens": 1}

    async def invoke(self, messages, **kwargs):
        return "", {"total_tokens": 0}


def _tool(tmp_path, llm=None, thread_id="resume-root"):
    return ResumeAgentTool(
        str(tmp_path), llm=llm or _CapturingLLM(),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id=thread_id,
    )


def _seed_checkpoint(thread_id, agent_id, messages, role="reviewer"):
    checkpoint.save(
        thread_id, agent_id, messages,
        status="done", role=role, task="find perf issues",
    )


# ── The core behaviour ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_resume_replays_the_agents_own_conclusions(tmp_path):
    _seed_checkpoint("resume-root", "rev-1", [
        {"role": "system", "content": "you are a reviewer"},
        {"role": "user", "content": "find perf issues"},
        {"role": "assistant", "content": "Found an N+1 query in orders.py"},
    ])

    llm = _CapturingLLM()
    result = await _tool(tmp_path, llm).run(agent_id="rev-1", message="now fix it")

    assert result["status"] in ("done", "unverified")
    assert result["resumed"] is True
    joined = "\n".join(llm.prompts)
    # It must be reminded of what IT concluded...
    assert "N+1 query in orders.py" in joined
    # ...and given the follow-up.
    assert "now fix it" in joined
    # The system prompt from the old run is not replayed as content.
    assert "you are a reviewer" not in joined


@pytest.mark.asyncio
async def test_resume_keeps_the_original_role(tmp_path):
    _seed_checkpoint("resume-root", "rev-2", [
        {"role": "user", "content": "task"},
        {"role": "assistant", "content": "done"},
    ], role="security-auditor")

    result = await _tool(tmp_path).run(agent_id="rev-2", message="continue")
    assert result["role"] == "security-auditor"


@pytest.mark.asyncio
async def test_resume_emits_start_and_done_events(tmp_path):
    _seed_checkpoint("resume-root", "rev-3", [
        {"role": "user", "content": "t"}, {"role": "assistant", "content": "a"},
    ])
    seen = []

    async def on_event(kind, data):
        seen.append((kind, data))

    await _tool(tmp_path).run(agent_id="rev-3", message="go", on_event=on_event)

    kinds = [k for k, _ in seen]
    assert "subagent_start" in kinds
    assert "subagent_done" in kinds
    start = next(d for k, d in seen if k == "subagent_start")
    assert start["resumed"] is True, "UI needs to distinguish a resume from a spawn"


# ── Failure modes ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unknown_agent_id_is_a_clean_error(tmp_path):
    result = await _tool(tmp_path).run(agent_id="never-existed", message="go")
    assert result["status"] == "error"
    assert "never-existed" in result["error"]
    # Actionable: tells the model what to do instead of just failing.
    assert "spawn a new agent" in result["error"].lower()


@pytest.mark.asyncio
async def test_missing_agent_id_is_rejected(tmp_path):
    result = await _tool(tmp_path).run(agent_id="  ", message="go")
    assert "error" in result


@pytest.mark.asyncio
async def test_a_checkpoint_with_no_history_is_refused(tmp_path):
    _seed_checkpoint("resume-root", "empty-1", [])
    result = await _tool(tmp_path).run(agent_id="empty-1", message="go")
    assert result["status"] == "error"
    assert "no recoverable history" in result["error"].lower()


@pytest.mark.asyncio
async def test_another_conversations_agent_is_not_reachable(tmp_path):
    """Checkpoints are scoped per conversation — resume must not cross that."""
    _seed_checkpoint("other-conversation", "theirs-1", [
        {"role": "user", "content": "t"}, {"role": "assistant", "content": "a"},
    ])
    result = await _tool(tmp_path, thread_id="resume-root").run(
        agent_id="theirs-1", message="go",
    )
    assert result["status"] == "error"


@pytest.mark.asyncio
async def test_a_crashing_llm_does_not_kill_the_parent(tmp_path):
    _seed_checkpoint("resume-root", "boom-1", [
        {"role": "user", "content": "t"}, {"role": "assistant", "content": "a"},
    ])

    class _Exploding:
        deployment = "fake"

        async def stream_with_tools(self, messages, **kwargs):
            raise RuntimeError("kaboom")
            yield  # pragma: no cover

        async def invoke(self, m, **k):
            return "", {}

    result = await _tool(tmp_path, _Exploding()).run(agent_id="boom-1", message="go")
    assert result["status"] in ("error", "failed")


# ── History rendering ────────────────────────────────────────────────────

def test_history_elides_tool_results_to_one_line():
    """Replaying every byte a child read would refill the context window the
    resume exists to keep lean — the conclusions are what matter."""
    huge = "x" * 50_000
    text = ResumeAgentTool._render_history([
        {"role": "assistant", "content": "I read the file"},
        {"role": "tool", "content": f"line one\n{huge}"},
    ])
    assert "I read the file" in text
    assert len(text) < 2_000
    assert "line one" in text


def test_history_keeps_the_most_recent_reasoning_when_capped():
    msgs = [{"role": "assistant", "content": f"step {i} " + "y" * 400}
            for i in range(100)]
    msgs.append({"role": "assistant", "content": "FINAL CONCLUSION"})
    text = ResumeAgentTool._render_history(msgs)
    assert "FINAL CONCLUSION" in text, "capping dropped the newest reasoning"
    assert "omitted" in text


def test_history_survives_malformed_messages():
    text = ResumeAgentTool._render_history([
        None, "not a dict", {"role": "user"}, {"content": None},
        {"role": "assistant", "content": "kept"},
    ])
    assert "kept" in text


def test_empty_history_renders_a_placeholder():
    assert ResumeAgentTool._render_history([]) == "(no recoverable detail)"
