"""create_entry — make an empty file or a directory."""
from __future__ import annotations

from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool


class CreateEntryTool(BaseTool):
    name = "create_entry"
    description = (
        "Create an empty file (`type='file'`) or a directory (`type='folder'`) "
        "at a workspace-relative path. Parent directories are created as "
        "needed. Fails if the path already exists."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative path to create."},
                "type": {
                    "type": "string",
                    "enum": ["file", "folder"],
                    "description": "'file' or 'folder'. Default: 'file'.",
                },
            },
            "required": ["path"],
        }

    async def run(self, path: str, type: str = "file") -> dict[str, Any]:
        try:
            abs_path = resolve_in_root(self.workspace, path)
        except PathEscape as e:
            return {"error": str(e)}
        if abs_path.exists():
            return {"error": f"Already exists: {path}"}
        try:
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            if type == "folder":
                abs_path.mkdir()
            else:
                abs_path.touch()
        except OSError as e:
            return {"error": f"Could not create '{path}': {e}"}
        return {"path": path, "type": type, "created": True}
