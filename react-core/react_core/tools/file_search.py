"""file_search — glob-based file finder, newest-modified first."""
from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Any

from ..permissions import scan_policy
from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool

MAX_RESULTS = 200
MAX_WALK_FILES = 50_000


def _matches_glob(rel_path: str, pattern: str) -> bool:
    if not pattern:
        return True
    if "/" not in pattern and "**" not in pattern:
        return fnmatch.fnmatch(Path(rel_path).name, pattern)
    return _glob_to_regex_match(rel_path, pattern)


def _glob_to_regex_match(rel_path: str, pattern: str) -> bool:
    import re
    out: list[str] = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                if i + 2 < len(pattern) and pattern[i + 2] == "/":
                    out.append("(?:.*/)?")
                    i += 3
                    continue
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
            i += 1
            continue
        if c == "?":
            out.append(".")
        elif c in ".+^${}()|[]\\":
            out.append(re.escape(c))
        else:
            out.append(c)
        i += 1
    return re.match(f"^{''.join(out)}$", rel_path, flags=re.IGNORECASE) is not None


class FileSearchTool(BaseTool):
    name = "file_search"
    description = (
        "Find files whose name/path matches a glob, sorted newest-modified "
        "first. A pattern without '/' or '**' matches basenames anywhere "
        "(e.g. '*.py'); with '/' or '**' it matches workspace-relative "
        "paths (e.g. 'src/**/*.ts'). Capped at 200 results."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern, e.g. '*.py' or 'src/**/*.ts'."},
                "path": {"type": "string", "description": "Subdirectory to search. Default: workspace root."},
                "include_ignored": {"type": "boolean", "description": scan_policy.INCLUDE_IGNORED_DESCRIPTION},
            },
            "required": ["pattern"],
        }

    async def run(
        self,
        pattern: str,
        path: str = "",
        include_ignored: bool = False,
    ) -> dict[str, Any]:
        try:
            base = resolve_in_root(self.workspace, path) if path else Path(self.workspace).resolve()
        except PathEscape as e:
            return {"error": str(e)}
        if not base.is_dir():
            return {"error": f"Not a directory: {path or '.'}"}

        policy = scan_policy.build(
            self.workspace,
            include_ignored=bool(include_ignored),
            search_path=path or "",
            file_pattern=pattern or "",
        )
        prefix = f"{path.strip('/')}/" if path and path != "." else ""

        collected: list[tuple[str, int, float]] = []
        walked = 0
        stack: list[tuple[Path, str]] = [(base, prefix)]
        while stack and walked < MAX_WALK_FILES:
            cur, rel_prefix = stack.pop()
            try:
                children = list(cur.iterdir())
            except OSError:
                continue
            for child in children:
                child_rel = f"{rel_prefix}{child.name}"
                if child.is_dir():
                    if policy.skip_dir(child.name, child_rel):
                        continue
                    stack.append((child, f"{child_rel}/"))
                elif child.is_file():
                    if _matches_glob(child.name, pattern) or _matches_glob(child_rel, pattern):
                        try:
                            st = child.stat()
                            collected.append((child_rel, st.st_size, st.st_mtime))
                        except OSError:
                            continue
                    walked += 1
                    if walked >= MAX_WALK_FILES:
                        break

        collected.sort(key=lambda x: -x[2])
        window = collected[:MAX_RESULTS]
        from datetime import datetime, timezone

        result: dict[str, Any] = {
            "pattern": pattern,
            "search_path": path or ".",
            "total_found": len(collected),
            "sorted_by": "modification time, newest first",
            "scope": policy.describe(),
            "files": [
                {
                    "path": p,
                    "size": size,
                    "modified": datetime.fromtimestamp(mt, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"),
                }
                for (p, size, mt) in window
            ],
        }
        if len(collected) > MAX_RESULTS:
            result["truncated"] = True
            result["hint"] = f"Showing 200 of {len(collected)} matches — narrow with `path` or `pattern`."
        return result
