"""Tests for the web-IDE file endpoints and format validators."""
from __future__ import annotations

import asyncio
import json

import pytest


# ---- validators (unit-level) --------------------------------------------

def test_validate_markdown_accepts_anything():
    from react_core.artefacts.validators import validate
    assert validate("features/x.md", "arbitrary text here") == []


def test_validate_json_rejects_bad_json():
    from react_core.artefacts.validators import validate
    issues = validate("features/foo.json", "{not json")
    assert issues
    assert "JSON parse error" in issues[0].message


def test_validate_gherkin_json_requires_shape():
    from react_core.artefacts.validators import validate
    missing = validate("features/foo.json", json.dumps({"feature": "F"}))
    assert any("scenarios" in i.message for i in missing)


def test_validate_gherkin_json_requires_step_kind():
    from react_core.artefacts.validators import validate
    bad = validate(
        "features/foo.json",
        json.dumps({
            "feature": "F",
            "scenarios": [{
                "name": "S",
                "steps": [{"kind": "xxx", "text": "…"}],
            }],
        }),
    )
    assert any("kind" in i.message for i in bad)


def test_validate_gherkin_json_accepts_valid_shape():
    from react_core.artefacts.validators import validate
    ok = validate(
        "features/foo.json",
        json.dumps({
            "feature": "F",
            "scenarios": [{
                "name": "S",
                "steps": [
                    {"kind": "given", "text": "a precondition"},
                    {"kind": "then", "text": "a result"},
                ],
            }],
        }),
    )
    assert ok == []


def test_validate_gherkin_feature_requires_feature_and_scenario():
    from react_core.artefacts.validators import validate
    empty = validate("features/x.feature", "")
    assert any("Missing `Feature:`" in i.message for i in empty)

    only_feature = validate("features/x.feature", "Feature: Foo\n")
    assert any("Scenario" in i.message for i in only_feature)


def test_validate_gherkin_feature_step_before_scenario_is_error():
    from react_core.artefacts.validators import validate
    text = (
        "Feature: Foo\n"
        "  Given something\n"   # step outside a scenario
    )
    bad = validate("features/x.feature", text)
    assert any("outside a Scenario" in i.message for i in bad)


def test_validate_gherkin_feature_accepts_valid_document():
    from react_core.artefacts.validators import validate
    text = (
        "Feature: Foo\n"
        "  Description line\n"
        "\n"
        "  @requirement:AC-1\n"
        "  Scenario: Happy path\n"
        "    Given a precondition\n"
        "    When an action\n"
        "    Then an outcome\n"
    )
    assert validate("features/x.feature", text) == []


def test_validate_gherkin_feature_accepts_examples_block():
    from react_core.artefacts.validators import validate
    text = (
        "Feature: F\n"
        "  Scenario Outline: Boundaries\n"
        "    Given a value <n>\n"
        "    Then result is <r>\n"
        "    Examples:\n"
        "      | n | r |\n"
        "      | 0 | rejected |\n"
        "      | 1 | accepted |\n"
    )
    assert validate("features/x.feature", text) == []


# ---- API endpoints ------------------------------------------------------

def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)
    from fastapi.testclient import TestClient
    from react_core.app.main import app, memory
    return TestClient(app), memory


