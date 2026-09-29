"""execute_tests — run a test suite and parse the outcome into a TestReport
artefact (the execution → report loop).

Runs the given command inside the workspace (reusing `run_terminal` for
streaming, secret-stripping, timeout and process-tree kill), then builds a
structured report:
  - If a JUnit XML file is produced (most runners emit it: pytest
    `--junitxml`, playwright `PLAYWRIGHT_JUNIT_OUTPUT_NAME`, jest
    `jest-junit`, etc.), it is parsed per-test — framework-agnostic.
  - Otherwise the runner's stdout summary line is parsed heuristically for
    pass/fail/skip counts.

`@requirement:AC-x` refs embedded in test names/classnames are extracted so
the report can feed the traceability matrix. Writes a JSON + Markdown pair.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any, Awaitable, Callable, Optional

from ..artefacts import TestReport, TestResult
from ..artefacts.writer import write_artefact
from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool
from .run_terminal import RunTerminalTool

_REQ_RE = re.compile(r"AC-[A-Za-z0-9._-]+")

# Common runner summary lines, e.g. "5 passed, 2 failed, 1 skipped".
_COUNT_RE = {
    "passed": re.compile(r"(\d+)\s+passed", re.I),
    "failed": re.compile(r"(\d+)\s+failed", re.I),
    "skipped": re.compile(r"(\d+)\s+skipped", re.I),
    "errors": re.compile(r"(\d+)\s+error", re.I),
}


class ExecuteTestsTool(BaseTool):
    name = "execute_tests"
    SUPPORTS_STREAMING = True
    description = (
        "Run a test/automation suite and parse the result into a TestReport "
        "artefact (JSON + Markdown). Streams live output. Prefer emitting "
        "JUnit XML from the runner (e.g. `pytest --junitxml=report.xml`) and "
        "passing `junit_xml_path` — that gives per-test results and pulls "
        "@requirement:AC-x refs out of test names for traceability. Without "
        "it, only summary counts are parsed from stdout. This is the "
        "execution half of the QA loop; call it after `generate_automation`."
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
                "command": {"type": "string", "description": "The command that runs the suite."},
                "junit_xml_path": {
                    "type": "string",
                    "description": "Workspace-relative path to the JUnit XML the run produces (optional but recommended).",
                },
                "framework": {"type": "string", "description": "Framework label for the report, e.g. 'pytest'."},
                "rel_path": {
                    "type": "string",
                    "description": "Where to write the report, e.g. 'artefacts/reports/run-1' (extension optional).",
                },
                "timeout": {"type": "integer", "description": "Seconds for the run (default 300)."},
            },
            "required": ["command", "rel_path"],
        }

    async def run(
        self,
        command: str,
        rel_path: str,
        junit_xml_path: Optional[str] = None,
        framework: str = "",
        timeout: Optional[int] = None,
        on_event: Callable[[str, dict], Awaitable[None] | None] | None = None,
        **_: Any,
    ) -> dict[str, Any]:
        command = (command or "").strip()
        if not command:
            return {"error": "command is required"}
        if not (rel_path or "").strip():
            return {"error": "rel_path is required"}

        runner = RunTerminalTool(self.workspace)
        run_result = await runner.run(
            command=command,
            timeout=int(timeout or 300),
            on_event=on_event,
        )
        # A gated (destructive) or runtime-missing command never executed.
        if run_result.get("status") == "permission_required":
            return run_result
        if "exit_code" not in run_result:
            return {"error": "command did not execute", "detail": run_result}

        exit_code = int(run_result.get("exit_code") or 0)
        stdout = str(run_result.get("stdout") or "")
        stderr = str(run_result.get("stderr") or "")

        report = self._parse(command, framework, exit_code, stdout, stderr, junit_xml_path)

        try:
            json_path, md_path = write_artefact(
                self.workspace, rel_path, report, _render_md(report),
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind="test_report",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"failed to write report: {e}"}

        return {
            "path_json": str(json_path),
            "path_markdown": str(md_path),
            "exit_code": exit_code,
            "total": report.total,
            "passed": report.passed,
            "failed": report.failed,
            "skipped": report.skipped,
            "errors": report.errors,
            "summary": report.summary,
        }

    def _parse(
        self, command: str, framework: str, exit_code: int,
        stdout: str, stderr: str, junit_xml_path: Optional[str],
    ) -> TestReport:
        results: list[TestResult] = []
        parsed_from_xml = False
        if junit_xml_path:
            results, parsed_from_xml = self._parse_junit(junit_xml_path)

        if parsed_from_xml:
            passed = sum(1 for r in results if r.status == "passed")
            failed = sum(1 for r in results if r.status == "failed")
            skipped = sum(1 for r in results if r.status == "skipped")
            errors = sum(1 for r in results if r.status == "error")
            total = len(results)
        else:
            passed, failed, skipped, errors = _counts_from_text(stdout + "\n" + stderr)
            total = passed + failed + skipped + errors

        status_word = "passed" if exit_code == 0 and failed == 0 and errors == 0 else "failed"
        summary = (
            f"{status_word}: {passed} passed, {failed} failed, "
            f"{skipped} skipped, {errors} errors (exit {exit_code})"
        )
        return TestReport(
            command=command,
            framework=framework or _guess_framework(command),
            exit_code=exit_code,
            total=total, passed=passed, failed=failed,
            skipped=skipped, errors=errors,
            duration=sum(r.duration for r in results),
            results=results,
            summary=summary,
        )

    def _parse_junit(self, rel: str) -> tuple[list[TestResult], bool]:
        try:
            target = resolve_in_root(self.workspace, rel)
        except PathEscape:
            return [], False
        if not target.is_file():
            return [], False
        try:
            root = ET.parse(str(target)).getroot()
        except (ET.ParseError, OSError):
            return [], False

        results: list[TestResult] = []
        for case in root.iter("testcase"):
            name = case.get("name") or ""
            classname = case.get("classname") or ""
            try:
                duration = float(case.get("time") or 0.0)
            except ValueError:
                duration = 0.0
            status = "passed"
            message = ""
            failure = case.find("failure")
            error = case.find("error")
            skipped = case.find("skipped")
            if failure is not None:
                status, message = "failed", (failure.get("message") or (failure.text or "")).strip()
            elif error is not None:
                status, message = "error", (error.get("message") or (error.text or "")).strip()
            elif skipped is not None:
                status, message = "skipped", (skipped.get("message") or "").strip()
            refs = sorted(set(_REQ_RE.findall(f"{classname} {name}")))
            results.append(TestResult(
                name=name, status=status, classname=classname,
                duration=duration, message=message[:500], requirement_refs=refs,
            ))
        return results, True


def _counts_from_text(text: str) -> tuple[int, int, int, int]:
    def _first(pat: re.Pattern[str]) -> int:
        m = pat.search(text)
        return int(m.group(1)) if m else 0
    return (
        _first(_COUNT_RE["passed"]),
        _first(_COUNT_RE["failed"]),
        _first(_COUNT_RE["skipped"]),
        _first(_COUNT_RE["errors"]),
    )


def _guess_framework(command: str) -> str:
    low = command.lower()
    for needle, label in (
        ("pytest", "pytest"), ("playwright", "playwright"), ("cypress", "cypress"),
        ("jest", "jest"), ("vitest", "vitest"), ("mvn", "junit"), ("gradle", "junit"),
        ("go test", "go"), ("dotnet test", "dotnet"),
    ):
        if needle in low:
            return label
    return ""


def _render_md(report: TestReport) -> str:
    lines = [
        f"# Test Report — {report.framework or 'run'}",
        "",
        f"`{report.command}`",
        "",
        f"- **Result:** {report.summary}",
        f"- **Total:** {report.total}  ·  ✅ {report.passed}  ·  ❌ {report.failed}  "
        f"·  ⏭ {report.skipped}  ·  ⚠️ {report.errors}",
        f"- **Duration:** {report.duration:.2f}s  ·  **Exit code:** {report.exit_code}",
        "",
    ]
    if report.results:
        lines += ["| Test | Status | Requirements | Message |", "|---|---|---|---|"]
        icon = {"passed": "✅", "failed": "❌", "skipped": "⏭", "error": "⚠️"}
        for r in report.results:
            name = (f"{r.classname}::{r.name}" if r.classname else r.name).replace("|", "\\|")
            reqs = ", ".join(r.requirement_refs) or "—"
            msg = (r.message or "").replace("|", "\\|").replace("\n", " ")[:120] or "—"
            lines.append(f"| {name} | {icon.get(r.status, r.status)} {r.status} | {reqs} | {msg} |")
        lines.append("")
    return "\n".join(lines) + "\n"
