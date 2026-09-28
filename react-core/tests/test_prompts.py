"""Prompt-content tests (deliverable #1).

Positive: the agentic contract is described.
Negative: no phase / DAG language survives (guardrail from spec §14).
"""
from __future__ import annotations


def _render(monkeypatch, profile: str = "qa", strict: bool = False) -> str:
    from react_core.agent.prompts import render_system_prompt
    monkeypatch.setenv("PROMPT_PROFILE", profile)
    if strict:
        monkeypatch.setenv("PROMPT_STRICT_CHECKPOINTS", "1")
    else:
        monkeypatch.delenv("PROMPT_STRICT_CHECKPOINTS", raising=False)
    return render_system_prompt(
        workspace="/ws", tools_text="- fake_tool()", today="2026-09-17", platform="Test",
    )


def test_qa_prompt_names_all_deliverable_tools(monkeypatch):
    text = _render(monkeypatch, profile="qa")
    assert "analyze_requirements" in text
    assert "generate_gherkin" in text
    assert "write_artefact" in text
    assert "request_approval" in text
    assert "ask_user" in text


def test_qa_prompt_states_five_invariants(monkeypatch):
    text = _render(monkeypatch, profile="qa")
    # Look for the invariant labels — I1..I5.
    for tag in ("I1", "I2", "I3", "I4", "I5"):
        assert tag in text, f"invariant {tag} missing"


def test_qa_prompt_lists_the_five_goals(monkeypatch):
    text = _render(monkeypatch, profile="qa")
    for phrase in (
        "Faithful to source",
        "Traceable coverage",
        "Formal-technique diversity",
        "Right-sized effort",
        "Reviewer confidence",
    ):
        assert phrase in text, f"goal missing: {phrase}"


def test_qa_prompt_mentions_optional_model_artefacts(monkeypatch):
    text = _render(monkeypatch, profile="qa")
    assert "state_model.json" in text
    assert "cause_effect_model.json" in text
    assert "data_model.json" in text


def test_qa_prompt_has_no_phase_or_step_language(monkeypatch):
    """Guardrail from spec §14: DAG-thinking must NOT sneak back in.

    We check case-insensitively for the exact forbidden phrases.
    """
    text = _render(monkeypatch, profile="qa").lower()
    for banned in (
        " phase ",
        "phase 1",
        "phase 2",
        "step 1",
        "step 2",
        "workflow contract",
        "you must first",
    ):
        assert banned not in text, f"banned phrase leaked back into prompt: {banned!r}"


def test_qa_prompt_says_invariants_are_unordered(monkeypatch):
    """The contract must state that invariants can be satisfied in any order."""
    text = _render(monkeypatch, profile="qa")
    assert "UNORDERED" in text or "any sequence" in text


def test_strict_hint_appears_when_enabled(monkeypatch):
    off = _render(monkeypatch, profile="qa", strict=False)
    on = _render(monkeypatch, profile="qa", strict=True)
    assert "PROMPT_STRICT_CHECKPOINTS" not in off
    assert "PROMPT_STRICT_CHECKPOINTS" in on


def test_coding_profile_still_available_and_short(monkeypatch):
    text = _render(monkeypatch, profile="coding")
    # coding profile is untouched by the QA changes.
    assert "autonomous coding agent" in text
