"""workspace_tree — recursive tree using scan_policy pruning."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..permissions import scan_policy
from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool

MAX_ENTRIES = 2000
MAX_DEPTH = 8


class WorkspaceTreeTool(BaseTool):
    name = "workspace_tree"
    description = (
        "Show a recursive tree of the workspace, pruned by the project's "
        "ignore rules (node_modules, .venv, dist, build, __pycache__, …) so "
        "you see project code, not dependencies. Set `include_ignored=true` "
        "to see everything. Capped at 2000 entries."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative root of the tree. Default: '.'",
                },
                "max_depth": {
                    "type": "integer",
                    "description": f"Depth cap (default {MAX_DEPTH}).",
                },
                "include_ignored": {
                    "type": "boolean",
                    "description": scan_policy.INCLUDE_IGNORED_DESCRIPTION,
                },
            },
        }

    async def run(
        self,
        path: str = ".",
        max_depth: int = MAX_DEPTH,
        include_ignored: bool = False,
    ) -> dict[str, Any]:
        rel = (path or ".").strip()
        try:
            root_dir = resolve_in_root(self.workspace, rel) if rel not in (".", "") else Path(self.workspace)
        except PathEscape as e:
            return {"error": str(e)}
        if not root_dir.is_dir():
            return {"error": f"Not a directory: {path}"}

        policy = scan_policy.build(
            self.workspace,
            include_ignored=bool(include_ignored),
            search_path=rel if rel not in (".", "") else "",
        )

        lines: list[str] = []
        entries = 0
        truncated = False

        def walk(dir_path: Path, rel_prefix: str, depth: int) -> None:
            nonlocal entries, truncated
            if truncated or depth > max_depth:
                return
            try:
                children = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            except OSError:
                return
            for child in children:
                if entries >= MAX_ENTRIES:
                    truncated = True
                    return
                child_rel = f"{rel_prefix}{child.name}"
                if child.is_dir():
                    if policy.skip_dir(child.name, child_rel):
                        continue
                    lines.append(f"{'  ' * depth}{child.name}/")
                    entries += 1
                    walk(child, f"{child_rel}/", depth + 1)
                else:
                    lines.append(f"{'  ' * depth}{child.name}")
                    entries += 1

        walk(root_dir, rel + "/" if rel not in (".", "") else "", 0)

        result: dict[str, Any] = {
            "root": rel,
            "count": entries,
            "scope": policy.describe(),
            "tree": "\n".join(lines),
        }
        if truncated:
            result["truncated"] = True
            result["hint"] = "Tree capped at 2000 entries — narrow with `path` or reduce `max_depth`."
        return result
