"""generate_nfr_tests — scaffold non-functional (performance / security) test
assets, so the QA persona's "performance and security" scope is actually
backed by tooling.

`discipline`:
  - 'performance' — load/stress scripts for k6, JMeter (JMX), Gatling, or
    Locust, plus a scenario profile (VUs, ramp, thresholds).
  - 'security'    — an OWASP-oriented plan: a ZAP automation-framework YAML,
    a checklist mapped to the OWASP Top 10, and targeted test cases for the
    endpoints in scope.

LLM-backed like `generate_automation`: the model returns a strict JSON file
manifest; this tool writes each file path-guarded under `target_dir`.
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
    """Coerce an LLM-supplied argument to text. Models often pass a dict/list
    where a string is expected (e.g. `context` as a JSON object)."""
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
_MAX_CONTEXT_CHARS = 16_000
_DISCIPLINES = {"performance", "security"}

_GUIDANCE = {
    "performance": (
        "Produce load/performance assets for the named tool (k6, jmeter, "
        "gatling, locust). Include a runnable script, a workload profile "
        "(virtual users, ramp-up, duration) and explicit pass/fail thresholds "
        "(p95 latency, error rate, throughput). Parameterise the base URL."
    ),
    "security": (
        "Produce an OWASP-oriented security test plan. Include a ZAP "
        "automation-framework YAML (or the named tool's config), a checklist "
        "mapped to the OWASP Top 10, and concrete abuse/negative test cases "
        "for the endpoints in scope. Do NOT include real exploit payloads "
        "against third parties — keep it to authorised testing of the target."
    ),
}

_PROMPT = """You are a senior {discipline} test engineer. Generate {discipline} \
test assets for the tool/framework below, derived ONLY from the provided \
context. Fabricate no requirements.

## DISCIPLINE GUIDANCE
{guidance}

## TARGET TOOL / FRAMEWORK
{framework}

## TARGET & NOTES
{notes}

## CONTEXT (requirements / endpoints / scenarios)
{context}

## OUTPUT — STRICT JSON, no prose, no fences
{{
  "files": [{{"path": "relative/path.ext", "content": "full contents"}}],
  "run_command": "how to execute",
  "setup_command": "how to install the tool (or empty)",
  "notes": "assumptions, thresholds, and safety notes"
}}

## RULES
- Real, runnable assets. Relative paths only — no absolute paths, no `..`.
- Encode thresholds / acceptance limits explicitly.
Return ONLY the JSON object.
"""


class GenerateNfrTestsTool(BaseTool):
    name = "generate_nfr_tests"
    description = (
        "Scaffold non-functional test assets. `discipline` is 'performance' "
        "(k6 / JMeter / Gatling / Locust load scripts with thresholds) or "
        "'security' (OWASP plan, ZAP automation config, abuse-case tests). "
        "Give a `framework`/tool and the endpoints or requirements in "
        "`context`. Writes a bundle under `target_dir` and returns the run "
        "command. Call `request_approval` first — these are expensive "
        "commitments, and security testing must be authorised."
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
                "discipline": {"type": "string", "description": "'performance' | 'security'."},
                "framework": {"type": "string", "description": "Tool, e.g. 'k6', 'jmeter', 'gatling', 'locust', 'zap'."},
                "context": {"type": "string", "description": "Requirements, endpoints, or scenarios to base the assets on."},
                "target_dir": {"type": "string", "description": "Directory for the bundle. Default 'nfr'."},
                "notes": {"type": "string", "description": "Target base URL, SLAs, auth notes, constraints."},
            },
            "required": ["discipline", "framework", "context"],
        }

    async def run(
        self,
        discipline: str,
        framework: str,
        context: Any = "",
        target_dir: str = "nfr",
        notes: Any = None,
        **_: Any,
    ) -> dict[str, Any]:
        discipline = _as_text(discipline).strip().lower()
        if discipline not in _DISCIPLINES:
            return {"error": f"discipline must be one of {sorted(_DISCIPLINES)}"}
        framework = _as_text(framework).strip()
        if not framework:
            return {"error": "framework is required"}
        context_text = _as_text(context).strip()
        if not context_text:
            return {"error": "context is required — provide endpoints or requirements to test"}
        notes_text = _as_text(notes).strip() or "(none)"

        try:
            llm = self._llm_factory()
        except Exception as e:  # noqa: BLE001
            return {"error": f"LLM not configured: {e}"}

        prompt = _PROMPT.format(
            discipline=discipline,
            guidance=_GUIDANCE[discipline],
            framework=framework,
            notes=notes_text,
            context=context_text[:_MAX_CONTEXT_CHARS],
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
                return {"error": f"{discipline} generation failed: {e}"}
        except Exception as e:  # noqa: BLE001
            return {"error": f"{discipline} generation failed: {e}"}

        try:
            manifest = extract_json(response)
        except Exception as e:  # noqa: BLE001
            return {"error": f"manifest was unparseable JSON: {e}", "raw": response[:800]}
        files = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(files, list) or not files:
            return {"error": "manifest contained no files"}

        base = (target_dir or "nfr").strip().strip("/") or "nfr"
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
            if ".." in rel.split("/") or rel.startswith("/"):
                skipped.append({"path": rel, "reason": "path must stay under target_dir"})
                continue
            if len(content.encode("utf-8")) > _MAX_FILE_BYTES:
                skipped.append({"path": rel, "reason": "file exceeds size cap"})
                continue
            full_rel = f"{base}/{rel}"
            try:
                resolve_in_root(self.workspace, full_rel)
                write_text_artefact(
                    self.workspace, full_rel, content,
                    org_id=self._org_id, thread_id=self._thread_id,
                    project_id=self._project_id, kind=f"nfr_{discipline}",
                )
                written.append(full_rel)
            except (PathEscape, ArtefactWriteError) as e:
                skipped.append({"path": rel, "reason": str(e)})
            except Exception as e:  # noqa: BLE001
                skipped.append({"path": rel, "reason": f"{type(e).__name__}: {e}"})

        if not written:
            return {"error": "no files could be written", "skipped": skipped}

        return {
            "discipline": discipline,
            "framework": framework,
            "target_dir": base,
            "files_written": written,
            "skipped": skipped,
            "run_command": str(manifest.get("run_command") or "").strip(),
            "setup_command": str(manifest.get("setup_command") or "").strip(),
            "notes": str(manifest.get("notes") or "").strip(),
        }
