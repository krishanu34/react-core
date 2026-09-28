"""BaseTool + shared plumbing.

A tool is a small class with:
  - `name`         — the string the LLM uses to call it
  - `description`  — one paragraph explaining when to use it
  - `parameters()` — JSON schema for `run()`'s kwargs
  - `run(**kwargs)`— the async implementation

Tools that need to emit intermediate SSE events (streaming shell output,
questions to the user) set `SUPPORTS_STREAMING = True` and accept an
`on_event` kwarg.
"""
from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any


class BaseTool:
    name: str = ""
    description: str = ""
    SUPPORTS_STREAMING: bool = False

    def __init__(self, workspace: str | Path):
        self.workspace = str(workspace)

    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    def schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters(),
        }


def signature_from_schema(tool: BaseTool) -> str:
    params = tool.parameters()
    props = params.get("properties", {})
    required = set(params.get("required", []))
    if not props:
        return ""
    parts: list[str] = []
    for key in props:
        parts.append(key if key in required else f"[{key}]")
    return ", ".join(parts)


def is_async_run(tool: BaseTool) -> bool:
    return inspect.iscoroutinefunction(tool.run)
