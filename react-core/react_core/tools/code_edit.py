"""code_edit — exact-string replacement inside a file.

`old_string` must appear exactly once in the file. This gives the LLM a
precise, reviewable edit primitive without needing to regenerate the whole
file (which `write_file` does for a full overwrite).
"""
from __future__ import annotations

import difflib
from typing import Any

from ..permissions.path_guard import PathEscape, resolve_in_root
from .base import BaseTool


class CodeEditTool(BaseTool):
    name = "code_edit"
    description = (
        "Replace `old_string` with `new_string` inside an existing file. "
        "`old_string` must match ONE unique passage of the file exactly, "
        "including indentation and newlines. Include 3-5 lines of context "
        "on each side to make the match unique. Returns a unified diff of "
        "the change."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Workspace-relative path."},
                "old_string": {
                    "type": "string",
                    "description": "The exact passage to replace. Must appear once.",
                },
                "new_string": {
                    "type": "string",
                    "description": "The replacement passage.",
                },
            },
            "required": ["path", "old_string", "new_string"],
        }

    async def run(self, path: str, old_string: str, new_string: str) -> dict[str, Any]:
        try:
            abs_path = resolve_in_root(self.workspace, path)
        except PathEscape as e:
            return {"error": str(e)}
        if not abs_path.is_file():
            return {"error": f"File not found: {path}"}

        try:
            original = abs_path.read_text(encoding="utf-8")
        except OSError as e:
            return {"error": f"Could not read '{path}': {e}"}

        if old_string == new_string:
            return {"error": "old_string and new_string are identical — no edit to make."}

        occurrences = original.count(old_string)
        if occurrences == 0:
            return {
                "error": (
                    "old_string not found in file. Read the file with read_file "
                    "and copy the exact text (including whitespace)."
                ),
            }
        if occurrences > 1:
            return {
                "error": (
                    f"old_string appears {occurrences} times — include more "
                    f"surrounding context so the match is unique."
                ),
            }

        edited = original.replace(old_string, new_string, 1)
        try:
            abs_path.write_text(edited, encoding="utf-8")
        except OSError as e:
            return {"error": f"Could not write '{path}': {e}"}

        diff = "".join(difflib.unified_diff(
            original.splitlines(keepends=True),
            edited.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        ))
        return {
            "path": path,
            "replacements": 1,
            "diff": diff,
        }
