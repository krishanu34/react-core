"""batch_read_files — read many files in one tool call to save round trips."""
from __future__ import annotations

from typing import Any

from .base import BaseTool
from .read_file import ReadFileTool

MAX_FILES = 20


class BatchReadFilesTool(BaseTool):
    name = "batch_read_files"
    description = (
        "Read up to 20 files in one call — same output as calling `read_file` "
        "on each. Useful when you know which files matter and want to avoid "
        "one LLM round trip per file."
    )

    def __init__(self, workspace: str):
        super().__init__(workspace)
        self._reader = ReadFileTool(workspace)

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Workspace-relative paths, max 20.",
                },
                "offset": {"type": "integer", "description": "Line offset applied to every file."},
                "limit": {"type": "integer", "description": "Line limit applied to every file."},
            },
            "required": ["paths"],
        }

    async def run(self, paths: list[str], offset: int = 1, limit: int = 500) -> dict[str, Any]:
        if not isinstance(paths, list) or not paths:
            return {"error": "paths must be a non-empty list of strings."}
        paths = paths[:MAX_FILES]
        results: list[dict[str, Any]] = []
        for p in paths:
            results.append(await self._reader.run(path=p, offset=offset, limit=limit))
        return {"files": results, "count": len(results)}
