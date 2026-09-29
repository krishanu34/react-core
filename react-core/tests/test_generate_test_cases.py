"""generate_test_cases tool tests.

Mirrors the generate_gherkin contract: coverage invariant, JSON+MD pair,
numbered manual steps rendered in the Markdown.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


def _analysis(ac_ids):
    return {
        "source_type": "mixed",
        "summary_one_paragraph": "…",
        "acceptance_criteria": [
            {"id": ac, "statement": f"Statement for {ac}", "testable": True, "source_ref": "brief"}
            for ac in ac_ids
        ],
    }


def _case(cid, ac_refs, **overrides):
    base = {
        "id": cid,
        "title": f"Case {cid}",
        "priority": "high",
        "technique_used": "BVA",
        "preconditions": ["User is logged in"],
        "test_data": {"amount": 100},
        "steps": [
            {"action": "Enter amount", "expected_result": "Amount accepted"},
            {"action": "Submit", "expected_result": "Order confirmed"},
        ],
        "acceptance_criteria_refs": ac_refs,
    }
    base.update(overrides)
    return base


def _tool(ws, tid="t-1"):
    from react_core.tools.generate_test_cases import GenerateTestCasesTool
    return GenerateTestCasesTool(str(ws), org_id="org-default", thread_id=tid)


def test_writes_suite_json_and_markdown(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2"]),
        test_cases_in=[_case("TC-1", ["AC-1"]), _case("TC-2", ["AC-2"])],
        suite_title="Checkout",
        rel_path="artefacts/test_cases/checkout",
    ))

    assert "error" not in result
    assert result["coverage_summary"]["ac_covered"] == 2
    assert result["coverage_summary"]["uncovered"] == []

    data = json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))
    assert data["title"] == "Checkout"
    assert len(data["test_cases"]) == 2
    assert data["test_cases"][0]["steps"][0]["action"] == "Enter amount"

    md = Path(result["path_markdown"]).read_text(encoding="utf-8")
    assert "TC-1 — Case TC-1" in md
    assert "| # | Action | Expected Result |" in md
    assert "Amount accepted" in md
    assert "✅ **AC-1**" in md


def test_refuses_on_coverage_gap(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws, tid="t-2")

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2", "AC-3"]),
        test_cases_in=[_case("TC-1", ["AC-1"])],
        suite_title="Partial",
        rel_path="artefacts/test_cases/partial",
    ))
    assert result["error"] == "AC coverage gap"
    assert result["uncovered"] == ["AC-2", "AC-3"]
    assert not (ws / "artefacts" / "test_cases" / "partial.json").exists()


def test_rejects_case_without_steps(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws, tid="t-3")

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        test_cases_in=[_case("TC-1", ["AC-1"], steps=[])],
        suite_title="NoSteps",
        rel_path="artefacts/test_cases/nosteps",
    ))
    assert "error" in result
    assert "TC-1" in result["cases_without_steps"]


def test_strict_false_writes_despite_gap(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws, tid="t-4")

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2"]),
        test_cases_in=[_case("TC-1", ["AC-1"])],
        suite_title="Loose",
        rel_path="artefacts/test_cases/loose",
        strict=False,
    ))
    assert "error" not in result
    assert result["coverage_summary"]["uncovered"] == ["AC-2"]


def test_accepts_string_steps(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws, tid="t-5")

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        test_cases_in=[_case("TC-1", ["AC-1"], steps=["Open the page", "Click submit"])],
        suite_title="StringSteps",
        rel_path="artefacts/test_cases/stringsteps",
    ))
    assert "error" not in result
    data = json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))
    assert data["test_cases"][0]["steps"][0]["action"] == "Open the page"
