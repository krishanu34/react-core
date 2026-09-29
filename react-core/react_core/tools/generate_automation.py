"""generate_automation — scaffold a runnable automation bundle for a chosen
framework from design artefacts (Gherkin scenarios / test cases).

The workspace filesystem tools can already write arbitrary code, but this
tool gives the automation deliverable structure the raw tools don't:
  - framework-aware prompting (Playwright, Selenium, Cypress, pytest, …),
  - it can read the thread's `.feature` files and map scenarios to step
    definitions, preserving `@requirement` traceability as annotations,
  - it emits a multi-file bundle plus a run command, all recorded in the
    artefact store under `kind="automation"`.

LLM-backed (like `analyze_requirements`): the model returns a strict JSON
manifest of files; this tool writes each one, path-guarded to the workspace.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from ..artefacts.writer import ArtefactWriteError, write_text_artefact
from ..llm.base import LLMError
from ..llm.factory import create_llm
from ..llm.structured_output import extract_json
from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool

log = logging.getLogger(__name__)


def _as_text(value: Any) -> str:
    """Coerce an LLM-supplied argument to text — models sometimes pass a
    dict/list where a string is expected."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)

_MAX_FILES = 40
_MAX_FILE_BYTES = 200_000
_MAX_CONTEXT_CHARS = 20_000

_PROMPT = """You are a senior test-automation engineer. Generate a COMPLETE, \
runnable automation bundle for the framework below, derived ONLY from the \
provided scenarios / test cases. Fabricate no requirements.

## FRAMEWORK
{framework}

## LANGUAGE / NOTES
{notes}

## SOURCE SCENARIOS / TEST CASES
{context}

## OUTPUT — STRICT JSON, no prose, no markdown fences
{{
  "files": [
    {{"path": "relative/path/from/target_dir.ext", "content": "full file contents"}}
  ],
  "run_command": "the shell command to execute the suite",
  "setup_command": "the shell command to install deps (or empty string)",
  "notes": "short notes for the human (assumptions, TODOs)"
}}

## RULES
- Produce real, runnable code — config, test/spec files, and (for BDD \
frameworks) step definitions that map to the scenarios.
- Preserve traceability: annotate each test with the acceptance-criterion id \
it validates (e.g. a comment `# @requirement:AC-1` or a tag/annotation the \
framework supports).
- Use `path` values RELATIVE to the target directory. No absolute paths, no \
`..` segments.
- Keep it self-contained and minimal but complete enough to run after the \
setup command.
Return ONLY the JSON object.
"""


