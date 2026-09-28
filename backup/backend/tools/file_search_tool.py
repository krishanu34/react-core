"""
File Search Tool

Finds files by name pattern (glob) in the project directory.
Returns relative paths with file sizes, newest first.

Use this to find files when you know part of the name but not
the full path — like "find all Python files" or "where is config.json".

Which directories are skipped is decided per call by context/scan_policy.py
rather than by a constant here: the project's own ignore files drive it, and
either `include_ignored` or simply pointing `path` at a dependency reaches
inside one. Five tools each carrying their own frozen list is how a directory
ended up hidden from grep but visible to workspace_tree.
"""

import os
from pathlib import Path

from context import scan_policy
from context.scan_policy import INCLUDE_IGNORED_DESCRIPTION

from .base_tool import BaseTool

# Max results to return
MAX_RESULTS = 100


class FileSearchTool(BaseTool):

    name = "file_search"

    description = (
        "Find files by name pattern (glob) in the project. Returns matching "
        "paths sorted by MODIFICATION TIME, newest first — on an existing "
        "codebase the recently-touched files are usually the relevant ones. "
        "Dependencies, build output and caches are skipped by default; set "
        "include_ignored=true or point `path` at the directory to look inside "
        "one. Use this to locate files when you know part of the name."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": (
                        "Glob pattern to match file names. "
                        "Examples: '*.py' (all Python files), "
                        "'**/*.json' (all JSON files recursively), "
                        "'*config*' (any file with 'config' in the name), "
                        "'requirements*.txt'"
                    )
                },
                "path": {
                    "type": "string",
                    "description": (
                        "Directory to search in, relative to project root. "
                        "Default: '.' (entire project). "
                        "Examples: 'agents', 'tools', 'src'. Pointing this at "
                        "a normally-skipped directory (node_modules/express, "
                        ".venv/Lib/site-packages/requests) searches it — an "
                        "explicit target is already the answer to 'should we "
                        "look there?'."
                    )
                },
                "include_ignored": {
                    "type": "boolean",
                    "description": INCLUDE_IGNORED_DESCRIPTION,
                }
            },
            "required": ["pattern"]
        }

    async def run(self, pattern, path=".", include_ignored=False):
        root = Path(self._resolve_path(path))
        policy = scan_policy.build(
            self.workspace,
            include_ignored=bool(include_ignored),
            path=path,
            file_pattern=pattern,
        )

        if not root.exists():
            return {"error": f"Directory not found: {path}"}
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}

        # Collect ALL matches before capping, because the cap must keep the
        # most RECENT files, not whichever os.walk visited first. Sorting by
        # modification time is Claude Code's Glob behaviour, and it matters
        # most on brownfield code: in a 10-year-old repo, the files touched
        # last month are almost always the ones the question is about.
        collected = []
        # resolve() both sides or relative_to() throws when the workspace was
        # handed to us as a Windows 8.3 short path (C:\Users\CHARLE~1.DON\…)
        # while _resolve_path expanded the walk root to the long form — every
        # file then silently skips and the result is empty.
        project_root = Path(self.workspace).resolve()

        for file_path in _find_files(root, pattern, policy):
            try:
                stat = file_path.stat()
                rel_path = str(file_path.relative_to(project_root)).replace("\\", "/")
            except (OSError, ValueError):
                continue
            collected.append((stat.st_mtime, rel_path, stat.st_size))
            if len(collected) >= 5000:  # bound the sort on pathological trees
                break

        collected.sort(key=lambda item: -item[0])

        import datetime
        results = [
            {
                "path": rel_path,
                "size": size,
                "modified": datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M"),
            }
            for mtime, rel_path, size in collected[:MAX_RESULTS]
        ]

        out = {
            "pattern": pattern,
            "search_path": path,
            "total_found": len(collected),
            "sorted_by": "modification time, newest first",
            "scope": policy.describe(),
            "files": results,
            "truncated": len(collected) > MAX_RESULTS,
        }
        if out["truncated"]:
            out["message"] = (
                f"Showing the {MAX_RESULTS} most recently modified of "
                f"{len(collected)} matches. Narrow the pattern or path to see more."
            )
        return out


def _rel_to_workspace(dirpath, workspace, walk_root) -> str:
    """Workspace-relative POSIX path for a directory the walk is visiting.

    Falls back to walk-root-relative when the two roots cannot be related —
    which happens on Windows when one side is an 8.3 short path
    (C:\\Users\\CHARLE~1.DON\\…) and the other is expanded. Resolving both is
    what stops that mismatch silently pruning everything.
    """
    for base in (workspace, walk_root):
        try:
            rel = os.path.relpath(str(Path(dirpath).resolve()),
                                  str(Path(base).resolve()))
        except (OSError, ValueError):
            continue
        if not rel.startswith(".."):
            rel = rel.replace(os.sep, "/")
            return "" if rel == "." else rel
    return ""


def _find_files(root: Path, pattern: str, policy=None):
    """
    Walk the tree and yield files matching the glob, pruning whatever the
    scan policy says to prune for THIS call.
    """
    policy = policy or scan_policy.build(str(root))
    for dirpath, dirnames, filenames in os.walk(root):
        # Relative to the WORKSPACE, not to the walk root. The policy's
        # targets are workspace-relative, so measuring from the walk root
        # would make them never match whenever `path` narrowed the search —
        # which is exactly the case targeting exists for.
        rel_dir = _rel_to_workspace(dirpath, policy.workspace, root)
        # Pruned by relative PATH, not just name: pruning by name alone cannot
        # tell the directory the caller aimed at from every other one.
        dirnames[:] = [
            d for d in dirnames
            if not policy.skip_dir(d, f"{rel_dir}/{d}" if rel_dir else d)
        ]

        current = Path(dirpath)
        for filename in filenames:
            file_path = current / filename
            # Match against just the filename for simple patterns,
            # or the relative path for ** patterns
            if file_path.match(pattern):
                yield file_path
