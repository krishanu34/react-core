"""
The complexity trigger (§9).

_should_plan used to match a hardcoded English keyword set against the input.
These are the cases that silently skipped the think-first pass entirely — and
therefore could never decompose, no matter how large the work was.
"""

from __future__ import annotations

import pytest

from agents.tool_use_agent import ToolUseAgent


def _agent():
    return ToolUseAgent(llm=None)


# ── Cases the old keyword gate got wrong ─────────────────────────────────

def test_short_but_huge_request_is_analysed():
    """4 words — the old 8-word floor discarded this outright."""
    assert _agent()._should_plan("migrate everything to Postgres")


def test_non_english_request_is_analysed():
    """No English keyword can match — the old gate skipped every one."""
    assert _agent()._should_plan("Ajoute l'authentification a cette application")
    assert _agent()._should_plan("このアプリに認証機能を追加してください")


def test_inflected_verb_is_analysed():
    """'refactoring' never matched the 'refactor' token."""
    assert _agent()._should_plan("refactoring the payments module please")


def test_no_keyword_but_real_work_is_analysed():
    assert _agent()._should_plan("the login page throws a 500 on submit")


# ── Trivia still short-circuits ──────────────────────────────────────────

@pytest.mark.parametrize("msg", ["hi", "thanks", "yes", "ok", "  ", ""])
def test_trivial_messages_skip_the_analysis_call(msg):
    assert not _agent()._should_plan(msg)


def test_none_input_is_safe():
    assert not _agent()._should_plan(None)


# ── Assessment parsing ───────────────────────────────────────────────────

def test_assessment_parses_decomposition_block():
    analysis = (
        "Some reasoning here.\n"
        '```json\n{"complexity": "complex", "decompose": true, '
        '"suggested_agents": [{"role": "api", "task": "build endpoints"}]}\n```'
    )
    a = ToolUseAgent._parse_assessment(analysis)
    assert a["complexity"] == "complex"
    assert a["decompose"] is True
    assert a["suggested_agents"][0]["role"] == "api"


def test_assessment_absent_block_is_not_an_error():
    a = ToolUseAgent._parse_assessment("Just prose, no JSON at all.")
    assert a == {}


def test_assessment_malformed_block_degrades():
    a = ToolUseAgent._parse_assessment('```json\n{"complexity": ')
    assert a == {}


def test_assessment_non_list_agents_is_coerced():
    analysis = '```json\n{"complexity": "simple", "decompose": false, "suggested_agents": "none"}\n```'
    a = ToolUseAgent._parse_assessment(analysis)
    assert a["suggested_agents"] == []
    assert a["decompose"] is False


def test_keyword_list_is_gone():
    """Guard against the static gate being reintroduced."""
    assert not hasattr(ToolUseAgent, "_TASK_KEYWORDS")
