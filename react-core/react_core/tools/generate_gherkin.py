"""generate_gherkin — render Gherkin scenarios with traceability tags and
enforce the AC coverage invariant at output time.

Invariant I1 (from `docs/qa-layer-spec.md` §5.2): every AC in a delivered
`.feature` file has ≥1 scenario. When `strict=True` (the default) and any
AC is uncovered, this tool refuses to write and returns a machine-readable
error the agent can iterate on.

Every scenario carries three traceability tags:
  @priority:<critical|high|medium|low>
  @technique:<BVA|EP|decision-table|state-transition|cause-effect|risk-based|pairwise|...>
  @requirement:<AC-x>          (one per referenced AC)
Optional additional tag when a model artefact drove the scenario:
  @source:<state_model.json#PAID->REFUNDED>
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

from ..artefacts import (
    Analysis,
    GherkinFeature,
    GherkinScenario,
    GherkinStep,
    write_artefact,
)
from ..artefacts.writer import write_text_artefact
from .base import BaseTool

log = logging.getLogger(__name__)


# LLMs freely swap between three shapes for AC references. We accept all.
_AC_TAG_RE = re.compile(r"^@(?:requirement:)?(AC-[A-Za-z0-9._-]+)$", re.IGNORECASE)


class GenerateGherkinTool(BaseTool):
    name = "generate_gherkin"
    description = (
        "Produce Gherkin scenarios (Given/When/Then) with @requirement, "
        "@technique and @source traceability tags. REFUSES to write output "
        "when any acceptance criterion has zero scenario coverage (strict "
        "mode, default). On refusal, returns the uncovered AC ids so you "
        "can add scenarios and call again."
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
                    "description": "The Analysis JSON produced earlier by `analyze_requirements`.",
                },
                "scenarios_in": {
                    "type": "array",
                    "description": "Design scenarios. Each: {id, title, priority?, technique_used?, acceptance_criteria_refs: [...], model_refs?: [...], background?: [{kind,text}], steps: [{kind,text}], examples?: [{...}]}.",
                    "items": {"type": "object"},
                },
                "feature_title": {"type": "string"},
                "feature_description": {"type": "string"},
                "rel_path": {
                    "type": "string",
                    "description": "Where to write, e.g. 'artefacts/features/billing.feature'.",
                },
                "strict": {
                    "type": "boolean",
                    "description": "Refuse to write on any coverage gap. Default true.",
                },
            },
            "required": ["analysis", "scenarios_in", "feature_title", "rel_path"],
        }

    async def run(
        self,
        analysis: dict[str, Any],
        scenarios_in: list[dict[str, Any]],
        feature_title: str,
        rel_path: str,
        feature_description: Optional[str] = None,
        strict: bool = True,
        **_: Any,
    ) -> dict[str, Any]:
        if not isinstance(analysis, dict):
            return {"error": "analysis must be a JSON object"}
        if not isinstance(scenarios_in, list) or not scenarios_in:
            return {"error": "scenarios_in must be a non-empty array"}

        parsed_analysis = Analysis.from_dict(analysis)
        ac_ids = [ac.id for ac in parsed_analysis.acceptance_criteria if ac.id]
        ac_id_set = set(ac_ids)

        # ---- build scenarios + coverage ----------------------------------
        gherkin_scenarios: list[GherkinScenario] = []
        covered: set[str] = set()
        technique_counts: dict[str, int] = {}
        for raw in scenarios_in:
            gs = _to_gherkin_scenario(raw)
            gherkin_scenarios.append(gs)
            for ref in gs.acceptance_criteria_refs:
                covered.add(ref)
            for t in gs.tags:
                if t.startswith("@technique:"):
                    technique_counts[t.split(":", 1)[1]] = technique_counts.get(t.split(":", 1)[1], 0) + 1

        uncovered = sorted(ac_id_set - covered) if ac_id_set else []
        coverage_summary: dict[str, Any] = {
            "ac_total": len(ac_id_set),
            "ac_covered": len(ac_id_set - set(uncovered)),
            "uncovered": uncovered,
            "scenarios": len(gherkin_scenarios),
            "techniques_used": sorted(technique_counts.keys()),
        }

        if strict and uncovered:
            return {
                "error": "AC coverage gap",
                "uncovered": uncovered,
                "coverage_summary": coverage_summary,
            }

        feature = GherkinFeature(
            feature=feature_title.strip(),
            description=(feature_description or "").strip() or None,
            scenarios=gherkin_scenarios,
            coverage_summary=coverage_summary,
        )

        # ---- render + write ----------------------------------------------
        feature_text = _render_gherkin(feature)
        summary_md = _render_summary_md(feature, parsed_analysis)

        feature_rel = _scope_under_thread_docs(_ensure_extension(rel_path, ".feature"), self._thread_id)
        base_rel = feature_rel[: -len(".feature")]

        try:
            feature_path = write_text_artefact(
                self.workspace, feature_rel, feature_text,
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind="gherkin_feature",
            )
            json_path, md_path = write_artefact(
                self.workspace, base_rel, feature, summary_md,
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind="gherkin",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"failed to write artefacts: {e}"}

        return {
            "path_feature": str(feature_path),
            "path_json": str(json_path),
            "path_summary": str(md_path),
            "coverage_summary": coverage_summary,
        }


# ---- helpers --------------------------------------------------------------

def _extract_ac_refs(raw: dict[str, Any]) -> list[str]:
    """Collect AC references from any of the common shapes the LLM emits.

    Priority order:
      1. `acceptance_criteria_refs: ["AC-1", ...]`  (canonical)
      2. `requirement_ids: [...]`  or `requirements: [...]`
      3. `requirement_id: "AC-1"`  (single)
      4. `tags: ["@requirement:AC-1", "@AC-2", ...]`
    Any combination is accepted; duplicates are removed.
    """
    seen: set[str] = set()
    out: list[str] = []

    def _push(value: Any) -> None:
        s = str(value).strip()
        if not s or s in seen:
            return
        seen.add(s)
        out.append(s)

    for field in ("acceptance_criteria_refs", "requirement_ids", "requirements"):
        for x in raw.get(field) or []:
            _push(x)

    single = raw.get("requirement_id")
    if single:
        _push(single)

    for tag in raw.get("tags") or []:
        m = _AC_TAG_RE.match(str(tag).strip())
        if m:
            _push(m.group(1))

    return out


def _to_gherkin_scenario(raw: dict[str, Any]) -> GherkinScenario:
    sid = str(raw.get("id") or "").strip()
    title = str(raw.get("title") or raw.get("name") or "").strip()
    priority = str(raw.get("priority") or "medium").lower()
    technique = str(raw.get("technique_used") or raw.get("technique") or "risk-based")
    ac_refs = _extract_ac_refs(raw)
    model_refs = [str(x) for x in (raw.get("model_refs") or [])]
    extra_tags = [str(t) for t in (raw.get("tags") or []) if str(t).startswith("@")]

    tags: list[str] = [f"@priority:{priority}", f"@technique:{technique}"]
    tags.extend(f"@requirement:{r}" for r in ac_refs)
    tags.extend(f"@source:{r}" for r in model_refs)
    tags.extend(extra_tags)
    # Deduplicate while preserving order.
    seen: set[str] = set()
    ordered: list[str] = []
    for t in tags:
        if t not in seen:
            ordered.append(t)
            seen.add(t)

    background_raw = raw.get("background")
    background: Optional[list[GherkinStep]] = None
    if isinstance(background_raw, list):
        background = [GherkinStep.from_dict(s) for s in background_raw]
    elif isinstance(background_raw, str) and background_raw.strip():
        # LLMs sometimes emit background as a single blob of "Given X\nAnd Y".
        background = [
            GherkinStep.from_dict(line)
            for line in background_raw.splitlines()
            if line.strip()
        ]

    steps_raw = raw.get("steps") or []
    if isinstance(steps_raw, str):
        steps_raw = [line for line in steps_raw.splitlines() if line.strip()]
    steps = [GherkinStep.from_dict(s) for s in steps_raw]

    examples = raw.get("examples") if isinstance(raw.get("examples"), list) else None

    return GherkinScenario(
        id=sid,
        name=title,
        tags=ordered,
        background=background,
        steps=steps,
        acceptance_criteria_refs=ac_refs,
        examples=examples,
    )


def _render_gherkin(feature: GherkinFeature) -> str:
    lines: list[str] = []
    lines.append(f"Feature: {feature.feature}")
    if feature.description:
        for line in feature.description.splitlines():
            lines.append(f"  {line}")
    lines.append("")
    for sc in feature.scenarios:
        for tag in sc.tags:
            lines.append(f"  {tag}")
        keyword = "Scenario Outline" if sc.examples else "Scenario"
        lines.append(f"  {keyword}: {sc.name}")
        if sc.background:
            lines.append("    # Background")
            _emit_steps(lines, sc.background, indent="    ")
        _emit_steps(lines, sc.steps, indent="    ")
        if sc.examples:
            lines.append("    Examples:")
            _emit_examples(lines, sc.examples, indent="      ")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _emit_steps(lines: list[str], steps: list[GherkinStep], *, indent: str) -> None:
    seen_first = False
    for step in steps:
        kind = (step.kind or "given").lower()
        if kind not in {"given", "when", "then", "and", "but"}:
            kind = "and" if seen_first else "given"
        keyword = kind.capitalize()
        lines.append(f"{indent}{keyword} {step.text}")
        seen_first = True


def _emit_examples(lines: list[str], examples: list[dict], *, indent: str) -> None:
    """Render a Gherkin Examples table from the first example row's schema."""
    if not examples:
        return
    headers = list(examples[0].keys())
    lines.append(f"{indent}| " + " | ".join(str(h) for h in headers) + " |")
    for row in examples:
        lines.append(f"{indent}| " + " | ".join(str(row.get(h, "")) for h in headers) + " |")


