"""write_artefact tool tests.

The prompt promises this tool; it must (a) write a JSON + Markdown pair,
(b) validate payloads against known schemas, (c) render a fallback Markdown
when none is supplied, and (d) accept generic (unknown-kind) artefacts.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


def _tool(ws):
    from react_core.tools.write_artefact import WriteArtefactTool
    return WriteArtefactTool(str(ws), org_id="org-default", thread_id="t-1")


def test_writes_json_and_markdown_pair(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)

    result = asyncio.run(tool.run(
        kind="test_strategy",
        rel_path="artefacts/test_strategy",
        data={"approach": "risk-based", "techniques": ["BVA", "EP"]},
        markdown="# Test Strategy\n\nRisk-based.",
    ))

    assert "error" not in result
    json_path = Path(result["path_json"])
    md_path = Path(result["path_markdown"])
    assert json_path.exists() and md_path.exists()
    loaded = json.loads(json_path.read_text(encoding="utf-8"))
    assert loaded["approach"] == "risk-based"
    assert md_path.read_text(encoding="utf-8").startswith("# Test Strategy")


def test_renders_fallback_markdown_when_omitted(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)

    result = asyncio.run(tool.run(
        kind="state_model",
        rel_path="artefacts/models/state_model",
        data={"states": [{"id": "PAID"}], "transitions": []},
    ))
    assert "error" not in result
    md = Path(result["path_markdown"]).read_text(encoding="utf-8")
    assert "state_model" in md
    assert "```json" in md


def test_rejects_payload_that_violates_known_schema(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)

    # analysis.acceptance_criteria must be a list of AC-shaped dicts; a string
    # blows up AcceptanceCriterion.from_dict.
    result = asyncio.run(tool.run(
        kind="analysis",
        rel_path="artefacts/analysis",
        data={"summary_one_paragraph": "x", "acceptance_criteria": ["not-a-dict"]},
    ))
    assert "error" in result
    assert "analysis" in result["error"]


def test_known_kind_preserves_all_fields(tmp_path, monkeypatch):
    # A known kind must NOT be coerced to the dataclass (which would drop
    # fields the schema doesn't model) — the full data must survive.
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)

    result = asyncio.run(tool.run(
        kind="test_strategy",
        rel_path="artefacts/sec_strategy",
        data={
            "approach": "OWASP-aligned",
            "owasp_mapping": ["A07:2021 Identification and Authentication Failures"],
            "abuse_cases": [{"id": "SEC-001", "title": "lockout"}],
        },
    ))
    assert "error" not in result
    loaded = json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))
    # Custom (non-TestStrategy) fields must be preserved, not dropped.
    assert loaded["owasp_mapping"] == ["A07:2021 Identification and Authentication Failures"]
    assert loaded["abuse_cases"][0]["id"] == "SEC-001"
    assert loaded["approach"] == "OWASP-aligned"


def test_generic_kind_is_written_as_is(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)

    result = asyncio.run(tool.run(
        kind="custom_notes",
        rel_path="artefacts/notes",
        data={"anything": [1, 2, 3]},
    ))
    assert "error" not in result
    assert json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))["anything"] == [1, 2, 3]


def test_non_object_data_is_rejected(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    tool = _tool(ws)
    result = asyncio.run(tool.run(kind="analysis", rel_path="x", data="nope"))
    assert "error" in result
