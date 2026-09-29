"""Tests for build_traceability_matrix and export_test_cases."""
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
            {"id": ac, "statement": f"Statement {ac}", "testable": True, "source_ref": "brief"}
            for ac in ac_ids
        ],
    }


# ---- traceability matrix --------------------------------------------------

def test_rtm_cross_references_and_flags_status(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.build_traceability_matrix import BuildTraceabilityMatrixTool
    tool = BuildTraceabilityMatrixTool(str(ws), org_id="org-default", thread_id="t-1")

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2", "AC-3"]),
        scenarios=[{"id": "SC-1", "acceptance_criteria_refs": ["AC-1"]}],
        test_cases=[{"id": "TC-2", "acceptance_criteria_refs": ["AC-2"]}],
        report={"results": [
            {"name": "t_ac2", "status": "failed", "requirement_refs": ["AC-2"]},
        ]},
        rel_path="artefacts/traceability/rtm",
    ))

    assert "error" not in result
    assert result["coverage_summary"] == {
        "ac_total": 3, "ac_covered": 2, "ac_uncovered": 1, "ac_failing": 1,
    }
    data = json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))
    by_ac = {r["requirement_id"]: r for r in data["rows"]}
    assert by_ac["AC-1"]["status"] == "covered"
    assert by_ac["AC-1"]["scenarios"] == ["SC-1"]
    assert by_ac["AC-2"]["status"] == "failing"
    assert by_ac["AC-2"]["test_cases"] == ["TC-2"]
    assert by_ac["AC-3"]["status"] == "uncovered"

    csv_text = Path(result["path_csv"]).read_text(encoding="utf-8")
    assert "Requirement,Statement,Scenarios,Test Cases,Result,Status" in csv_text
    assert "AC-1" in csv_text


def test_rtm_requires_acceptance_criteria(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.build_traceability_matrix import BuildTraceabilityMatrixTool
    tool = BuildTraceabilityMatrixTool(str(ws), thread_id="t-2")
    result = asyncio.run(tool.run(analysis=_analysis([]), rel_path="artefacts/rtm"))
    assert "error" in result


# ---- export ---------------------------------------------------------------

def _suite():
    return {
        "title": "Checkout",
        "test_cases": [
            {
                "id": "TC-1", "title": "Pay with card", "priority": "high",
                "technique_used": "BVA", "preconditions": ["logged in"],
                "test_data": {"amount": 100},
                "steps": [
                    {"action": "Enter card", "expected_result": "accepted"},
                    {"action": "Submit", "expected_result": "confirmed"},
                ],
                "acceptance_criteria_refs": ["AC-1"],
            }
        ],
    }


def test_export_generic_csv(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.export_test_cases import ExportTestCasesTool
    tool = ExportTestCasesTool(str(ws), thread_id="t-3")
    result = asyncio.run(tool.run(suite=_suite(), rel_path="artefacts/exports/checkout"))
    assert "error" not in result
    text = Path(result["path_csv"]).read_text(encoding="utf-8")
    assert "ID,Title,Priority" in text
    assert "TC-1" in text
    assert "1. Enter card -> accepted" in text


def test_export_testrail_and_xray(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.export_test_cases import ExportTestCasesTool
    tool = ExportTestCasesTool(str(ws), thread_id="t-4")

    tr = asyncio.run(tool.run(suite=_suite(), rel_path="artefacts/exports/tr", format="testrail"))
    assert "error" not in tr
    assert "Title,Section,Priority,Preconditions,Steps,Expected Result,References" in \
        Path(tr["path_csv"]).read_text(encoding="utf-8")

    xr = asyncio.run(tool.run(suite=_suite(), rel_path="artefacts/exports/xr", format="xray"))
    assert "error" not in xr
    xtext = Path(xr["path_csv"]).read_text(encoding="utf-8")
    assert "Test Case ID,Summary,Priority,Step,Action,Data,Expected Result,References" in xtext
    # One row per step: two step rows for the single case.
    assert xtext.count("Enter card") == 1 and xtext.count("Submit") == 1


def test_export_rejects_unknown_format(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.export_test_cases import ExportTestCasesTool
    tool = ExportTestCasesTool(str(ws), thread_id="t-5")
    result = asyncio.run(tool.run(suite=_suite(), rel_path="x", format="bogus"))
    assert "error" in result