def test_files_list_returns_workspace_tree(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-listing"
    ws = tmp_path / "ws"
    (ws / "features" / tid / "docs").mkdir(parents=True)
    (ws / "features" / tid / "docs" / "a.feature").write_text("Feature: A\n", encoding="utf-8")
    (ws / "features" / tid / "docs" / "a.json").write_text('{"feature": "A", "scenarios": []}', encoding="utf-8")
    memory.set_workspace(tid, str(ws))

    r = client.get(f"/api/agent/files/{tid}")
    assert r.status_code == 200
    body = r.json()
    paths = [f["path"] for f in body["files"]]
    assert f"features/{tid}/docs/a.feature" in paths
    assert f"features/{tid}/docs/a.json" in paths
    kinds = {f["path"]: f["kind"] for f in body["files"]}
    assert kinds[f"features/{tid}/docs/a.feature"] == "feature"
    assert kinds[f"features/{tid}/docs/a.json"] == "json"


def test_files_list_returns_empty_for_unknown_thread(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.get("/api/agent/files/does-not-exist")
    assert r.status_code == 200
    assert r.json()["files"] == []


def test_file_read_returns_content(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-read"
    ws = tmp_path / "ws"
    (ws / "features" / tid / "docs").mkdir(parents=True)
    (ws / "features" / tid / "docs" / "foo.md").write_text("# Hello\n", encoding="utf-8")
    memory.set_workspace(tid, str(ws))

    r = client.get(
        f"/api/agent/files/{tid}/content",
        params={"path": f"features/{tid}/docs/foo.md"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["content"] == "# Hello\n"
    assert body["kind"] == "markdown"


def test_file_read_rejects_path_escape(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-esc"
    (tmp_path / "ws").mkdir()
    memory.set_workspace(tid, str(tmp_path / "ws"))
    r = client.get(
        f"/api/agent/files/{tid}/content",
        params={"path": "../secret.txt"},
    )
    assert r.status_code == 400


def test_file_write_accepts_valid_gherkin(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-w-good"
    ws = tmp_path / "ws"
    ws.mkdir()
    memory.set_workspace(tid, str(ws))

    text = (
        "Feature: F\n"
        "  Scenario: S\n"
        "    Given a precondition\n"
        "    Then an outcome\n"
    )
    r = client.put(
        f"/api/agent/files/{tid}/content",
        json={"path": f"features/{tid}/docs/edit.feature", "content": text},
    )
    assert r.status_code == 200, r.text
    assert (ws / "features" / tid / "docs" / "edit.feature").read_text(encoding="utf-8") == text


def test_file_write_rejects_malformed_gherkin(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-w-bad"
    ws = tmp_path / "ws"
    ws.mkdir()
    memory.set_workspace(tid, str(ws))

    r = client.put(
        f"/api/agent/files/{tid}/content",
        json={"path": f"features/{tid}/docs/edit.feature", "content": "Only some text\n"},
    )
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "validation_failed"
    assert body["issues"]


def test_file_write_rejects_malformed_gherkin_json(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-w-badj"
    ws = tmp_path / "ws"
    ws.mkdir()
    memory.set_workspace(tid, str(ws))

    r = client.put(
        f"/api/agent/files/{tid}/content",
        json={
            "path": f"features/{tid}/docs/edit.json",
            "content": json.dumps({"feature": "F"}),  # missing scenarios
        },
    )
    assert r.status_code == 422
    assert "scenarios" in r.json()["issues"][0]["message"]


def test_file_write_accepts_markdown_freeform(tmp_path, monkeypatch):
    client, memory = _client(tmp_path, monkeypatch)
    tid = "t-w-md"
    ws = tmp_path / "ws"
    ws.mkdir()
    memory.set_workspace(tid, str(ws))
    r = client.put(
        f"/api/agent/files/{tid}/content",
        json={"path": f"features/{tid}/docs/edit.md", "content": "# Notes\n\nAnything goes."},
    )
    assert r.status_code == 200


# ---- generate_gherkin path scoping --------------------------------------

def _analysis(ac_ids: list[str]) -> dict:
    return {
        "source_type": "mixed",
        "summary_one_paragraph": "…",
        "acceptance_criteria": [
            {"id": ac, "statement": f"Statement for {ac}", "testable": True, "source_ref": "brief"}
            for ac in ac_ids
        ],
        "ambiguities": [], "missing_NFRs": [], "unstated_assumptions": [],
        "testability_issues": [], "risk_areas": [], "suggested_questions": [],
        "state_hints": [], "entity_hints": [], "cause_effect_hints": [],
        "edge_case_hints": [], "gaps_significant": False,
    }


def _scenario(sid: str, ac_refs: list[str]) -> dict:
    return {
        "id": sid,
        "title": f"Scenario {sid}",
        "priority": "high",
        "technique_used": "risk-based",
        "acceptance_criteria_refs": ac_refs,
        "steps": [
            {"kind": "given", "text": "a precondition"},
            {"kind": "then",  "text": "an outcome"},
        ],
    }


def test_generate_gherkin_writes_under_thread_docs(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)
    from react_core.tools.generate_gherkin import GenerateGherkinTool

    ws = tmp_path / "workspace"
    ws.mkdir()
    tid = "t-scoping"

    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id=tid)
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[_scenario("TC-1", ["AC-1"])],
        feature_title="Scoped",
        # LLM might name anything; the tool should still land it under features/<tid>/docs/
        rel_path="artefacts/features/checkout.feature",
    ))
    assert "error" not in result, result
    # All three files should be under features/<thread_id>/docs/checkout.*
    for key in ("path_feature", "path_json", "path_summary"):
        p = str(result[key]).replace("\\", "/")
        assert f"/features/{tid}/docs/checkout." in p, p


def test_generate_gherkin_scope_is_idempotent_for_deep_paths(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)
    from react_core.tools.generate_gherkin import GenerateGherkinTool

    ws = tmp_path / "workspace"
    ws.mkdir()
    tid = "t-scoping-2"

    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id=tid)
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[_scenario("TC-1", ["AC-1"])],
        feature_title="Nested",
        rel_path=f"features/{tid}/docs/nested.feature",
    ))
    assert "error" not in result
    p = str(result["path_feature"]).replace("\\", "/")
    # No double-scoping.
    assert p.count(f"features/{tid}/docs/") == 1
