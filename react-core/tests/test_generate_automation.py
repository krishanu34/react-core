"""generate_automation tool tests.

LLM-backed: a fake LLM returns a canned file manifest. We verify the bundle
is written under target_dir, path-escape entries are skipped, and reading
`.feature` files by path feeds the model.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


class _FakeLLM:
    model_name = "fake"

    def __init__(self, response, capture=None):
        self._response = response
        self._capture = capture

    async def complete(self, messages, *, temperature=0.2, max_tokens=None, response_format=None):
        if self._capture is not None:
            self._capture.append(messages[0]["content"])
        return self._response


def _manifest(files, run_command="pytest"):
    return json.dumps({
        "files": files,
        "run_command": run_command,
        "setup_command": "pip install -r requirements.txt",
        "notes": "assumes a running app at localhost:3000",
    })


def _tool(ws, llm, tid="t-1"):
    from react_core.tools.generate_automation import GenerateAutomationTool
    return GenerateAutomationTool(
        str(ws), org_id="org-default", thread_id=tid, llm_factory=lambda: llm,
    )


def test_writes_bundle_from_inline_scenarios(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([
        {"path": "conftest.py", "content": "# fixtures\n"},
        {"path": "tests/test_login.py", "content": "# @requirement:AC-1\ndef test_login():\n    assert True\n"},
    ]))
    tool = _tool(ws, llm)

    result = asyncio.run(tool.run(
        framework="playwright-pytest",
        scenarios=[{"id": "TC-1", "title": "login", "acceptance_criteria_refs": ["AC-1"]}],
    ))

    assert "error" not in result
    assert result["run_command"] == "pytest"
    assert set(result["files_written"]) == {"automation/conftest.py", "automation/tests/test_login.py"}
    written = (ws / "automation" / "tests" / "test_login.py").read_text(encoding="utf-8")
    assert "@requirement:AC-1" in written


def test_reads_feature_files_into_prompt(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    (ws / "features").mkdir(parents=True)
    (ws / "features" / "checkout.feature").write_text(
        "Feature: Checkout\n  Scenario: pay\n    Given a cart\n", encoding="utf-8"
    )
    captured: list[str] = []
    llm = _FakeLLM(_manifest([{"path": "spec.js", "content": "// test\n"}]), capture=captured)
    tool = _tool(ws, llm, tid="t-2")

    result = asyncio.run(tool.run(
        framework="cypress",
        feature_paths=["features/checkout.feature"],
        target_dir="e2e",
    ))
    assert "error" not in result
    assert result["files_written"] == ["e2e/spec.js"]
    # The feature file content must have reached the model.
    assert "Feature: Checkout" in captured[0]


def test_path_escape_entries_are_skipped(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([
        {"path": "../evil.py", "content": "bad"},
        {"path": "ok.py", "content": "good"},
    ]))
    tool = _tool(ws, llm, tid="t-3")

    result = asyncio.run(tool.run(framework="pytest", scenarios=["do a thing"]))
    assert result["files_written"] == ["automation/ok.py"]
    assert any(s["path"] == "../evil.py" for s in result["skipped"])
    assert not (tmp_path / "evil.py").exists()


def test_accepts_dict_framework_and_notes(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([{"path": "spec.py", "content": "# test\n"}]))
    tool = _tool(ws, llm, tid="t-6")
    # notes passed as a dict must not crash.
    result = asyncio.run(tool.run(
        framework="pytest",
        scenarios=["do a thing"],
        notes={"lang": "python", "style": "page-object"},
    ))
    assert "error" not in result
    assert result["files_written"] == ["automation/spec.py"]


def test_errors_when_no_source(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([{"path": "x.py", "content": "y"}]))
    tool = _tool(ws, llm, tid="t-4")
    result = asyncio.run(tool.run(framework="pytest"))
    assert "error" in result


def test_errors_when_manifest_has_no_files(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(json.dumps({"files": [], "run_command": "pytest"}))
    tool = _tool(ws, llm, tid="t-5")
    result = asyncio.run(tool.run(framework="pytest", scenarios=["x"]))
    assert "error" in result
