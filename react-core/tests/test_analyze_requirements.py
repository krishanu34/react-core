"""analyze_requirements tool tests (deliverable #2)."""
from __future__ import annotations

import asyncio
import json

import pytest


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


class _FakeLLM:
    """Deterministic LLM that returns a canned JSON string per test."""
    model_name = "fake"

    def __init__(self, response: str):
        self._response = response

    async def complete(self, messages, *, temperature=0.2, max_tokens=None, response_format=None):
        return self._response


def _canned(payload: dict) -> str:
    return json.dumps(payload)


def test_analyze_requirements_parses_llm_json(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    llm = _FakeLLM(_canned({
        "source_type": "user_story",
        "summary_one_paragraph": "Small feature",
        "acceptance_criteria": [
            {"id": "AC-1", "statement": "user can log in", "testable": True, "source_ref": "brief"},
        ],
        "ambiguities": [],
        "missing_NFRs": [],
        "unstated_assumptions": [],
        "testability_issues": [],
        "risk_areas": [],
        "suggested_questions": [],
        "state_hints": [],
        "entity_hints": [],
        "cause_effect_hints": [],
        "edge_case_hints": [],
        "gaps_significant": False,
    }))
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: llm)
    result = asyncio.run(tool.run(brief="A user should be able to log in."))
    assert "error" not in result
    assert result["source_type"] == "user_story"
    assert result["acceptance_criteria"][0]["id"] == "AC-1"
    assert result["gaps_significant"] is False


def test_analyze_requirements_rederives_gaps_significant_from_fields(tmp_path, monkeypatch):
    """Even if the LLM lies (gaps_significant=false), the tool overrides
    when the fields say otherwise."""
    _fresh(tmp_path, monkeypatch)
    llm = _FakeLLM(_canned({
        "source_type": "mixed",
        "summary_one_paragraph": "…",
        "acceptance_criteria": [],   # ← empty
        "ambiguities": [],
        "missing_NFRs": [],
        "gaps_significant": False,   # ← LLM lied
    }))
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: llm)
    result = asyncio.run(tool.run(brief="Vague."))
    assert result["gaps_significant"] is True   # ← overridden


def test_analyze_requirements_flags_gaps_on_high_ambiguity(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    llm = _FakeLLM(_canned({
        "source_type": "user_story",
        "summary_one_paragraph": "…",
        "acceptance_criteria": [{"id": "AC-1", "statement": "x", "testable": True}],
        "ambiguities": [{"text": "which cloud?", "impact": "high"}],
        "missing_NFRs": [],
        "gaps_significant": False,
    }))
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: llm)
    result = asyncio.run(tool.run(brief="Ambiguous stack."))
    assert result["gaps_significant"] is True


def test_analyze_requirements_requires_brief(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    llm = _FakeLLM("{}")
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: llm)
    result = asyncio.run(tool.run(brief=""))
    assert "error" in result


def test_analyze_requirements_handles_unparseable_llm_output(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    llm = _FakeLLM("this is not JSON at all")
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: llm)
    result = asyncio.run(tool.run(brief="anything"))
    assert "error" in result
    assert "unparseable" in result["error"].lower() or "json" in result["error"].lower()


def test_analyze_requirements_registered_in_qa_profile():
    from react_core.tools.registry import ToolRegistry
    reg = ToolRegistry.build_for_workspace(".", thread_id="t")
    assert "analyze_requirements" in reg.names()


# ---- `fetched` shape tolerance -------------------------------------------
# Regression: LLMs pass `fetched` as a plain string ("Jira lookup failed…"),
# a bare dict, or a list of strings. The tool must not raise AttributeError
# on any of those.

def _ok_llm() -> _FakeLLM:
    return _FakeLLM(_canned({
        "source_type": "user_story",
        "summary_one_paragraph": "…",
        "acceptance_criteria": [
            {"id": "AC-1", "statement": "x", "testable": True, "source_ref": "brief"},
        ],
        "ambiguities": [], "missing_NFRs": [], "unstated_assumptions": [],
        "testability_issues": [], "risk_areas": [], "suggested_questions": [],
        "state_hints": [], "entity_hints": [], "cause_effect_hints": [],
        "edge_case_hints": [], "gaps_significant": False,
    }))


def test_analyze_requirements_accepts_fetched_as_string(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: _ok_llm())
    result = asyncio.run(tool.run(
        brief="A story",
        fetched="Attempted to fetch Jira TELCO-1, but the connector failed.",
    ))
    assert "error" not in result
    assert result["acceptance_criteria"][0]["id"] == "AC-1"


def test_analyze_requirements_accepts_fetched_as_dict(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: _ok_llm())
    result = asyncio.run(tool.run(
        brief="A story",
        fetched={"source": "user_context", "user_decision": "Approve provisional suite"},
    ))
    assert "error" not in result


def test_analyze_requirements_accepts_fetched_as_list_of_strings(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    from react_core.tools.analyze_requirements import AnalyzeRequirementsTool
    tool = AnalyzeRequirementsTool(".", llm_factory=lambda: _ok_llm())
    result = asyncio.run(tool.run(
        brief="A story",
        fetched=["note one", "note two"],
    ))
    assert "error" not in result


def test_analyze_requirements_normalize_fetched_shapes():
    from react_core.tools.analyze_requirements import _normalize_fetched
    assert _normalize_fetched(None) == []
    assert _normalize_fetched("hello") == [{"source": "context", "text": "hello"}]
    dict_out = _normalize_fetched({"source": "S", "text": "T"})
    assert dict_out == [{"source": "S", "text": "T"}]
    list_out = _normalize_fetched(["a", "b"])
    assert list_out == [
        {"source": "item-1", "text": "a"},
        {"source": "item-2", "text": "b"},
    ]
    # Non-conventional keys are flattened into the text so nothing is lost.
    weird = _normalize_fetched({"source": "S", "note": "hello", "count": 3})
    assert weird[0]["source"] == "S"
    assert "note: hello" in weird[0]["text"]
    assert "count: 3" in weird[0]["text"]
