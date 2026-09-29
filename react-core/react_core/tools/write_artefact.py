"""write_artefact — the general JSON + Markdown artefact writer the prompt
promises.

The system prompt instructs the agent to "always call `write_artefact`" for
model artefacts (analysis.json, test_strategy.json, state_model.json, …), but
until now no such tool was registered — only the internal
`artefacts.writer.write_artefact` function used by `generate_gherkin`. This
tool exposes that function to the agent, enforcing invariant I3 (every
artefact ships as a JSON + Markdown pair, both recorded in the App DB).

When `kind` names a known schema the payload is round-tripped through the
matching dataclass, catching shape mistakes early (mirrors `generate_gherkin`
strictness). Unknown kinds are written as-is.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from ..artefacts import (
    Analysis,
    CauseEffectModel,
    DataModel,
    StateModel,
    TestStrategy,
)
from ..artefacts.writer import ArtefactWriteError, write_artefact
from .base import BaseTool

# kind -> dataclass with from_dict/to_dict, for optional shape validation.
_SCHEMA_BY_KIND: dict[str, Any] = {
    "analysis": Analysis,
    "test_strategy": TestStrategy,
    "state_model": StateModel,
    "cause_effect_model": CauseEffectModel,
    "data_model": DataModel,
}


class WriteArtefactTool(BaseTool):
    name = "write_artefact"
    description = (
        "Write a QA artefact as a JSON + Markdown pair (invariant I3), both "
        "recorded in the artefact store. Use for analysis, test_strategy, and "
        "the optional model artefacts (state_model, cause_effect_model, "
        "data_model) — anything the prompt tells you to persist as JSON+MD. "
        "`kind` names the artefact type; `rel_path` is where to write (with or "
        "without extension, e.g. 'artefacts/analysis'); `data` is the JSON "
        "object; `markdown` is the human-readable view (auto-rendered if "
        "omitted). Do NOT use for Gherkin — call `generate_gherkin` instead."
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
                "kind": {
                    "type": "string",
                    "description": (
                        "Artefact type: 'analysis' | 'test_strategy' | "
                        "'state_model' | 'cause_effect_model' | 'data_model' | "
                        "or any custom label for a generic artefact."
                    ),
                },
                "rel_path": {
                    "type": "string",
                    "description": "Destination, e.g. 'artefacts/models/state_model' (extension optional).",
                },
                "data": {
                    "type": "object",
                    "description": "The JSON payload for the artefact.",
                },
                "markdown": {
                    "type": "string",
                    "description": "Human-readable Markdown. If omitted, a basic view is rendered from `data`.",
                },
            },
            "required": ["kind", "rel_path", "data"],
        }

    async def run(
        self,
        kind: str,
        rel_path: str,
        data: Any,
        markdown: Optional[str] = None,
        **_: Any,
    ) -> dict[str, Any]:
        kind = (kind or "").strip() or "artefact"
        if not isinstance(data, dict):
            return {"error": "data must be a JSON object"}
        if not (rel_path or "").strip():
            return {"error": "rel_path is required"}

        # Validate against a known schema WITHOUT coercing — round-tripping
        # through the dataclass would drop every field the schema doesn't
        # model (e.g. a security plan's custom sections under 'test_strategy'),
        # which silently produced empty artefacts. We validate shape, then
        # persist the agent's raw data in full.
        schema = _SCHEMA_BY_KIND.get(kind)
        if schema is not None:
            try:
                schema.from_dict(data)
            except Exception as e:  # noqa: BLE001
                return {"error": f"data does not match the '{kind}' schema: {e}"}

        md = markdown if (markdown and markdown.strip()) else _fallback_markdown(kind, rel_path, data)

        try:
            json_path, md_path = write_artefact(
                self.workspace, rel_path, data, md,
                org_id=self._org_id, thread_id=self._thread_id,
                project_id=self._project_id, kind=kind,
            )
        except ArtefactWriteError as e:
            return {"error": str(e)}
        except Exception as e:  # noqa: BLE001
            return {"error": f"failed to write artefact: {e}"}

        return {
            "kind": kind,
            "path_json": str(json_path),
            "path_markdown": str(md_path),
        }


def _fallback_markdown(kind: str, rel_path: str, data: dict[str, Any]) -> str:
    title = data.get("title") or data.get("summary_one_paragraph") or rel_path
    try:
        body = json.dumps(data, indent=2, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        body = str(data)
    return f"# {kind}: {title}\n\n```json\n{body}\n```\n"
