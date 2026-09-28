"""analyze_requirements — structured breakdown of the requirement corpus.

Single LLM call producing strict JSON per the schema in `docs/qa-layer-spec.md`
§7. The agent decides when to invoke it (spec §5.3 policy: "high-leverage
when the source is unclear"). No workflow phase; just a tool.

Result carries a `gaps_significant` flag the agent uses to decide whether to
`ask_user` before proceeding.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..artefacts import derive_gaps_significant
from ..llm.base import LLMError
from ..llm.factory import create_llm
from ..llm.structured_output import extract_json
from .base import BaseTool

log = logging.getLogger(__name__)


_ANALYSIS_PROMPT = """You are a senior QA analyst. Read the requirement corpus below \
and produce a STRICT JSON analysis matching the schema. No prose, no markdown \
fences — return the JSON object only.

## CORPUS

### User brief
{brief}

{fetched_sections}

## SCHEMA
{{
  "source_type": "user_story" | "requirement_doc" | "app_context" | "mixed",
  "summary_one_paragraph": string,
  "acceptance_criteria": [
    {{"id": "AC-1", "statement": string, "testable": boolean, "source_ref": string}}
  ],
  "ambiguities": [{{"text": string, "impact": "high" | "med" | "low"}}],
  "missing_NFRs": [string],
  "unstated_assumptions": [string],
  "testability_issues": [string],
  "risk_areas": [{{"area": string, "likelihood": "high"|"med"|"low", "impact": "high"|"med"|"low", "reason": string}}],
  "suggested_questions": [string],
  "state_hints": [string],
  "entity_hints": [string],
  "cause_effect_hints": [string],
  "edge_case_hints": [string],
  "gaps_significant": boolean
}}

## RULES
- Fabricate NOTHING. Every acceptance_criterion.statement must be a fair \
paraphrase of a substring of the corpus. Set `source_ref` to a short quote \
or section name from the corpus.
- If no clear ACs are present in the corpus, return `acceptance_criteria: []` \
and set `gaps_significant: true`.
- `missing_NFRs` names classes of NFRs not covered (e.g. "latency", \
"availability", "compliance regime"). Empty when the corpus is comprehensive.
- `state_hints` / `entity_hints` / `cause_effect_hints` / `edge_case_hints` \
are short strings the DESIGN phase can grow into model artefacts. Empty is fine.
- `gaps_significant` MUST be true when: acceptance_criteria is empty, OR \
missing_NFRs is non-empty, OR any ambiguity has impact="high".

Return ONLY the JSON object.
"""


class AnalyzeRequirementsTool(BaseTool):
    name = "analyze_requirements"
    description = (
        "Analyse the current requirement corpus (user brief + any fetched "
        "Jira / Confluence / attachment content) and return a structured "
        "breakdown: source classification, acceptance criteria, ambiguities, "
        "gaps, risks, suggested questions, and design-phase hints. Call "
        "whenever you cannot confidently list the acceptance criteria "
        "from what the user gave you. Its result's `gaps_significant` "
        "flag tells you whether to `ask_user` before designing."
    )

    def __init__(self, workspace: str, *, llm_factory=create_llm):
        super().__init__(workspace)
        self._llm_factory = llm_factory

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "brief": {
                    "type": "string",
                    "description": "The user's raw brief.",
                },
                "fetched": {
                    "type": "array",
                    "description": "Optional list of {source, text} for connector / attachment content the agent has already retrieved.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "text": {"type": "string"},
                        },
                        "required": ["source", "text"],
                    },
                },
            },
            "required": ["brief"],
        }

    async def run(
        self,
        brief: str,
        fetched: Optional[list[dict[str, Any]]] = None,
        **_: Any,
    ) -> dict[str, Any]:
        brief = (brief or "").strip()
        if not brief:
            return {"error": "brief is required"}

        try:
            llm = self._llm_factory()
        except Exception as e:  # noqa: BLE001
            return {"error": f"LLM not configured: {e}"}

        prompt = _ANALYSIS_PROMPT.format(
            brief=brief,
            fetched_sections=_render_fetched(_normalize_fetched(fetched)),
        )

        try:
            response = await llm.complete(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                response_format={"type": "json_object"},
            )
        except (LLMError, TypeError):
            # Some providers don't accept response_format=json_object — retry
            # without it. The extractor tolerates fenced or leading-prose JSON.
            try:
                llm = self._llm_factory()
                response = await llm.complete(
                    [{"role": "user", "content": prompt}],
                    temperature=0.0,
                )
            except Exception as e:  # noqa: BLE001
                return {"error": f"analysis failed: {e}"}
        except Exception as e:  # noqa: BLE001
            return {"error": f"analysis failed: {e}"}

        try:
            data = extract_json(response)
        except Exception as e:  # noqa: BLE001
            return {"error": f"analysis returned unparseable JSON: {e}", "raw": response[:800]}
        if not isinstance(data, dict):
            return {"error": "analysis JSON was not an object"}

        # Belt-and-braces: re-derive `gaps_significant` from the actual fields
        # in case the LLM lied to itself.
        data["gaps_significant"] = derive_gaps_significant(data)
        return data


def _render_fetched(fetched: list[dict[str, Any]]) -> str:
    if not fetched:
        return "### Fetched context\n_(none)_\n"
    parts: list[str] = ["### Fetched context\n"]
    for item in fetched:
        src = str(item.get("source") or "unknown").strip()
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        parts.append(f"#### {src}\n{text[:6000]}\n")
    return "\n".join(parts)


# LLMs freely pass `fetched` as a plain string, a bare dict, a list of strings,
# or a list of {source, text}. Coerce everything into [{source, text}] before
# rendering — otherwise `.get(...)` blows up on non-dict elements.
def _normalize_fetched(fetched: Any) -> list[dict[str, str]]:
    if fetched is None:
        return []
    if isinstance(fetched, str):
        s = fetched.strip()
        return [{"source": "context", "text": s}] if s else []
    if isinstance(fetched, dict):
        return [_coerce_fetched_item(fetched, fallback="context")]
    if isinstance(fetched, list):
        out: list[dict[str, str]] = []
        for i, item in enumerate(fetched, start=1):
            if item is None:
                continue
            if isinstance(item, str):
                s = item.strip()
                if s:
                    out.append({"source": f"item-{i}", "text": s})
            elif isinstance(item, dict):
                out.append(_coerce_fetched_item(item, fallback=f"item-{i}"))
        return out
    return [{"source": "context", "text": str(fetched)}]


def _coerce_fetched_item(item: dict[str, Any], *, fallback: str) -> dict[str, str]:
    source = str(item.get("source") or item.get("title") or fallback).strip() or fallback
    text = item.get("text") or item.get("body") or item.get("content") or ""
    if not text:
        # No conventional text field — flatten the remaining scalars so the
        # analyst still sees whatever the caller thought was worth passing.
        parts: list[str] = []
        for k, v in item.items():
            if k in {"source", "title", "text", "body", "content"}:
                continue
            if isinstance(v, (str, int, float, bool)):
                parts.append(f"{k}: {v}")
        text = "\n".join(parts)
    return {"source": source, "text": str(text)}
