"""
Write File Tool

Creates or overwrites files in the project directory. Includes:
  - Automatic parent directory creation
  - Path safety (no writing outside project root)
  - Reports whether file was created or overwritten
"""

import os
from pathlib import Path

from .base_tool import BaseTool
from .file_locks import file_lock
from .write_verify import verify_written
from context.permissions import check_path_permission
from context.read_tracker import mark_read, has_been_read


class WriteFileTool(BaseTool):

    name = "file_write"

    description = (
        "Create a new file or overwrite an existing file. "
        "Creates parent directories automatically. "
        "Use this when you need to create new files or completely "
        "rewrite existing ones. For small targeted changes to "
        "existing files, use code_edit instead."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "File path relative to project root. "
                        "Parent directories are created automatically. "
                        "Examples: 'config.json', 'src/utils/helpers.py'"
                    )
                },
                "content": {
                    "type": "string",
                    "description": "The full content to write to the file."
                }
            },
            "required": ["path", "content"]
        }

    async def run(self, path, content=None):
        file_path = Path(self._resolve_path(path))
        project_root = Path(self.workspace).resolve()

        # `content` is a required schema field. A None here means the model's
        # tool call arrived without it (dropped/truncated arguments) — writing
        # "" would silently blank the file and report success. Surface it.
        if content is None:
            return {
                "error": (
                    f"file_write for '{path}' received no 'content'. The tool "
                    f"arguments were incomplete — re-issue the call with the full "
                    f"file content. To create an empty file, pass content=\"\"."
                )
            }

        # Serialise same-file work — the guards below (does it exist? is it
        # non-empty? has it been read?) all inspect the file and THEN write,
        # so a concurrent code_edit/file_write on this path in the same tool
        # batch could change it in between and have its change overwritten.
        # Different files stay parallel. See tools/file_locks.py.
        async with file_lock(str(file_path)):
            return await self._write_locked(file_path, project_root, path, content)

    async def _write_locked(self, file_path, project_root, path, content):
        """The inspect → write sequence. Caller holds this path's lock."""
        # Read-before-overwrite (Claude Code parity): refuse to overwrite an
        # EXISTING file the agent hasn't read this thread. Claude Code enforces
        # exactly this — "File has not been read yet — read it first" — because
        # the model must have SEEN the current bytes before it can replace them.
        # This is the general form of the empty-content guard below: it also
        # catches a non-empty but stale/wrong rewrite, not just a blank one.
        # New files (nothing exists yet) are always allowed without a prior read.
        file_exists = file_path.exists() and file_path.is_file()
        if file_exists and not has_been_read(self.thread_id, path):
            return {
                "error": (
                    f"File '{path}' has not been read yet in this session. "
                    f"Read it first with read_file, then file_write — this "
                    f"prevents blindly overwriting content the agent hasn't "
                    f"actually seen."
                )
            }

        # Never silently blank an existing NON-EMPTY file (the "edit emptied my
        # file" failure). Overwriting real code with "" must be an explicit,
        # visible action — creating a new/empty file with "" stays allowed.
        if content == "" and file_exists:
            try:
                current = file_path.read_text(encoding="utf-8")
            except Exception:
                current = ""
            if current.strip():
                return {
                    "error": (
                        f"Refusing to overwrite '{path}' with empty content — it "
                        f"currently has {len(current)} characters. Provide the full "
                        f"new content, or use code_edit for a targeted change."
                    )
                }

        # Safety: ensure the resolved path is inside the project root
        try:
            file_path.resolve().relative_to(project_root)
        except ValueError:
            return {"error": f"Path '{path}' resolves outside the project directory. Blocked for safety."}

        # Path-level permission check (deny_paths / allow_paths from PERMISSION_MODE config)
        perm = check_path_permission(path, workspace=self.workspace, write=True)
        if not perm.allowed:
            return {"error": f"Permission denied: {perm.reason}"}

        # Check if file already exists (for reporting)
        existed = file_path.exists()

        # Create parent directories
        file_path.parent.mkdir(parents=True, exist_ok=True)

        # Write the file, then prove it landed. See tools/write_verify.py — the
        # client executor has always verified its writes; reporting "created" on
        # a write that silently didn't take is how an agent ends up reasoning
        # against a file state that never existed.
        try:
            file_path.write_text(content, encoding="utf-8")
        except Exception as e:
            return {"error": f"Failed to write file: {str(e)}"}

        problem = verify_written(file_path, path, content)
        if problem:
            return {"error": problem}

        # The agent now knows this file's true (just-written) content.
        mark_read(self.thread_id, path)

        return {
            "status": "updated" if existed else "created",
            "path": path,
            "size": len(content.encode("utf-8")),
            "lines": content.count("\n") + 1,
        }
