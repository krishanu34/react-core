"""rename_entry — rename / move a file or directory within the workspace."""
from __future__ import annotations

import os
from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool


class RenameEntryTool(BaseTool):
    name = "rename_entry"
    description = (
        "Rename or move a file or directory to a new workspace-relative path. "
        "Both source and destination must stay inside the workspace. Fails if "
        "the destination already exists."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "old_path": {"type": "string", "description": "Current path."},
                "new_path": {"type": "string", "description": "Target path."},
            },
            "required": ["old_path", "new_path"],
        }

    async def run(self, old_path: str, new_path: str) -> dict[str, Any]:
        try:
            src = resolve_in_root(self.workspace, old_path)
            dst = resolve_in_root(self.workspace, new_path)
        except PathEscape as e:
            return {"error": str(e)}
        if not src.exists():
            return {"error": f"Source not found: {old_path}"}
        if dst.exists():
            return {"error": f"Destination already exists: {new_path}"}
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
        except OSError as e:
            return {"error": f"Could not rename '{old_path}' → '{new_path}': {e}"}
        return {"old_path": old_path, "new_path": new_path, "renamed": True}