def _render_summary_md(feature: GherkinFeature, analysis: Analysis) -> str:
    cs = feature.coverage_summary
    lines: list[str] = []
    lines.append(f"# {feature.feature} — Coverage Summary")
    lines.append("")
    lines.append(f"- **Scenarios:** {cs.get('scenarios', 0)}")
    lines.append(f"- **ACs covered:** {cs.get('ac_covered', 0)} / {cs.get('ac_total', 0)}")
    lines.append(f"- **Techniques used:** {', '.join(cs.get('techniques_used') or ['—'])}")
    uncovered = cs.get("uncovered") or []
    if uncovered:
        lines.append(f"- **Uncovered ACs:** {', '.join(uncovered)}")
    lines.append("")
    lines.append("## Scenarios")
    lines.append("")
    lines.append("| ID | Name | Priority | Technique | ACs |")
    lines.append("|---|---|---|---|---|")
    for sc in feature.scenarios:
        prio = _tag_value(sc.tags, "@priority:") or "medium"
        tech = _tag_value(sc.tags, "@technique:") or "—"
        acs = ", ".join(sc.acceptance_criteria_refs) or "—"
        lines.append(f"| {sc.id} | {sc.name} | {prio} | {tech} | {acs} |")
    if analysis.acceptance_criteria:
        lines.append("")
        lines.append("## Acceptance Criteria")
        lines.append("")
        for ac in analysis.acceptance_criteria:
            check = "✅" if ac.id not in uncovered else "❌"
            lines.append(f"- {check} **{ac.id}** — {ac.statement}")
    return "\n".join(lines) + "\n"


def _tag_value(tags: list[str], prefix: str) -> Optional[str]:
    for t in tags:
        if t.startswith(prefix):
            return t[len(prefix):]
    return None


def _ensure_extension(rel_path: str, ext: str) -> str:
    r = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not r:
        raise ValueError("rel_path is required")
    return r if r.endswith(ext) else r + ext


def _scope_under_thread_docs(rel_path: str, thread_id: str) -> str:
    """Force output under `features/<thread_id>/docs/<basename>`.

    The LLM freely picks any `rel_path` (e.g. `artefacts/features/checkout.feature`);
    we take only the basename so files always land in the thread-scoped docs
    folder the web IDE renders.
    """
    tid = (thread_id or "unbound").strip() or "unbound"
    parts = [p for p in rel_path.replace("\\", "/").split("/") if p]
    basename = parts[-1] if parts else "feature.feature"
    return f"features/{tid}/docs/{basename}"
