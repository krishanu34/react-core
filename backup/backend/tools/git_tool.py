"""
Git Tool — Structured Git Operations

Instead of raw `run_terminal("git ...")`, this provides structured
git operations with safety checks. Prevents destructive commands
by default and returns parsed output.

Operations:
  - status: working tree status (modified, untracked, staged)
  - diff: show changes (staged, unstaged, or between refs)
  - log: commit history (formatted)
  - branch: list/create/switch branches
  - commit: stage and commit changes
  - stash: stash/pop/list
  - blame: annotate file with commit info
"""

import asyncio
import os
from pathlib import Path

from .base_tool import BaseTool
from .run_terminal_tool import _non_interactive_env, _self_exposure_reason


class GitTool(BaseTool):

    name = "git"

    description = (
        "Structured git operations with safety checks. Operations: "
        "'status' (working tree state), 'diff' (show changes), "
        "'log' (commit history), 'branch' (list/create/switch), "
        "'commit' (stage and commit), 'stash' (stash/pop/list), "
        "'blame' (annotate file). Safer than raw terminal commands."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "description": (
                        "Git operation: 'status', 'diff', 'log', 'branch', "
                        "'commit', 'stash', 'blame'"
                    )
                },
                "args": {
                    "type": "string",
                    "description": (
                        "Operation-specific arguments. Examples:\n"
                        "  diff: '--staged', 'HEAD~3', 'main...feature'\n"
                        "  log: '-5', '--oneline', '--since=2024-01-01'\n"
                        "  branch: 'feature/new', '-d old-branch'\n"
                        "  commit: '-m \"fix: resolve bug\"'\n"
                        "  stash: 'push', 'pop', 'list'\n"
                        "  blame: 'path/to/file.py'"
                    )
                },
                "files": {
                    "type": "array",
                    "description": "For 'commit': files to stage before committing",
                    "items": {"type": "string"}
                }
            },
            "required": ["operation"]
        }

    async def run(self, operation, args=None, files=None):
        # Same self-exposure gate as run_terminal: `git log`/`git diff` on the
        # product's own repo would leak agent code/history into the chat.
        reason = _self_exposure_reason(self.workspace)
        if reason:
            return {
                "error": (
                    f"Git blocked: {reason}. No user workspace is bound for "
                    f"this thread — tell the user to open/select a workspace "
                    f"folder first."
                ),
            }

        # Check if we're in a git repo
        if not (Path(self.workspace) / ".git").exists():
            return {"error": "Not a git repository"}

        _SAFE_OPERATIONS = {"status", "diff", "log", "branch", "stash", "blame"}
        _WRITE_OPERATIONS = {"commit"}

        if operation not in _SAFE_OPERATIONS and operation not in _WRITE_OPERATIONS:
            return {"error": f"Unknown operation '{operation}'. Available: {_SAFE_OPERATIONS | _WRITE_OPERATIONS}"}

        # Block dangerous args
        if args:
            _BLOCKED = ["--force", "-f", "--hard", "push", "reset --hard", "clean -fd"]
            for blocked in _BLOCKED:
                if blocked in args:
                    return {"error": f"Blocked for safety: '{blocked}'. Use run_terminal for destructive operations."}

        if operation == "status":
            return await self._run_git("status --short")

        elif operation == "diff":
            cmd = f"diff {args}" if args else "diff"
            return await self._run_git(cmd)

        elif operation == "log":
            default_args = "-10 --oneline --decorate"
            cmd = f"log {args}" if args else f"log {default_args}"
            return await self._run_git(cmd)

        elif operation == "branch":
            if args:
                cmd = f"branch {args}"
            else:
                cmd = "branch -a"
            return await self._run_git(cmd)

        elif operation == "commit":
            results = []
            if files:
                for f in files:
                    r = await self._run_git(f"add {f}")
                    results.append(r)

            commit_args = args or '-m "Update"'
            r = await self._run_git(f"commit {commit_args}")
            results.append(r)
            return {
                "operation": "commit",
                "staged_files": files or [],
                "result": results[-1],
            }

        elif operation == "stash":
            cmd = f"stash {args}" if args else "stash list"
            return await self._run_git(cmd)

        elif operation == "blame":
            if not args:
                return {"error": "Provide a file path for blame"}
            return await self._run_git(f"blame {args}")

    async def _run_git(self, cmd: str) -> dict:
        full_cmd = f"git {cmd}"
        try:
            process = await asyncio.create_subprocess_shell(
                full_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workspace,
                env=_non_interactive_env(),  # server secrets stripped, no prompts
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)

            output = stdout.decode("utf-8", errors="replace").strip()
            errors = stderr.decode("utf-8", errors="replace").strip()

            if len(output) > 10000:
                output = output[:10000] + f"\n[...truncated, {len(output)} chars total]"

            return {
                "command": full_cmd,
                "exit_code": process.returncode,
                "output": output,
                "errors": errors if process.returncode != 0 else "",
            }
        except asyncio.TimeoutError:
            return {"error": f"Git command timed out: {full_cmd}"}
        except Exception as e:
            return {"error": f"Git command failed: {e}"}


class GitUnavailableTool(GitTool):
    """Same name/schema as git, used when the workspace lives on the CLIENT
    machine but no runtime host (daemon) is connected there — running git on
    the server would target the wrong repo (or the product's own). Mirrors
    RunTerminalUnavailableTool."""

    async def run(self, operation, args=None, files=None):
        return {
            "error": "no_runtime_host",
            "operation": operation,
            "instruction": (
                "This workspace lives on the user's machine and no local "
                "runtime host is connected, so git cannot run anywhere. Do "
                "NOT retry. Tell the user: install and start the DevAccel "
                "daemon (Setup Daemon tab) to enable git and command "
                "execution on their machine."
            ),
        }
