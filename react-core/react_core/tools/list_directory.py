"""list_directory — enumerate one directory (no recursion)."""
from __future__ import annotations

from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool


class ListDirectoryTool(BaseTool):
    name = "list_directory"
    description = (
        "List the immediate contents of one directory. Returns entries with "
        "type ('file' or 'dir') and size for files. Use `workspace_tree` for "
        "recursive listings."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative directory. Omit or '.' for the root.",
                },
            },
        }

    async def run(self, path: str = ".") -> dict[str, Any]:
        rel = path.strip() or "."
        try:
            if rel in (".", ""):
                abs_path = resolve_in_root(self.workspace, ".")
            else:
                abs_path = resolve_in_root(self.workspace, rel)
        except PathEscape as e:
            return {"error": str(e)}
        if not abs_path.exists():
            return {"error": f"Not found: {path}"}
        if not abs_path.is_dir():
            return {"error": f"Not a directory: {path}"}

        entries: list[dict[str, Any]] = []
        try:
            for child in sorted(abs_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                item: dict[str, Any] = {"name": child.name}
                try:
                    if child.is_dir():
                        item["type"] = "dir"
                    else:
                        item["type"] = "file"
                        item["size"] = child.stat().st_size
                except OSError:
                    item["type"] = "?"
                entries.append(item)
        except OSError as e:
            return {"error": f"Could not list '{path}': {e}"}

        return {"path": rel, "count": len(entries), "entries": entries}
