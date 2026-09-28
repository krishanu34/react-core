"""Validators for user-editable artefact files.

Applied when the web IDE PUTs a file back to disk. The rules:

- Any `.md` file — accept as-is.
- Any `.feature` file — must have exactly one `Feature:` line, ≥1 `Scenario`
  (or `Scenario Outline`), and every step must open with `Given/When/Then/
  And/But/*`. Comments (`#…`) and blank lines are tolerated. This is a
  lightweight Gherkin syntax check — no full grammar — enough to catch
  hand-editing mistakes.
- Any `.json` file — must parse. When the path lives under `features/…`,
  it must also round-trip through `GherkinFeature.from_dict` (rejects
  wrong shape). When the filename is `analysis.json`, same thing but
  through `Analysis.from_dict`.

The result of validation is a list of `ValidationIssue` objects. An
empty list means the file is safe to write.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .schemas import Analysis, GherkinFeature


@dataclass(slots=True, frozen=True)
class ValidationIssue:
    line: int | None
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {"line": self.line, "message": self.message}


_GHERKIN_STEP_KEYWORDS = ("given", "when", "then", "and", "but", "*")


def validate(rel_path: str, content: str) -> list[ValidationIssue]:
    """Dispatch by extension. Empty list = OK."""
    lower = rel_path.lower()
    if lower.endswith(".md"):
        return []
    if lower.endswith(".feature"):
        return validate_gherkin(content)
    if lower.endswith(".json"):
        issues = validate_json(content)
        if issues:
            return issues
        return validate_gherkin_or_analysis_shape(rel_path, content)
    # Unknown extension: allow but note.
    return []


def validate_json(content: str) -> list[ValidationIssue]:
    try:
        json.loads(content)
        return []
    except json.JSONDecodeError as e:
        return [ValidationIssue(line=e.lineno, message=f"JSON parse error: {e.msg}")]


def validate_gherkin_or_analysis_shape(rel_path: str, content: str) -> list[ValidationIssue]:
    """After JSON parses, check schema shape based on where the file lives."""
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return []  # already reported by validate_json
    if not isinstance(data, dict):
        return [ValidationIssue(line=None, message="Top-level JSON must be an object.")]

    parts = rel_path.replace("\\", "/").lower().split("/")
    name = parts[-1] if parts else ""

    if "features" in parts:
        return _validate_gherkin_json_shape(data)
    if name == "analysis.json":
        return _validate_analysis_shape(data)
    # No known schema for this path — allow.
    return []


def _validate_gherkin_json_shape(data: dict) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if not isinstance(data.get("feature"), str) or not data["feature"].strip():
        issues.append(ValidationIssue(line=None, message="`feature` (string) is required."))
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list):
        issues.append(ValidationIssue(line=None, message="`scenarios` must be an array."))
        return issues
    if len(scenarios) == 0:
        issues.append(ValidationIssue(line=None, message="At least one scenario is required."))
    for i, sc in enumerate(scenarios):
        if not isinstance(sc, dict):
            issues.append(ValidationIssue(line=None, message=f"scenarios[{i}] must be an object."))
            continue
        if not isinstance(sc.get("name"), str) or not sc["name"].strip():
            issues.append(ValidationIssue(line=None, message=f"scenarios[{i}].name is required."))
        steps = sc.get("steps")
        if not isinstance(steps, list) or not steps:
            issues.append(ValidationIssue(
                line=None,
                message=f"scenarios[{i}].steps must be a non-empty array.",
            ))
        else:
            for j, step in enumerate(steps):
                if not isinstance(step, dict):
                    issues.append(ValidationIssue(
                        line=None,
                        message=f"scenarios[{i}].steps[{j}] must be a {{kind, text}} object.",
                    ))
                    continue
                kind = str(step.get("kind") or "").lower()
                if kind not in _GHERKIN_STEP_KEYWORDS:
                    issues.append(ValidationIssue(
                        line=None,
                        message=(
                            f"scenarios[{i}].steps[{j}].kind must be one of "
                            f"given/when/then/and/but (was: {step.get('kind')!r})."
                        ),
                    ))
                if not str(step.get("text") or "").strip():
                    issues.append(ValidationIssue(
                        line=None,
                        message=f"scenarios[{i}].steps[{j}].text is required.",
                    ))
    if issues:
        return issues
    # Final round-trip through the dataclass — catches structural mistakes
    # the field-level checks above missed.
    try:
        GherkinFeature.from_dict(data)
    except Exception as e:  # noqa: BLE001
        issues.append(ValidationIssue(line=None, message=f"Schema mismatch: {e}"))
    return issues


def _validate_analysis_shape(data: dict) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if not isinstance(data.get("acceptance_criteria"), list):
        issues.append(ValidationIssue(line=None, message="`acceptance_criteria` must be an array."))
    if not isinstance(data.get("summary_one_paragraph"), str):
        issues.append(ValidationIssue(line=None, message="`summary_one_paragraph` (string) is required."))
    if issues:
        return issues
    try:
        Analysis.from_dict(data)
    except Exception as e:  # noqa: BLE001
        issues.append(ValidationIssue(line=None, message=f"Schema mismatch: {e}"))
    return issues


def validate_gherkin(content: str) -> list[ValidationIssue]:
    """Lightweight Gherkin syntax check."""
    issues: list[ValidationIssue] = []
    lines = content.splitlines()

    feature_seen = 0
    scenario_seen = 0
    inside_scenario = False
    inside_examples = False

    def _leading(line: str) -> str:
        return line.lstrip()

    for lineno, raw in enumerate(lines, start=1):
        stripped = _leading(raw).rstrip()
        if not stripped or stripped.startswith("#"):
            continue
        # tags (`@requirement:AC-1`) at any indentation
        if stripped.startswith("@"):
            continue
        # table rows inside an Examples block
        if inside_examples and stripped.startswith("|"):
            continue

        low = stripped.lower()

        if low.startswith("feature:"):
            feature_seen += 1
            inside_scenario = False
            inside_examples = False
            continue
        if low.startswith("background:"):
            inside_scenario = True
            inside_examples = False
            continue
        if low.startswith("scenario outline:") or low.startswith("scenario:"):
            scenario_seen += 1
            inside_scenario = True
            inside_examples = False
            continue
        if low.startswith("examples:"):
            if not inside_scenario:
                issues.append(ValidationIssue(
                    line=lineno,
                    message="`Examples:` block appears outside a scenario.",
                ))
            inside_examples = True
            continue

        # A step? First word must be a Gherkin keyword.
        first_word = stripped.split(None, 1)[0].lower().rstrip(":")
        if first_word in _GHERKIN_STEP_KEYWORDS:
            if not inside_scenario:
                issues.append(ValidationIssue(
                    line=lineno,
                    message=f"`{first_word.capitalize()}` step outside a Scenario.",
                ))
            inside_examples = False
            continue

        # Description text on the Feature line's own block is fine — but only
        # BEFORE a scenario has been declared.
        if feature_seen and not scenario_seen:
            continue

        issues.append(ValidationIssue(
            line=lineno,
            message=f"Unrecognised line — expected a Gherkin keyword: {stripped[:80]!r}",
        ))

    if feature_seen == 0:
        issues.append(ValidationIssue(line=None, message="Missing `Feature:` line."))
    if feature_seen > 1:
        issues.append(ValidationIssue(line=None, message="Only one `Feature:` line is allowed."))
    if scenario_seen == 0:
        issues.append(ValidationIssue(line=None, message="At least one `Scenario:` (or `Scenario Outline:`) is required."))
    return issues
