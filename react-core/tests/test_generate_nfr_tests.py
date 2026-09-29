"""generate_nfr_tests tool tests (performance / security scaffolding)."""
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


def _manifest(files, run_command="k6 run script.js"):
    return json.dumps({
        "files": files, "run_command": run_command,
        "setup_command": "", "notes": "p95 < 500ms",
    })


def _tool(ws, llm, tid="t-1"):
    from react_core.tools.generate_nfr_tests import GenerateNfrTestsTool
    return GenerateNfrTestsTool(str(ws), thread_id=tid, llm_factory=lambda: llm)


def test_performance_bundle(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    captured: list[str] = []
    llm = _FakeLLM(_manifest([{"path": "script.js", "content": "// k6\n"}]), capture=captured)
    tool = _tool(ws, llm)

    result = asyncio.run(tool.run(
        discipline="performance",
        framework="k6",
        context="GET /api/checkout at 200 rps",
        target_dir="perf",
    ))
    assert "error" not in result
    assert result["files_written"] == ["perf/script.js"]
    assert result["run_command"] == "k6 run script.js"
    assert "performance" in captured[0].lower()


def test_security_bundle(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([{"path": "zap.yaml", "content": "jobs: []\n"}], run_command="zap"))
    tool = _tool(ws, llm, tid="t-2")

    result = asyncio.run(tool.run(
        discipline="security",
        framework="zap",
        context="Auth endpoints /login /reset",
    ))
    assert "error" not in result
    assert result["files_written"] == ["nfr/zap.yaml"]
    assert result["discipline"] == "security"


def test_rejects_unknown_discipline(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([{"path": "x", "content": "y"}]))
    tool = _tool(ws, llm, tid="t-3")
    result = asyncio.run(tool.run(discipline="chaos", framework="k6", context="x"))
    assert "error" in result


def test_accepts_dict_context_and_notes(tmp_path, monkeypatch):
    # LLMs sometimes pass a dict where a string is expected — must not crash.
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([{"path": "script.js", "content": "// k6\n"}]))
    tool = _tool(ws, llm, tid="t-6")

    result = asyncio.run(tool.run(
        discipline="performance",
        framework="k6",
        context={"endpoint": "/api/checkout", "rps": 200},
        notes={"base_url": "https://staging"},
    ))
    assert "error" not in result
    assert result["files_written"] == ["nfr/script.js"]


def test_requires_context(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    llm = _FakeLLM(_manifest([{"path": "x", "content": "y"}]))
    tool = _tool(ws, llm, tid="t-4")
    result = asyncio.run(tool.run(discipline="performance", framework="k6", context=""))
    assert "error" in result
