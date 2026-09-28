"""
What a sub-agent reports to the UI.

A real three-agent run rendered as a wall of truncated prompt text, flat tool
rows, and terminal output orphaned at the bottom of the page. These cover the
server half of that: what goes into subagent_start, and which child events get
attributed to the agent that produced them.
"""

from __future__ import annotations

import pytest

from context.permissions import MODE_AUTO, PermissionConfig, set_config
from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
from tools.sub_agent_tool import SubAgentTool, _summarize_task


@pytest.fixture
def unattended():
    """These tests are about what a child REPORTS, not about approval. The
    default mode is `manual`, so without this a stubbed run_terminal parks on
    an approval prompt and the assertions never get to run — which is correct
    product behaviour and useless test setup."""
    set_config(".", PermissionConfig(mode=MODE_AUTO))


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


def _spawner(tmp_path):
    return SubAgentTool(
        str(tmp_path), llm=_FakeLLM(),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id="root",
    )


# ── Task summary: readable, never cut mid-word ───────────────────────────

def test_long_instruction_is_cut_on_a_word_boundary():
    """The real run showed fragments like '...and archit', which reads as
    corruption rather than truncation."""
    task = (
        "Create the entire backend under backend/** including pyproject.toml, "
        "app entrypoint, config, database, models, schemas, services, API routers, "
        "Alembic config and initial migration, seed script, and focused tests"
    )
    out = _summarize_task(task)
    assert len(out) <= 141
    assert out.endswith("…")
    # The character before the ellipsis must end a word.
    assert not out[-2].isspace()
    assert task.startswith(out[:-1].rstrip("…").rstrip())


def test_first_sentence_is_preferred_when_it_stands_alone():
    task = "Build the AWS Terraform root completely and verify it. Report every file you touched."
    assert _summarize_task(task) == "Build the AWS Terraform root completely and verify it"


def test_short_task_is_returned_whole():
    assert _summarize_task("Create the seed script") == "Create the seed script"


def test_whitespace_and_newlines_are_collapsed():
    assert _summarize_task("Do  this\n\n  and that") == "Do this and that"


@pytest.mark.parametrize("value", ["", "   ", None])
def test_empty_task_does_not_render_blank(value):
    assert _summarize_task(value) == "(no task given)"


# ── Attribution: every child event carries its agent_id ──────────────────

@pytest.mark.asyncio
async def test_start_event_carries_what_the_card_needs(tmp_path):
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    await _spawner(tmp_path).run(
        task="Build the API layer and report the files you created",
        role="api-builder", owns_paths=["backend/**"], on_event=on_event,
    )
    assert seen["role"] == "api-builder"
    assert seen["depth"] == 1          # drives indentation of nested agents
    assert seen["owns_paths"] == ["backend/**"]
    assert "\n" not in seen["task"]    # one line, fits a card header


@pytest.mark.asyncio
async def test_terminal_events_from_a_child_are_tagged(tmp_path, unattended):
    """Untagged, a child's build log rendered as an orphaned block at the
    bottom of the parent's timeline — and with several agents running, three
    logs interleaved out of order."""
    forwarded = []

    class _TerminalTool(_StubTool):
        SUPPORTS_STREAMING = True

        def __init__(self, workspace):
            super().__init__(workspace, name="run_terminal")

        async def run(self, on_event=None, **kwargs):
            if on_event:
                await on_event("terminal_start", {"command": "npm run build"})
                await on_event("terminal_output", {"line": "building..."})
                await on_event("terminal_done", {"exit_code": 0})
            return "ok"

    class _CallsTerminalLLM(_FakeLLM):
        def __init__(self):
            self.turns = 0

        async def stream_with_tools(self, messages, **kwargs):
            from types import SimpleNamespace
            self.turns += 1
            if self.turns == 1:
                yield "tool_calls", [SimpleNamespace(id="c0", name="run_terminal", arguments={})]
            else:
                yield "content", "done"
            yield "usage", {"total_tokens": 1}

    async def on_event(kind, data):
        forwarded.append((kind, data))

    tool = SubAgentTool(
        str(tmp_path), llm=_CallsTerminalLLM(),
        tool_registry=ToolRegistry([_TerminalTool(str(tmp_path))]),
        thread_id="root",
    )
    await tool.run(task="build it", role="builder",
                   owns_paths=["frontend/**"], on_event=on_event)

    terminal_events = [(k, d) for k, d in forwarded if k.startswith("terminal_")]
    assert terminal_events, "child terminal events must reach the UI"
    for kind, data in terminal_events:
        assert data.get("agent_id"), f"{kind} was not attributed to its agent"


@pytest.mark.asyncio
async def test_child_narration_does_not_leak_to_the_parent_timeline(tmp_path):
    """Context isolation is the point of a sub-agent — its prose belongs in its
    report, not streamed into the parent's answer."""
    kinds = []

    async def on_event(kind, data):
        kinds.append(kind)

    await _spawner(tmp_path).run(task="investigate", on_event=on_event)
    assert "content" not in kinds
    assert "final" not in kinds
