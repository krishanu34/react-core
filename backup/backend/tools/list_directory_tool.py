"""
List Directory Tool

Lists files and folders in the project directory. Shows entry type
(file/dir), sizes for files, and filters out noise directories
and MARKS the noisy ones (node_modules, .venv, dist, …) instead of
hiding them.

Marking rather than hiding is the deliberate change. A single directory
listing is bounded, so there is nothing to gain by omitting entries — and
omitting them cost something real: the agent could not discover that
`node_modules` or `.venv` existed at all, so it could never decide to look
inside one. Now it sees `node_modules/  (ignored by default)` and can aim
grep_search or file_search at it when the question calls for it.

This operates on the ACTUAL project directory, not the sandbox.
"""

import os
from pathlib import Path

from context import scan_policy

from .base_tool import BaseTool


class ListDirectoryTool(BaseTool):

    name = "list_directory"

    description = (
        "List files and folders in a directory. Shows names, types "
        "(file/dir), and file sizes. Defaults to the project root. "
        "Nothing is hidden: dependency/build directories are listed with "
        "\"ignored\": true, meaning other search tools skip them unless you "
        "target them or pass include_ignored. "
        "Use this to understand project structure before reading files."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Directory path relative to project root. "
                        "Default: '.' (project root). "
                        "Examples: '.', 'agents', 'tools', 'src/components'"
                    )
                }
            },
            "required": []
        }

    async def run(self, path="."):
        target = Path(self._resolve_path(path))

        # Validate the directory exists
        if not target.exists():
            return {"error": f"Directory not found: {path}"}
        if not target.is_dir():
            return {"error": f"Not a directory: {path} (it's a file — use read_file instead)"}

        policy = scan_policy.build(self.workspace, path=path)
        rel_base = str(path or ".").replace("\\", "/").strip("/")
        if rel_base == ".":
            rel_base = ""

        entries = []
        ignored_count = 0
        try:
            for item in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if item.is_dir():
                    rel = f"{rel_base}/{item.name}" if rel_base else item.name
                    # HARD skips stay invisible: .git and .devaccel are
                    # plumbing, and listing them only invites the agent to
                    # waste a turn on them.
                    if item.name in scan_policy.HARD_SKIP_DIRS:
                        continue
                    ignored = policy.skip_dir(item.name, rel)
                    # Count immediate children to give a sense of size
                    try:
                        child_count = sum(1 for _ in item.iterdir())
                    except PermissionError:
                        child_count = "?"
                    entry = {
                        "name": item.name + "/",
                        "type": "dir",
                        "children": child_count,
                    }
                    if ignored:
                        entry["ignored"] = True
                        ignored_count += 1
                    entries.append(entry)
                else:
                    if policy.skip_file(item.name):
                        continue
                    try:
                        size = item.stat().st_size
                    except OSError:
                        continue
                    entries.append({
                        "name": item.name,
                        "type": "file",
                        "size": _human_size(size),
                        "size_bytes": size,
                    })
        except PermissionError:
            return {"error": f"Permission denied: {path}"}

        result = {
            "path": path,
            "total_entries": len(entries),
            "entries": entries,
        }
        if ignored_count:
            result["note"] = (
                f"{ignored_count} director{'y is' if ignored_count == 1 else 'ies are'} "
                f"marked \"ignored\": search tools skip them by default. To look "
                f"inside one, point path/file_pattern at it or pass "
                f"include_ignored=true."
            )
        return result


def _human_size(size_bytes: int) -> str:
    """Convert bytes to human readable: 1234 -> '1.2 KB'."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
