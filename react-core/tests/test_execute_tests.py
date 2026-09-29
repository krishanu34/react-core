"""execute_tests tool tests — runs a trivial command and parses a JUnit XML
into a TestReport artefact.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


_JUNIT = """<?xml version="1.0"?>
<testsuite name="suite" tests="3" failures="1" skipped="1">
  <testcase classname="test_login.AC-1" name="test_valid_login" time="0.10"/>
  <testcase classname="test_login.AC-2" name="test_invalid_login" time="0.20">
    <failure message="assertion failed">stacktrace here</failure>
  </testcase>
  <testcase classname="test_login" name="test_maintenance" time="0.0">
    <skipped/>
  </testcase>
</testsuite>
"""


def _tool(ws, tid="t-1"):
    from react_core.tools.execute_tests import ExecuteTestsTool
    return ExecuteTestsTool(str(ws), org_id="org-default", thread_id=tid)


def test_parses_junit_xml_into_report(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    (ws / "report.xml").write_text(_JUNIT, encoding="utf-8")
    tool = _tool(ws)

    result = asyncio.run(tool.run(
        command="echo running",
        junit_xml_path="report.xml",
        framework="pytest",
        rel_path="artefacts/reports/run-1",
    ))

    assert "error" not in result
    assert result["total"] == 3
    assert result["passed"] == 1
    assert result["failed"] == 1
    assert result["skipped"] == 1

    data = json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))
    assert data["framework"] == "pytest"
    by_name = {r["name"]: r for r in data["results"]}
    assert by_name["test_valid_login"]["status"] == "passed"
    assert by_name["test_valid_login"]["requirement_refs"] == ["AC-1"]
    assert by_name["test_invalid_login"]["status"] == "failed"
    assert by_name["test_invalid_login"]["requirement_refs"] == ["AC-2"]

    md = Path(result["path_markdown"]).read_text(encoding="utf-8")
    assert "Test Report" in md
    assert "AC-1" in md


def test_falls_back_to_stdout_counts(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws, tid="t-2")

    # No JUnit path — parse the echoed summary line from stdout.
    result = asyncio.run(tool.run(
        command="echo 4 passed, 1 failed",
        rel_path="artefacts/reports/run-2",
    ))
    assert "error" not in result
    assert result["passed"] == 4
    assert result["failed"] == 1


def test_requires_command_and_path(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws, tid="t-3")
    assert "error" in asyncio.run(tool.run(command="", rel_path="x"))
