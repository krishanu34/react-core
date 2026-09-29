"""generate_test_cases — produce a structured functional / manual test-case
suite with numbered steps, enforcing the AC coverage invariant.

This is the tabular counterpart to `generate_gherkin`: where Gherkin gives
BDD scenarios, this gives classic test cases (id, title, preconditions,
numbered Step/Expected-Result rows, test data, priority, technique, AC refs)
— i.e. both "functional test cases" and "manual test steps" deliverables.

Same guarantees as `generate_gherkin`:
  - Refuses to write when any acceptance criterion has zero coverage
    (strict mode, default) and returns the uncovered AC ids.
  - Writes a JSON + Markdown pair (invariant I3). The Markdown renders each
    case as a runnable manual procedure.
"""
from __future__ import annotations

from typing import Any, Optional

from ..artefacts import Analysis, TestCase, TestSuite
from ..artefacts.writer import write_artefact
from .base import BaseTool


class GenerateTestCasesTool(BaseTool):
    name = "generate_test_cases"
    description = (
        "Produce a functional / manual test-case suite: each case has an id, "
        "title, priority, technique, preconditions, test data, numbered steps "
        "(action + expected result), and @requirement AC refs. REFUSES to "
        "write when any acceptance criterion has zero coverage (strict mode, "
        "default) and returns the uncovered AC ids so you can add cases and "
        "call again. Writes a JSON + Markdown pair; the Markdown is the "
        "human-readable manual test procedure. Use this for tabular/manual "
        "test cases; use `generate_gherkin` for BDD scenarios."
    )

    def __init__(
        self,
        workspace: str,
        *,
        org_id: str = "org-default",
        thread_id: str = "",
        project_id: Optional[str] = None,
    ):
        super().__init__(workspace)
        self._org_id = org_id
        self._thread_id = thread_id
        self._project_id = project_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "analysis": {
                    "type": "object",
                    "description": "The Analysis JSON from `analyze_requirements` (drives coverage).",
                },
                "test_cases_in": {
                    "type": "array",
                    "description": (
                        "Each: {id, title, priority?, test_type?, technique_used?, "
                        "preconditions?: [...], test_data?: {...}, "
                        "steps: [{action, expected_result}], "
                        "acceptance_criteria_refs: [...]}."
                    ),
                    "items": {"type": "object"},
                },
                "suite_title": {"type": "string"},
                "suite_description": {"type": "string"},
                "rel_path": {
                    "type": "string",
                    "description": "Where to write, e.g. 'artefacts/test_cases/checkout' (extension optional).",
                },
                "strict": {
                    "type": "boolean",
                    "description": "Refuse to write on any coverage gap. Default true.",
                },
            },
            "required": ["analysis", "test_cases_in", "suite_title", "rel_path"],
        }

    async def run(
        self,
        analysis: dict[str, Any],
        test_cases_in: list[dict[str, Any]],
        suite_title: str,
        rel_path: str,
        suite_description: Optional[str] = None,
        strict: bool = True,
        **_: Any,
    ) -> dict[str, Any]:
        if not isinstance(analysis, dict):
            return {"error": "analysis must be a JSON object"}
        if not isinstance(test_cases_in, list) or not test_cases_in:
            return {"error": "test_cases_in must be a non-empty array"}

        parsed_analysis = Analysis.from_dict(analysis)
        ac_id_set = {ac.id for ac in parsed_analysis.acceptance_criteria if ac.id}

        cases: list[TestCase] = []
        covered: set[str] = set()
        technique_counts: dict[str, int] = {}
        missing_steps: list[str] = []
        for raw in test_cases_in:
            tc = TestCase.from_dict(raw)
            cases.append(tc)
            covered.update(tc.acceptance_criteria_refs)
            technique_counts[tc.technique_used] = technique_counts.get(tc.technique_used, 0) + 1
            if not tc.steps:
                missing_steps.append(tc.id or tc.title or "(unnamed)")

        if missing_steps:
            return {
                "error": "every test case needs at least one step",
                "cases_without_steps": missing_steps,
            }

        uncovered = sorted(ac_id_set - covered) if ac_id_set else []
        coverage_summary: dict[str, Any] = {
            "ac_total": len(ac_id_set),
            "ac_covered": len(ac_id_set - set(uncovered)),
            "uncovered": uncovered,
            "test_cases": len(cases),
            "techniques_used": sorted(technique_counts.keys()),
        }

        if strict and uncovered:
            return {
                "error": "AC coverage gap",
                "uncovered": uncovered,
                "coverage_summary": coverage_summary,
            }

        suite = TestSuite(
            title=suite_title.strip(),
            description=(suite_description or "").strip() or None,
            test_cases=cases,
            coverage_summary=coverage_summary,
        )
        summary_md = _render_suite_md(suite, parsed_analysis)

        try:
            json_path, md_path = write_artefact(
                self.workspace, rel_path, suite, summary_md,
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind="test_cases",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"failed to write artefacts: {e}"}

        return {
            "path_json": str(json_path),
            "path_markdown": str(md_path),
            "coverage_summary": coverage_summary,
        }


def _render_suite_md(suite: TestSuite, analysis: Analysis) -> str:
    cs = suite.coverage_summary
    lines: list[str] = [f"# {suite.title} — Test Cases", ""]
    if suite.description:
        lines += [suite.description, ""]
    lines += [
        f"- **Test cases:** {cs.get('test_cases', 0)}",
        f"- **ACs covered:** {cs.get('ac_covered', 0)} / {cs.get('ac_total', 0)}",
        f"- **Techniques used:** {', '.join(cs.get('techniques_used') or ['—'])}",
    ]
    uncovered = cs.get("uncovered") or []
    if uncovered:
        lines.append(f"- **Uncovered ACs:** {', '.join(uncovered)}")
    lines.append("")

    for tc in suite.test_cases:
        acs = ", ".join(tc.acceptance_criteria_refs) or "—"
        lines += [
            f"## {tc.id} — {tc.title}",
            "",
            f"- **Priority:** {tc.priority}  ·  **Type:** {tc.test_type}  "
            f"·  **Technique:** {tc.technique_used}",
            f"- **Requirements:** {acs}",
        ]
        if tc.preconditions:
            lines.append("- **Preconditions:**")
            lines += [f"  - {p}" for p in tc.preconditions]
        if tc.test_data:
            data_bits = ", ".join(f"{k}={v}" for k, v in tc.test_data.items())
            lines.append(f"- **Test data:** {data_bits}")
        lines += [
            "",
            "| # | Action | Expected Result |",
            "|---|---|---|",
        ]
        for i, step in enumerate(tc.steps, start=1):
            action = step.action.replace("|", "\\|")
            expected = (step.expected_result or "—").replace("|", "\\|")
            lines.append(f"| {i} | {action} | {expected} |")
        lines.append("")

    if analysis.acceptance_criteria:
        lines += ["## Acceptance Criteria Traceability", ""]
        for ac in analysis.acceptance_criteria:
            check = "✅" if ac.id not in uncovered else "❌"
            lines.append(f"- {check} **{ac.id}** — {ac.statement}")
    return "\n".join(lines) + "\n"