class GenerateAutomationTool(BaseTool):
    name = "generate_automation"
    description = (
        "Scaffold a runnable automation bundle for a framework (e.g. "
        "'playwright-pytest', 'selenium-pytest', 'cypress', 'playwright-ts') "
        "from Gherkin scenarios and/or test cases. Reads `.feature` files by "
        "path when given, maps scenarios to step definitions with "
        "@requirement traceability, writes a multi-file bundle under "
        "`target_dir` (default 'automation/'), and returns the file list plus "
        "the run command. Call `request_approval` before this — automation is "
        "an expensive commitment."
    )

    def __init__(self, workspace: str, *, org_id: str = "org-default",
                 thread_id: str = "", project_id: Optional[str] = None,
                 llm_factory=create_llm):
        super().__init__(workspace)
        self._org_id = org_id
        self._thread_id = thread_id
        self._project_id = project_id
        self._llm_factory = llm_factory

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "framework": {
                    "type": "string",
                    "description": "Target framework, e.g. 'playwright-pytest', 'cypress', 'selenium-pytest'.",
                },
                "scenarios": {
                    "type": "array",
                    "description": "Optional inline scenarios / test cases (objects or strings) to automate.",
                    "items": {"type": "object"},
                },
                "feature_paths": {
                    "type": "array",
                    "description": "Optional workspace-relative paths to `.feature` files to read and automate.",
                    "items": {"type": "string"},
                },
                "target_dir": {
                    "type": "string",
                    "description": "Directory to write the bundle into. Default 'automation'.",
                },
                "notes": {
                    "type": "string",
                    "description": "Optional language/tooling constraints (e.g. 'TypeScript, page-object model').",
                },
            },
            "required": ["framework"],
        }

    async def run(
        self,
        framework: Any = "",
        scenarios: Optional[list[Any]] = None,
        feature_paths: Optional[list[str]] = None,
        target_dir: str = "automation",
        notes: Any = None,
        **_: Any,
    ) -> dict[str, Any]:
        framework = _as_text(framework).strip()
        if not framework:
            return {"error": "framework is required"}

        context = self._build_context(scenarios, feature_paths)
        if not context.strip():
            return {"error": "no source scenarios or feature files provided — nothing to automate"}

        try:
            llm = self._llm_factory()
        except Exception as e:  # noqa: BLE001
            return {"error": f"LLM not configured: {e}"}

        prompt = _PROMPT.format(
            framework=framework,
            notes=_as_text(notes).strip() or "(none)",
            context=context[:_MAX_CONTEXT_CHARS],
        )

        try:
            response = await llm.complete(
                [{"role": "user", "content": prompt}],
                temperature=0.1,
                response_format={"type": "json_object"},
            )
        except (LLMError, TypeError):
            try:
                llm = self._llm_factory()
                response = await llm.complete([{"role": "user", "content": prompt}], temperature=0.1)
            except Exception as e:  # noqa: BLE001
                return {"error": f"automation generation failed: {e}"}
        except Exception as e:  # noqa: BLE001
            return {"error": f"automation generation failed: {e}"}

        try:
            manifest = extract_json(response)
        except Exception as e:  # noqa: BLE001
            return {"error": f"automation manifest was unparseable JSON: {e}", "raw": response[:800]}
        if not isinstance(manifest, dict):
            return {"error": "automation manifest was not a JSON object"}

        files = manifest.get("files")
        if not isinstance(files, list) or not files:
            return {"error": "automation manifest contained no files"}

        base = (target_dir or "automation").strip().strip("/") or "automation"
        written: list[str] = []
        skipped: list[dict[str, str]] = []
        for entry in files[:_MAX_FILES]:
            if not isinstance(entry, dict):
                continue
            rel = str(entry.get("path") or "").strip().replace("\\", "/").lstrip("/")
            content = entry.get("content")
            if not rel or not isinstance(content, str):
                skipped.append({"path": rel or "(missing)", "reason": "missing path or content"})
                continue
            # Keep every file under target_dir — reject climbing/absolute paths.
            if ".." in rel.split("/") or rel.startswith("/"):
                skipped.append({"path": rel, "reason": "path must stay under target_dir (no '..' or absolute paths)"})
                continue
            if len(content.encode("utf-8")) > _MAX_FILE_BYTES:
                skipped.append({"path": rel, "reason": "file exceeds size cap"})
                continue
            full_rel = f"{base}/{rel}"
            try:
                resolve_in_root(self.workspace, full_rel)  # path-escape guard
                write_text_artefact(
                    self.workspace, full_rel, content,
                    org_id=self._org_id, thread_id=self._thread_id,
                    project_id=self._project_id, kind="automation",
                )
                written.append(full_rel)
            except (PathEscape, ArtefactWriteError) as e:
                skipped.append({"path": rel, "reason": str(e)})
            except Exception as e:  # noqa: BLE001
                skipped.append({"path": rel, "reason": f"{type(e).__name__}: {e}"})

        if not written:
            return {"error": "no automation files could be written", "skipped": skipped}

        return {
            "framework": framework,
            "target_dir": base,
            "files_written": written,
            "skipped": skipped,
            "run_command": str(manifest.get("run_command") or "").strip(),
            "setup_command": str(manifest.get("setup_command") or "").strip(),
            "notes": str(manifest.get("notes") or "").strip(),
        }

    def _build_context(
        self,
        scenarios: Optional[list[Any]],
        feature_paths: Optional[list[str]],
    ) -> str:
        parts: list[str] = []
        for path in feature_paths or []:
            rel = str(path or "").strip()
            if not rel:
                continue
            try:
                target = resolve_in_root(self.workspace, rel)
                if target.is_file():
                    parts.append(f"### {rel}\n{target.read_text(encoding='utf-8')}")
                else:
                    parts.append(f"### {rel}\n(not found)")
            except (PathEscape, OSError, UnicodeDecodeError) as e:
                parts.append(f"### {rel}\n(could not read: {e})")
        for i, sc in enumerate(scenarios or [], start=1):
            if isinstance(sc, str):
                parts.append(f"### scenario {i}\n{sc}")
            else:
                import json
                try:
                    parts.append(f"### scenario {i}\n{json.dumps(sc, ensure_ascii=False, default=str)}")
                except (TypeError, ValueError):
                    parts.append(f"### scenario {i}\n{sc}")
        return "\n\n".join(parts)
