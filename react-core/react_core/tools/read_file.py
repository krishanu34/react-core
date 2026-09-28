"""read_file — return a text file, line-numbered, with offset/limit windowing."""
from __future__ import annotations

from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool

MAX_FILE_SIZE = 500_000
DEFAULT_LINE_LIMIT = 2000

_BINARY_EXTENSIONS = {
    ".pyc", ".pyo", ".exe", ".dll", ".so", ".dylib", ".zip", ".tar", ".gz",
    ".7z", ".rar", ".woff", ".woff2", ".ttf", ".eot", ".png", ".jpg",
    ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".pdf", ".sqlite", ".db",
    ".bin", ".class", ".mp3", ".mp4", ".wav", ".avi", ".mov",
}


def _looks_binary(head: bytes) -> bool:
    return b"\x00" in head


class ReadFileTool(BaseTool):
    name = "read_file"
    description = (
        "Read the contents of a text file. Returns lines with 1-based line "
        "numbers. Use `offset` and `limit` to page through large files. "
        "Refuses binary formats and files larger than 500KB (window them "
        "instead). Path must be relative to the workspace root."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative path, e.g. 'src/main.py'.",
                },
                "offset": {
                    "type": "integer",
                    "description": "1-based line to start at. Default: 1.",
                },
                "limit": {
                    "type": "integer",
                    "description": f"Max lines to return. Default: {DEFAULT_LINE_LIMIT}.",
                },
            },
            "required": ["path"],
        }

    async def run(self, path: str, offset: int = 1, limit: int = DEFAULT_LINE_LIMIT) -> dict[str, Any]:
        try:
            abs_path = resolve_in_root(self.workspace, path)
        except PathEscape as e:
            return {"error": str(e)}

        if not abs_path.exists():
            return {"error": f"File not found: {path}"}
        if not abs_path.is_file():
            return {"error": f"Not a file: {path}"}

        if abs_path.suffix.lower() in _BINARY_EXTENSIONS:
            return {
                "error": (
                    f"Refusing to read binary file '{path}'. Use a tool that "
                    f"understands this format (or read raw bytes only if you "
                    f"know what you're doing)."
                ),
            }

        size = abs_path.stat().st_size
        try:
            with abs_path.open("rb") as f:
                head = f.read(4096)
        except OSError as e:
            return {"error": f"Could not read '{path}': {e}"}
        if _looks_binary(head):
            return {"error": f"Refusing to read binary file '{path}' (contains NUL bytes)."}

        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return {"error": f"Could not read '{path}': {e}"}

        lines = text.splitlines()
        total_lines = len(lines)
        start = max(1, int(offset)) - 1
        stop = min(total_lines, start + max(1, int(limit)))
        window = lines[start:stop]

        rendered = "\n".join(f"{i + 1:6}\u2502 {ln}" for i, ln in enumerate(window, start=start))
        result: dict[str, Any] = {
            "path": path,
            "size_bytes": size,
            "total_lines": total_lines,
            "start_line": start + 1,
            "end_line": stop,
            "content": rendered,
        }
        if size > MAX_FILE_SIZE and stop < total_lines:
            result["truncated"] = True
            result["hint"] = (
                f"File has {total_lines} lines; showing {start + 1}-{stop}. "
                f"Call again with offset={stop + 1} to read more."
            )
        return result
