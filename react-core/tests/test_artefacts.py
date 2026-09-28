"""Schemas + writer tests (deliverable #3)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from react_core.artefacts import (
    AcceptanceCriterion,
    Analysis,
    GherkinFeature,
    GherkinScenario,
    GherkinStep,
    derive_gaps_significant,
    write_artefact,
)
from react_core.artefacts.writer import (
    ArtefactWriteError,
    write_text_artefact,
)


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


# ---- schemas round-trip ---------------------------------------------------

def test_analysis_round_trip():
    original = Analysis(
        source_type="mixed",
        summary_one_paragraph="A brief.",
        acceptance_criteria=[
            AcceptanceCriterion(id="AC-1", statement="X happens.", testable=True, source_ref="brief"),
        ],
        ambiguities=[{"text": "unclear cloud", "impact": "high"}],
        missing_NFRs=["latency"],
        state_hints=["invoice"],
        gaps_significant=True,
    )
    payload = original.to_dict()
    restored = Analysis.from_dict(payload)
    assert restored.acceptance_criteria[0].id == "AC-1"
    assert restored.missing_NFRs == ["latency"]
    assert restored.gaps_significant is True


def test_gherkin_feature_round_trip():
    feature = GherkinFeature(
        feature="Checkout",
        scenarios=[
            GherkinScenario(
                id="TC-1",
                name="Happy path",
                tags=["@priority:critical", "@technique:risk-based", "@requirement:AC-1"],
                steps=[
                    GherkinStep(kind="given", text="the cart has one item"),
                    GherkinStep(kind="when", text="the user checks out"),
                    GherkinStep(kind="then", text="the order is created"),
                ],
                acceptance_criteria_refs=["AC-1"],
            ),
        ],
        coverage_summary={"ac_total": 1, "ac_covered": 1, "uncovered": [], "scenarios": 1, "techniques_used": ["risk-based"]},
    )
    restored = GherkinFeature.from_dict(feature.to_dict())
    assert restored.feature == "Checkout"
    assert restored.scenarios[0].steps[0].text == "the cart has one item"
    assert restored.coverage_summary["ac_covered"] == 1


# ---- derive_gaps_significant ---------------------------------------------

def test_derive_gaps_true_when_no_acs():
    assert derive_gaps_significant({"acceptance_criteria": [], "missing_NFRs": [], "ambiguities": []}) is True


def test_derive_gaps_true_when_missing_nfrs():
    assert derive_gaps_significant({
        "acceptance_criteria": [{"id": "AC-1"}],
        "missing_NFRs": ["latency"], "ambiguities": [],
    }) is True


def test_derive_gaps_true_when_high_impact_ambiguity():
    assert derive_gaps_significant({
        "acceptance_criteria": [{"id": "AC-1"}],
        "missing_NFRs": [],
        "ambiguities": [{"text": "which cloud", "impact": "high"}],
    }) is True


def test_derive_gaps_false_when_clean():
    assert derive_gaps_significant({
        "acceptance_criteria": [{"id": "AC-1", "statement": "x"}],
        "missing_NFRs": [],
        "ambiguities": [{"text": "minor", "impact": "low"}],
    }) is False


# ---- writer ---------------------------------------------------------------

def test_write_artefact_produces_json_and_md(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    analysis = Analysis(
        source_type="user_story",
        summary_one_paragraph="Small feature.",
        acceptance_criteria=[AcceptanceCriterion(id="AC-1", statement="x", testable=True)],
    )
    json_path, md_path = write_artefact(
        workspace=ws, rel_path="artefacts/analysis",
        data=analysis, markdown="# Analysis\n\nSmall feature.",
        org_id="org-default", thread_id="t-1", kind="analysis",
    )
    assert json_path.is_file() and md_path.is_file()
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["acceptance_criteria"][0]["id"] == "AC-1"
    assert md_path.read_text(encoding="utf-8").startswith("# Analysis")


def test_write_artefact_accepts_dict_or_dataclass(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    write_artefact(
        workspace=ws, rel_path="artefacts/plain",
        data={"a": 1}, markdown="# ok",
        org_id="org-default", thread_id="t-1", kind="analysis",
    )
    write_artefact(
        workspace=ws, rel_path="artefacts/plainlist",
        data=[1, 2, 3], markdown="# ok",
        org_id="org-default", thread_id="t-1", kind="analysis",
    )


def test_write_artefact_normalises_trailing_extensions(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    json_path, md_path = write_artefact(
        workspace=ws, rel_path="artefacts/analysis.json",
        data={"a": 1}, markdown="# ok",
        org_id="org-default", thread_id="t-1", kind="analysis",
    )
    # Should NOT end in `.json.json` / `.json.md`.
    assert json_path.name == "analysis.json"
    assert md_path.name == "analysis.md"


def test_write_artefact_rejects_path_escape(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    with pytest.raises(ArtefactWriteError):
        write_artefact(
            workspace=ws, rel_path="../escape",
            data={"a": 1}, markdown="# ok",
            org_id="org-default", thread_id="t-1", kind="analysis",
        )


def test_write_artefact_records_in_app_db(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    write_artefact(
        workspace=ws, rel_path="artefacts/analysis",
        data={"a": 1}, markdown="# ok",
        org_id="org-default", thread_id="t-1", kind="analysis",
    )
    from react_core.app_db import get_app_db
    rows = get_app_db().list_artefacts("t-1")
    kinds = sorted(r.kind for r in rows)
    assert kinds == ["analysis", "analysis_md"]


def test_write_text_artefact_single_file(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ws = tmp_path / "workspace"
    ws.mkdir()
    p = write_text_artefact(
        workspace=ws, rel_path="artefacts/features/x.feature",
        text="Feature: X\n",
        org_id="org-default", thread_id="t-2", kind="gherkin_feature",
    )
    assert p.read_text() == "Feature: X\n"
    from react_core.app_db import get_app_db
    rows = get_app_db().list_artefacts("t-2")
    assert len(rows) == 1 and rows[0].kind == "gherkin_feature"
