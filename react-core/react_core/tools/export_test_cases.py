"""export_test_cases — export a test-case suite to CSV in a format the common
test-management tools import.

Formats:
  - `generic`  — a plain, readable columnar CSV.
  - `testrail` — columns TestRail's CSV importer expects (Title, Section,
    Priority, Steps, Expected Result, References).
  - `xray`     — columns Xray's Test Case Importer expects (Test Case ID,
    Summary, Priority, Action, Data, Expected Result) — one row per step,
    which is how Xray ingests manual steps.
"""
from __future__ import annotations

import csv
import io
from typing import Any, Optional

from ..artefacts import TestSuite
from ..artefacts.writer import write_text_artefact
from .base import BaseTool

_FORMATS = {"generic", "testrail", "xray"}


class ExportTestCasesTool(BaseTool):
    name = "export_test_cases"
    description = (
        "Export a test-case suite to CSV for import into a test-management "
        "tool. `format` is 'generic' | 'testrail' | 'xray'. Pass the suite "
        "JSON (from `generate_test_cases`) as `suite`. Writes a .csv artefact "
        "and returns its path."
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
                "suite": {"type": "object", "description": "The TestSuite JSON from `generate_test_cases`."},
                "rel_path": {"type": "string", "description": "e.g. 'artefacts/exports/checkout' (.csv appended)."},
                "format": {"type": "string", "description": "'generic' | 'testrail' | 'xray'. Default 'generic'."},
            },
            "required": ["suite", "rel_path"],
        }

    async def run(
        self,
        suite: dict[str, Any],
        rel_path: str,
        format: str = "generic",
        **_: Any,
    ) -> dict[str, Any]:
        if not isinstance(suite, dict):
            return {"error": "suite must be a JSON object"}
        fmt = (format or "generic").strip().lower()
        if fmt not in _FORMATS:
            return {"error": f"unknown format '{fmt}' (expected: {', '.join(sorted(_FORMATS))})"}
        if not (rel_path or "").strip():
            return {"error": "rel_path is required"}

        parsed = TestSuite.from_dict(suite)
        if not parsed.test_cases:
            return {"error": "suite has no test cases to export"}

        content = {
            "generic": _csv_generic,
            "testrail": _csv_testrail,
            "xray": _csv_xray,
        }[fmt](parsed)

        csv_rel = (rel_path[:-4] if rel_path.lower().endswith(".csv") else rel_path) + ".csv"
        try:
            path = write_text_artefact(
                self.workspace, csv_rel, content,
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind=f"export_{fmt}",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"failed to write export: {e}"}

        return {"path_csv": str(path), "format": fmt, "test_cases": len(parsed.test_cases)}


def _steps_block(tc) -> str:
    return "\n".join(
        f"{i}. {s.action}" + (f" -> {s.expected_result}" if s.expected_result else "")
        for i, s in enumerate(tc.steps, start=1)
    )


def _expected_block(tc) -> str:
    return "\n".join(
        f"{i}. {s.expected_result}" for i, s in enumerate(tc.steps, start=1) if s.expected_result
    )


def _csv_generic(suite: TestSuite) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ID", "Title", "Priority", "Type", "Technique", "Requirements", "Preconditions", "Steps"])
    for tc in suite.test_cases:
        w.writerow([
            tc.id, tc.title, tc.priority, tc.test_type, tc.technique_used,
            "; ".join(tc.acceptance_criteria_refs), "; ".join(tc.preconditions),
            _steps_block(tc),
        ])
    return buf.getvalue()


def _csv_testrail(suite: TestSuite) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Title", "Section", "Priority", "Preconditions", "Steps", "Expected Result", "References"])
    for tc in suite.test_cases:
        w.writerow([
            tc.title, suite.title, tc.priority, "\n".join(tc.preconditions),
            _steps_block(tc), _expected_block(tc),
            ", ".join(tc.acceptance_criteria_refs),
        ])
    return buf.getvalue()


def _csv_xray(suite: TestSuite) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Test Case ID", "Summary", "Priority", "Step", "Action", "Data", "Expected Result", "References"])
    for tc in suite.test_cases:
        data = "; ".join(f"{k}={v}" for k, v in tc.test_data.items())
        refs = ", ".join(tc.acceptance_criteria_refs)
        if not tc.steps:
            w.writerow([tc.id, tc.title, tc.priority, "", "", data, "", refs])
            continue
        for i, s in enumerate(tc.steps, start=1):
            # Xray keys steps to the test by repeating the id/summary on row 1 only.
            w.writerow([
                tc.id if i == 1 else "", tc.title if i == 1 else "",
                tc.priority if i == 1 else "", i, s.action,
                data if i == 1 else "", s.expected_result, refs if i == 1 else "",
            ])
    return buf.getvalue()
