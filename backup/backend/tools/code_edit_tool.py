"""
Code Edit Tool

Find-and-replace exact code blocks in existing files. Designed for
small, targeted modifications (not full file rewrites). Includes:
  - Validates the old_code actually exists in the file
  - Shows context around the edit so the agent can verify
  - Handles the case where old_code appears multiple times
  - Better error messages than "old code not found"
"""

import difflib
from pathlib import Path

from .base_tool import BaseTool
from .file_locks import file_lock
from .write_verify import verify_written
from context.permissions import check_path_permission
from context.read_tracker import mark_read


class CodeEditTool(BaseTool):

    name = "code_edit"
    SUPPORTS_STREAMING = True  # emits file_diff once the write is verified

    description = (
        "Replace an exact block of code with new code in an existing file. "
        "The old_code must match EXACTLY (including whitespace/indentation). "
        "Use read_file first to see the exact content, then use this tool "
        "to make targeted changes. For creating new files or full rewrites, "
        "use file_write instead."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "File path relative to project root. "
                        "The file must already exist."
                    )
                },
                "old_code": {
                    "type": "string",
                    "description": (
                        "The exact code block to find and replace. "
                        "Must match the file content EXACTLY, including "
                        "whitespace and indentation. Copy it from read_file output."
                    )
                },
                "new_code": {
                    "type": "string",
                    "description": "The code to replace old_code with."
                }
            },
            "required": ["path", "old_code", "new_code"]
        }

    async def run(self, path, old_code, new_code, on_event=None):
        file_path = Path(self._resolve_path(path))

        # Path-level permission check (deny_paths / allow_paths from PERMISSION_MODE config)
        perm = check_path_permission(path, workspace=self.workspace, write=True)
        if not perm.allowed:
            return {"error": f"Permission denied: {perm.reason}"}

        # Serialise same-file work. The agent runs a turn's tool calls
        # concurrently, and read → replace → write is not atomic: two edits to
        # THIS file would both read the original and the second write would
        # drop the first, with both reporting success. Holding the lock makes
        # the second edit see the first one's bytes. Different files are
        # unaffected and stay parallel. See tools/file_locks.py.
        async with file_lock(str(file_path)):
            return await self._edit_locked(file_path, path, old_code, new_code, on_event)

    async def _edit_locked(self, file_path, path, old_code, new_code, on_event):
        """The read → verify → write sequence. Caller holds this path's lock."""
        # Validate file exists
        if not file_path.exists():
            return {"error": f"File not found: {path}. Use file_write to create new files."}
        if file_path.is_dir():
            return {"error": f"'{path}' is a directory, not a file."}

        # Read current content
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as e:
            return {"error": f"Could not read file: {str(e)}"}

        # Read-before-overwrite (Claude Code parity): code_edit reads the file
        # itself to locate old_code, so it's as safe as read_file — mark it
        # seen so a later file_write on this path isn't blocked.
        mark_read(self.thread_id, path)

        # Check that old_code exists in the file
        if old_code not in content:
            # Help the agent debug: show what's close
            return _build_not_found_error(path, old_code, content)

        # Check for multiple occurrences
        occurrence_count = content.count(old_code)
        if occurrence_count > 1:
            return {
                "error": (
                    f"old_code appears {occurrence_count} times in {path}. "
                    f"Provide a larger, more unique code block that only "
                    f"matches once. Include surrounding lines for uniqueness."
                ),
                "occurrences": occurrence_count,
            }

        # Perform the replacement (exactly one occurrence)
        new_content = content.replace(old_code, new_code, 1)

        # Write back, then prove it landed. See tools/write_verify.py.
        try:
            file_path.write_text(new_content, encoding="utf-8")
        except Exception as e:
            return {"error": f"Could not write file: {str(e)}"}

        problem = verify_written(file_path, path, new_content)
        if problem:
            return {"error": problem}

        # ONLY NOW is the edit real, so only now may the diff be announced.
        #
        # `file_diff` is not a preview — it is the client's signal that a write
        # reached the disk: ChatDock renders the diff card AND kicks off an
        # Explorer rescan on it. Emitting it before the write (as this did)
        # meant every failure above — an unwritable file, a stale mount, a
        # verification mismatch — still painted the change in the chat while the
        # file on disk was untouched, and the user was told the edit had been
        # made. The client-delegated path already had this ordering right
        # (tools/client_delegating_tool.py emits file_diff only from a result
        # the client verified); the server path now matches it.
        if on_event:
            old_lines = old_code.splitlines(keepends=True)
            new_lines = new_code.splitlines(keepends=True)
            diff = "".join(difflib.unified_diff(
                old_lines, new_lines,
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
            ))
            if diff:
                await on_event("file_diff", {"path": path, "diff": diff})

        # Find the line number where the edit happened
        lines_before_edit = content[:content.index(old_code)].count("\n") + 1

        return {
            "status": "updated",
            "path": path,
            "edit_start_line": lines_before_edit,
            "old_lines": old_code.count("\n") + 1,
            "new_lines": new_code.count("\n") + 1,
        }


def _build_not_found_error(path: str, old_code: str, content: str) -> dict:
    """
    Build a helpful error message when old_code isn't found. Checks
    for common issues: wrong whitespace, close matches, etc.
    """
    # Check if it's a whitespace issue (match ignoring leading/trailing)
    stripped_old = old_code.strip()
    if stripped_old in content:
        return {
            "error": (
                f"old_code not found in {path} (exact match required). "
                f"However, a match was found when ignoring leading/trailing "
                f"whitespace. Make sure your old_code preserves the exact "
                f"indentation from the file. Use read_file to see the "
                f"exact content with line numbers."
            ),
            "hint": "whitespace_mismatch",
        }

    # Check if first line matches (helps identify the right area)
    first_line = old_code.split("\n")[0].strip()
    if first_line and first_line in content:
        # Find which line it's on
        for i, line in enumerate(content.split("\n"), 1):
            if first_line in line:
                return {
                    "error": (
                        f"old_code not found as a complete block in {path}. "
                        f"The first line was found at line {i}, but the full "
                        f"block doesn't match. Use read_file with offset={max(1, i-2)} "
                        f"to see the exact content around that area."
                    ),
                    "hint": "partial_match",
                    "first_line_at": i,
                }

    return {
        "error": (
            f"old_code not found in {path}. The text you provided "
            f"doesn't exist in this file. Use read_file to see the "
            f"actual content before attempting an edit."
        ),
        "hint": "no_match",
    }
