"""grep_search — pure-Python regex search across the workspace.

Zero external binaries. Works identically on Windows, Linux, and macOS.

Design:
  - Walks the workspace, pruned by `permissions/scan_policy` (project's own
    .gitignore + built-in noise list).
  - Skips known-binary extensions and files with NUL bytes.
  - The whole scan runs in a worker thread (`asyncio.to_thread`) so the
    event loop stays responsive while a big repo is searched.

Three output modes match Claude Code's Grep:
  content              — matching lines with optional -C context
  files_with_matches   — just the file paths
  count                — match counts per file
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

from ..permissions import scan_policy
from .base import BaseTool

MAX_PER_FILE = 5
DEFAULT_LIMIT = 50
HARD_LIMIT = 200
MAX_CONTEXT = 10
MAX_FILE_SIZE = 1_000_000
MAX_WALK_FILES = 50_000

_VALID_MODES = ("content", "files_with_matches", "count")

_SKIP_EXTS = {
    ".pyc", ".pyo", ".exe", ".dll", ".so", ".dylib", ".png", ".jpg", ".jpeg",
    ".gif", ".ico", ".webp", ".bmp", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".sqlite", ".db", ".bin",
    ".class", ".map", ".lock", ".mp3", ".mp4", ".wav", ".avi", ".mov",
}


def _looks_binary(head: bytes) -> bool:
    return b"\x00" in head[:8192]


class GrepSearchTool(BaseTool):
    name = "grep_search"
    description = (
        "Search file contents for a regex. Three output modes:\n"
        "  - 'content' (default): matching lines with optional context\n"
        "  - 'files_with_matches': just the file paths\n"
        "  - 'count': match counts per file\n"
        "Pure-Python engine, no external binary required. Respects project "
        "ignore files unless `include_ignored=true`."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Regex to search for."},
                "file_pattern": {
                    "type": "string",
                    "description": "Optional glob to restrict files (e.g. '*.py', 'src/**/*.ts').",
                },
                "output_mode": {
                    "type": "string",
                    "enum": list(_VALID_MODES),
                    "description": "'content' (default), 'files_with_matches', or 'count'.",
                },
                "context": {
                    "type": "integer",
                    "description": f"Lines shown around each match (0-{MAX_CONTEXT}). Default 0.",
                },
                "case_sensitive": {"type": "boolean", "description": "Default true."},
                "multiline": {"type": "boolean", "description": "Match across newlines. Default false."},
                "head_limit": {
                    "type": "integer",
                    "description": f"Max results (default {DEFAULT_LIMIT}, cap {HARD_LIMIT}).",
                },
                "include_ignored": {"type": "boolean", "description": scan_policy.INCLUDE_IGNORED_DESCRIPTION},
            },
            "required": ["query"],
        }

    async def run(
        self,
        query: str,
        file_pattern: str = "",
        output_mode: str = "content",
        context: int = 0,
        case_sensitive: bool = True,
        multiline: bool = False,
        head_limit: int = DEFAULT_LIMIT,
        include_ignored: bool = False,
    ) -> dict[str, Any]:
        if not query:
            return {"error": "grep requires a query."}
        if output_mode not in _VALID_MODES:
            output_mode = "content"
        context = max(0, min(int(context), MAX_CONTEXT))
        head_limit = max(1, min(int(head_limit), HARD_LIMIT))

        return await asyncio.to_thread(
            self._grep,
            query, file_pattern, output_mode, context,
            case_sensitive, multiline, head_limit, include_ignored,
        )

    def _grep(
        self,
        query: str,
        file_pattern: str,
        output_mode: str,
        context: int,
        case_sensitive: bool,
        multiline: bool,
        head_limit: int,
        include_ignored: bool,
    ) -> dict[str, Any]:
        flags = 0
        if not case_sensitive:
            flags |= re.IGNORECASE
        if multiline:
            flags |= re.MULTILINE | re.DOTALL
        try:
            regex = re.compile(query, flags)
        except re.error:
            regex = re.compile(re.escape(query), flags)

        policy = scan_policy.build(
            self.workspace,
            include_ignored=bool(include_ignored),
            file_pattern=file_pattern,
        )

        root = Path(self.workspace).resolve()
        matches: list[dict[str, Any]] = []
        per_file: dict[str, int] = {}
        walked = 0
        stack: list[tuple[Path, str]] = [(root, "")]
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
                    continue
                if not child.is_file():
                    continue
                if child.suffix.lower() in _SKIP_EXTS:
                    continue
                if file_pattern:
                    from .file_search import _matches_glob
                    if not (_matches_glob(child.name, file_pattern) or _matches_glob(child_rel, file_pattern)):
                        walked += 1
                        continue
                try:
                    st = child.stat()
                    if st.st_size > MAX_FILE_SIZE:
                        walked += 1
                        continue
                    with child.open("rb") as f:
                        head = f.read(8192)
                        if _looks_binary(head):
                            walked += 1
                            continue
                        rest = f.read()
                    text = (head + rest).decode("utf-8", errors="replace")
                except OSError:
                    continue
                walked += 1

                if multiline:
                    found = list(regex.finditer(text))
                    count = len(found)
                else:
                    lines = text.splitlines()
                    found_lines = [(i + 1, ln) for i, ln in enumerate(lines) if regex.search(ln)]
                    count = len(found_lines)

                if count == 0:
                    continue
                per_file[child_rel] = count

                if output_mode == "content":
                    if multiline:
                        for m in found[:MAX_PER_FILE]:
                            ln = text.count("\n", 0, m.start()) + 1
                            matches.append({"file": child_rel, "line": ln, "content": m.group(0)[:300]})
                    else:
                        for line_num, line in found_lines[:MAX_PER_FILE]:
                            entry: dict[str, Any] = {
                                "file": child_rel,
                                "line": line_num,
                                "content": line[:300],
                            }
                            if context:
                                lo = max(0, line_num - 1 - context)
                                hi = min(len(lines), line_num + context)
                                entry["snippet"] = "\n".join(
                                    f"{i + 1:5}{':' if i + 1 == line_num else '-'} {lines[i][:200]}"
                                    for i in range(lo, hi)
                                )
                            matches.append(entry)

        return _format_result(query, matches, per_file, output_mode, head_limit)


def _format_result(
    query: str,
    matches: list[dict[str, Any]],
    per_file: dict[str, int],
    output_mode: str,
    head_limit: int,
) -> dict[str, Any]:
    if output_mode == "files_with_matches":
        files = sorted(per_file.keys())[:head_limit]
        return {
            "query": query,
            "output_mode": output_mode,
            "total_files": len(per_file),
            "files": files,
            "truncated": len(per_file) > head_limit,
        }
    if output_mode == "count":
        counts = sorted(per_file.items(), key=lambda kv: (-kv[1], kv[0]))[:head_limit]
        return {
            "query": query,
            "output_mode": output_mode,
            "total_files": len(per_file),
            "total_matches": sum(per_file.values()),
            "counts": [{"file": p, "matches": n} for p, n in counts],
            "truncated": len(per_file) > head_limit,
        }
    matches.sort(key=lambda m: (m.get("file", ""), m.get("line", 0)))
    window = matches[:head_limit]
    return {
        "query": query,
        "output_mode": output_mode,
        "total_matches": len(matches),
        "files_with_matches": len(per_file),
        "matches": window,
        "truncated": len(matches) > head_limit,
    }
