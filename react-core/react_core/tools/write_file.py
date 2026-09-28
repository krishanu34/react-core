"""write_file — create or overwrite a text file inside the workspace."""
from __future__ import annotations

from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool

MAX_WRITE_BYTES = 2_000_000


class WriteFileTool(BaseTool):
    name = "write_file"
    description = (
        "Create or overwrite a text file at a workspace-relative path. "
        "Parent directories are created as needed. Use `code_edit` for "
        "targeted changes to an existing file — this replaces the whole "
        "content."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative path to create or overwrite.",
                },
                "content": {
                    "type": "string",
                    "description": "The file's new content (UTF-8 text).",
                },
            },
            "required": ["path", "content"],
        }

    async def run(self, path: str, content: str) -> dict[str, Any]:
        try:
            abs_path = resolve_in_root(self.workspace, path)
        except PathEscape as e:
            return {"error": str(e)}

        data = str(content or "")
        if len(data.encode("utf-8")) > MAX_WRITE_BYTES:
            return {"error": f"Refusing to write >{MAX_WRITE_BYTES} bytes at once."}

        try:
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            abs_path.write_text(data, encoding="utf-8")
        except OSError as e:
            return {"error": f"Could not write '{path}': {e}"}

        return {
            "path": path,
            "bytes_written": len(data.encode("utf-8")),
            "lines": data.count("\n") + (0 if data.endswith("\n") or not data else 1),
        }
