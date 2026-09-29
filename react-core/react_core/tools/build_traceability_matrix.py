"""build_traceability_matrix — the consolidated requirement → test → result
matrix (RTM) QA teams live on.

Cross-references, per acceptance criterion:
  - which Gherkin scenarios validate it (`@requirement` refs),
  - which functional/manual test cases validate it,
  - the latest execution outcome (from a TestReport, matched on the AC refs
    the runner emitted in test names).

Writes three artefacts: JSON (logical), Markdown (review), and CSV (importable
into TestRail / Xray / Zephyr / Excel).
"""
from __future__ import annotations

import csv
import io
from typing import Any, Optional

from ..artefacts import Analysis
from ..artefacts.writer import write_artefact, write_text_artefact
from .base import BaseTool


def _refs(item: Any) -> list[str]:
    if not isinstance(item, dict):
        return []
    out = list(item.get("acceptance_criteria_refs") or item.get("requirement_refs") or [])
    return [str(x) for x in out]


class BuildTraceabilityMatrixTool(BaseTool):
    name = "build_traceability_matrix"
    description = (
        "Build the requirement→test→result traceability matrix (RTM) from the "
        "analysis plus any scenarios, test cases, and an execution report you "
        "have. For each acceptance criterion it lists the scenarios and test "
        "cases that cover it and the latest pass/fail result. Writes JSON + "
        "Markdown + CSV (the CSV imports into TestRail / Xray / Zephyr / "
        "Excel). Call this to prove coverage and surface gaps."
    )

    def __init__(self, workspace: str, *, org_id: str = "org-default",
                 thread_id: str = "", project_id: Optional[str] = None):
        super().__init__(workspace)
        self._org_id = org_id
        self._thread_id = thread_id
        self._project_id = project_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "analysis": {"type": "object", "description": "Analysis JSON (source of acceptance criteria)."},
                "scenarios": {
                    "type": "array",
                    "description": "Gherkin scenarios: [{id, acceptance_criteria_refs}].",
                    "items": {"type": "object"},
                },
                "test_cases": {
                    "type": "array",
                    "description": "Test cases: [{id, acceptance_criteria_refs}].",
                    "items": {"type": "object"},
                },
                "report": {
                    "type": "object",
                    "description": "Optional TestReport JSON from `execute_tests` (adds the result column).",
                },
                "rel_path": {"type": "string", "description": "e.g. 'artefacts/traceability/rtm'."},
                "title": {"type": "string"},
            },
            "required": ["analysis", "rel_path"],
        }

    async def run(
        self,
        analysis: dict[str, Any],
        rel_path: str,
        scenarios: Optional[list[dict]] = None,
        test_cases: Optional[list[dict]] = None,
        report: Optional[dict] = None,
        title: str = "Traceability Matrix",
        **_: Any,
    ) -> dict[str, Any]:
        if not isinstance(analysis, dict):
            return {"error": "analysis must be a JSON object"}
        if not (rel_path or "").strip():
            return {"error": "rel_path is required"}

        parsed = Analysis.from_dict(analysis)
        acs = parsed.acceptance_criteria
        if not acs:
            return {"error": "analysis has no acceptance criteria — nothing to trace"}

        # AC id -> latest result across matching executed tests.
        results = (report or {}).get("results") or []
        result_by_ac: dict[str, str] = {}
        for r in results:
            status = str(r.get("status") or "").lower()
            for ac in (r.get("requirement_refs") or []):
                prev = result_by_ac.get(ac)
                # failing dominates; then error; then passed; then skipped.
                rank = {"failed": 3, "error": 2, "passed": 1, "skipped": 0}
                if prev is None or rank.get(status, 0) > rank.get(prev, 0):
                    result_by_ac[ac] = status

        rows: list[dict[str, Any]] = []
        covered = failing = 0
        for ac in acs:
            sc_ids = [str(s.get("id") or "") for s in (scenarios or []) if ac.id in _refs(s)]
            tc_ids = [str(t.get("id") or "") for t in (test_cases or []) if ac.id in _refs(t)]
            has_cov = bool(sc_ids or tc_ids)
            result = result_by_ac.get(ac.id, "not run" if not report else "not run")
            if has_cov:
                covered += 1
            if result in ("failed", "error"):
                failing += 1
            status = "uncovered" if not has_cov else ("failing" if result in ("failed", "error") else "covered")
            rows.append({
                "requirement_id": ac.id,
                "statement": ac.statement,
                "scenarios": sc_ids,
                "test_cases": tc_ids,
                "result": result,
                "status": status,
            })

        summary = {
            "ac_total": len(acs),
            "ac_covered": covered,
            "ac_uncovered": len(acs) - covered,
            "ac_failing": failing,
        }
        matrix = {"title": title, "rows": rows, "coverage_summary": summary}

        try:
            json_path, md_path = write_artefact(
                self.workspace, rel_path, matrix, _render_md(title, rows, summary),
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind="traceability_matrix",
            )
            csv_rel = (rel_path[:-5] if rel_path.endswith(".json") else rel_path) + ".csv"
            csv_path = write_text_artefact(
                self.workspace, csv_rel, _render_csv(rows),
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind="traceability_matrix_csv",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"failed to write matrix: {e}"}

        return {
            "path_json": str(json_path),
            "path_markdown": str(md_path),
            "path_csv": str(csv_path),
            "coverage_summary": summary,
        }


def _render_md(title: str, rows: list[dict], summary: dict) -> str:
    lines = [
        f"# {title}",
        "",
        f"- **ACs:** {summary['ac_total']}  ·  Covered: {summary['ac_covered']}  "
        f"·  Uncovered: {summary['ac_uncovered']}  ·  Failing: {summary['ac_failing']}",
        "",
        "| Requirement | Statement | Scenarios | Test Cases | Result | Status |",
        "|---|---|---|---|---|---|",
    ]
    icon = {"covered": "✅", "uncovered": "❌", "failing": "🔴"}
    for r in rows:
        stmt = str(r["statement"]).replace("|", "\\|")[:80]
        scn = ", ".join(r["scenarios"]) or "—"
        tcs = ", ".join(r["test_cases"]) or "—"
        lines.append(
            f"| {r['requirement_id']} | {stmt} | {scn} | {tcs} | {r['result']} "
            f"| {icon.get(r['status'], '')} {r['status']} |"
        )
    return "\n".join(lines) + "\n"


def _render_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Requirement", "Statement", "Scenarios", "Test Cases", "Result", "Status"])
    for r in rows:
        w.writerow([
            r["requirement_id"], r["statement"],
            "; ".join(r["scenarios"]), "; ".join(r["test_cases"]),
            r["result"], r["status"],
        ])
    return buf.getvalue()
