"""generate_gherkin tool tests (deliverable #4).

Coverage invariant: every AC in the analysis must have >=1 scenario.
Traceability tags: @requirement:, @technique:, @priority: on every scenario.
Scenario Outline: `examples` triggers `Scenario Outline` + `Examples:` block.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


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


def _scenario(sid: str, ac_refs: list[str], **overrides) -> dict:
    base = {
        "id": sid,
        "title": f"Scenario {sid}",
        "priority": "high",
        "technique_used": "risk-based",
        "acceptance_criteria_refs": ac_refs,
        "steps": [
            {"kind": "given", "text": "a precondition"},
            {"kind": "when", "text": "an action"},
            {"kind": "then", "text": "an outcome"},
        ],
    }
    base.update(overrides)
    return base


def test_generate_gherkin_writes_feature_and_summary(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()

    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-1")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2"]),
        scenarios_in=[
            _scenario("TC-1", ["AC-1"]),
            _scenario("TC-2", ["AC-2"], technique_used="BVA"),
        ],
        feature_title="Checkout",
        rel_path="artefacts/features/checkout.feature",
    ))

    assert "error" not in result
    assert result["coverage_summary"]["ac_covered"] == 2
    assert result["coverage_summary"]["uncovered"] == []
    assert set(result["coverage_summary"]["techniques_used"]) == {"BVA", "risk-based"}

    feature_text = Path(result["path_feature"]).read_text(encoding="utf-8")
    assert "Feature: Checkout" in feature_text
    assert "@requirement:AC-1" in feature_text
    assert "@requirement:AC-2" in feature_text
    assert "@technique:BVA" in feature_text
    assert "Given a precondition" in feature_text

    summary = Path(result["path_summary"]).read_text(encoding="utf-8")
    assert "Coverage Summary" in summary
    assert "✅ **AC-1**" in summary


def test_generate_gherkin_refuses_when_coverage_gap(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-2")

    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2", "AC-3"]),
        scenarios_in=[_scenario("TC-1", ["AC-1"])],   # covers AC-1 only
        feature_title="Partial",
        rel_path="artefacts/features/partial.feature",
    ))
    assert "error" in result and result["error"] == "AC coverage gap"
    assert result["uncovered"] == ["AC-2", "AC-3"]
    # No file written on refusal.
    assert not (ws / "artefacts" / "features" / "partial.feature").exists()


def test_generate_gherkin_strict_false_writes_despite_gap(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-3")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2"]),
        scenarios_in=[_scenario("TC-1", ["AC-1"])],
        feature_title="Partial",
        rel_path="artefacts/features/partial.feature",
        strict=False,
    ))
    assert "error" not in result
    assert result["coverage_summary"]["uncovered"] == ["AC-2"]


def test_generate_gherkin_scenario_outline_renders_examples_block(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-4")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[
            _scenario(
                "TC-1", ["AC-1"], technique_used="BVA",
                steps=[
                    {"kind": "given", "text": "a value <n>"},
                    {"kind": "when",  "text": "the caller submits it"},
                    {"kind": "then",  "text": "the result is <r>"},
                ],
                examples=[{"n": "0", "r": "rejected"}, {"n": "1", "r": "accepted"}],
            ),
        ],
        feature_title="Boundaries",
        rel_path="artefacts/features/boundary.feature",
    ))
    assert "error" not in result
    text = Path(result["path_feature"]).read_text(encoding="utf-8")
    assert "Scenario Outline: Scenario TC-1" in text
    assert "Examples:" in text
    assert "| n | r |" in text
    assert "| 0 | rejected |" in text
    assert "| 1 | accepted |" in text


def test_generate_gherkin_json_sidecar_serialisable(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-5")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[_scenario("TC-1", ["AC-1"])],
        feature_title="Sidecar",
        rel_path="artefacts/features/sidecar.feature",
    ))
    payload = json.loads(Path(result["path_json"]).read_text(encoding="utf-8"))
    assert payload["feature"] == "Sidecar"
    assert payload["scenarios"][0]["acceptance_criteria_refs"] == ["AC-1"]
    assert payload["coverage_summary"]["ac_covered"] == 1


def test_generate_gherkin_registered_in_qa_profile():
    from react_core.tools.registry import ToolRegistry
    reg = ToolRegistry.build_for_workspace(".", thread_id="t")
    assert "generate_gherkin" in reg.names()


# ---- LLM shape tolerance -------------------------------------------------
# Regression: Gemini frequently emits steps as raw strings ("Given a
# precondition") instead of {kind, text} dicts. Also sometimes emits the
# whole `background` or `steps` list as a single \n-joined blob. The tool
# must survive all three shapes.

def test_generate_gherkin_accepts_string_steps(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-str")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[{
            "id": "TC-1",
            "title": "String steps",
            "priority": "high",
            "technique_used": "risk-based",
            "acceptance_criteria_refs": ["AC-1"],
            "steps": [
                "Given the cart has one item",
                "When the user checks out",
                "Then the order is created",
                "And a receipt is emailed",
            ],
        }],
        feature_title="StringSteps",
        rel_path="artefacts/features/strsteps.feature",
    ))
    assert "error" not in result
    text = Path(result["path_feature"]).read_text(encoding="utf-8")
    assert "Given the cart has one item" in text
    assert "When the user checks out" in text
    assert "Then the order is created" in text
    assert "And a receipt is emailed" in text


def test_generate_gherkin_accepts_mixed_step_shapes(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-mix")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[{
            "id": "TC-1",
            "title": "Mixed",
            "priority": "medium",
            "technique_used": "EP",
            "acceptance_criteria_refs": ["AC-1"],
            "steps": [
                {"kind": "given", "text": "the cart has one item"},
                "When the user pays",           # raw string
                {"text": "Then the order is created"},   # dict, no kind, leading keyword in text
            ],
        }],
        feature_title="Mixed",
        rel_path="artefacts/features/mixed.feature",
    ))
    assert "error" not in result
    text = Path(result["path_feature"]).read_text(encoding="utf-8")
    # All three forms should render as canonical Gherkin lines.
    assert "Given the cart has one item" in text
    assert "When the user pays" in text
    assert "Then the order is created" in text


def test_generate_gherkin_accepts_blob_steps(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-blob")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[{
            "id": "TC-1",
            "title": "Blob",
            "priority": "low",
            "technique_used": "risk-based",
            "acceptance_criteria_refs": ["AC-1"],
            "steps": "Given a start\nWhen an action\nThen an end\n",
            "background": "Given the system is up",
        }],
        feature_title="Blob",
        rel_path="artefacts/features/blob.feature",
    ))
    assert "error" not in result
    text = Path(result["path_feature"]).read_text(encoding="utf-8")
    assert "Given the system is up" in text
    assert "Given a start" in text
    assert "When an action" in text
    assert "Then an end" in text


# ---- AC-reference shape tolerance ----------------------------------------
# Regression: Gemini sometimes drops `acceptance_criteria_refs` and encodes
# AC coverage only through `@requirement:AC-x` tags, or through alternative
# key names (`requirement_ids`, `requirement_id`). Coverage detection must
# find them in every shape.

def test_generate_gherkin_covers_via_requirement_tag(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-tag1")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1", "AC-2"]),
        scenarios_in=[
            {
                "id": "TC-1",
                "title": "via @requirement tag",
                "priority": "high",
                "technique_used": "EP",
                "tags": ["@requirement:AC-1", "@technique:EP"],
                "steps": [
                    {"kind": "given", "text": "a precondition"},
                    {"kind": "then",  "text": "a result"},
                ],
            },
            {
                "id": "TC-2",
                "title": "via bare @AC tag",
                "priority": "medium",
                "technique_used": "BVA",
                "tags": ["@AC-2"],
                "steps": [
                    {"kind": "given", "text": "a boundary"},
                    {"kind": "then",  "text": "a rejection"},
                ],
            },
        ],
        feature_title="TagCoverage",
        rel_path="artefacts/features/tagcov.feature",
    ))
    assert "error" not in result, result
    assert result["coverage_summary"]["ac_covered"] == 2
    assert result["coverage_summary"]["uncovered"] == []
    text = Path(result["path_feature"]).read_text(encoding="utf-8")
    assert "@requirement:AC-1" in text
    assert "@requirement:AC-2" in text


def test_generate_gherkin_covers_via_requirement_ids_field(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-tag2")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[{
            "id": "TC-1",
            "title": "via requirement_ids",
            "priority": "high",
            "technique_used": "risk-based",
            "requirement_ids": ["AC-1"],
            "steps": [
                {"kind": "given", "text": "a"},
                {"kind": "then",  "text": "b"},
            ],
        }],
        feature_title="ReqIds",
        rel_path="artefacts/features/reqids.feature",
    ))
    assert "error" not in result
    assert result["coverage_summary"]["ac_covered"] == 1


def test_generate_gherkin_covers_via_single_requirement_id(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-tag3")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[{
            "id": "TC-1",
            "title": "via requirement_id",
            "priority": "high",
            "technique_used": "risk-based",
            "requirement_id": "AC-1",
            "steps": [
                {"kind": "given", "text": "a"},
                {"kind": "then",  "text": "b"},
            ],
        }],
        feature_title="ReqIdSingle",
        rel_path="artefacts/features/reqidsingle.feature",
    ))
    assert "error" not in result
    assert result["coverage_summary"]["ac_covered"] == 1


def test_generate_gherkin_deduplicates_ac_refs_across_fields(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    from react_core.tools.generate_gherkin import GenerateGherkinTool
    tool = GenerateGherkinTool(str(ws), org_id="org-default", thread_id="t-tag4")
    result = asyncio.run(tool.run(
        analysis=_analysis(["AC-1"]),
        scenarios_in=[{
            "id": "TC-1",
            "title": "duplicated across fields",
            "priority": "high",
            "technique_used": "risk-based",
            "acceptance_criteria_refs": ["AC-1"],
            "requirement_ids": ["AC-1"],
            "tags": ["@requirement:AC-1"],
            "steps": [{"kind": "given", "text": "a"}, {"kind": "then", "text": "b"}],
        }],
        feature_title="Dedup",
        rel_path="artefacts/features/dedup.feature",
    ))
    assert "error" not in result
    text = Path(result["path_feature"]).read_text(encoding="utf-8")
    assert text.count("@requirement:AC-1") == 1
