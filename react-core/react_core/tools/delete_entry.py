"""delete_entry — remove a file or directory tree inside the workspace."""
from __future__ import annotations

import shutil
from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool


class DeleteEntryTool(BaseTool):
    name = "delete_entry"
    description = (
        "Delete a file or directory. Directories are removed recursively. "
        "Requires `confirm=true` for recursive directory deletes to avoid "
        "accidental data loss. Refuses to delete the workspace root itself."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative path."},
                "confirm": {
                    "type": "boolean",
                    "description": "Must be true to delete a non-empty directory.",
                },
            },
            "required": ["path"],
        }

    async def run(self, path: str, confirm: bool = False) -> dict[str, Any]:
        try:
            abs_path = resolve_in_root(self.workspace, path)
        except PathEscape as e:
            return {"error": str(e)}
        if str(abs_path) == str(resolve_in_root(self.workspace, ".")):
            return {"error": "Refusing to delete the workspace root."}
        if not abs_path.exists():
            return {"error": f"Not found: {path}"}
        try:
            if abs_path.is_dir():
                any_children = any(abs_path.iterdir())
                if any_children and not confirm:
                    return {
                        "status": "confirmation_required",
                        "path": path,
                        "reason": "directory is not empty — pass confirm=true to delete recursively.",
                    }
                shutil.rmtree(abs_path)
            else:
                abs_path.unlink()
        except OSError as e:
            return {"error": f"Could not delete '{path}': {e}"}
        return {"path": path, "deleted": True}
