"""run_terminal — streamed shell execution inside the workspace.

Design points (Claude Code parity):
  - Streams stdout/stderr as SSE events line-by-line via `on_event`.
  - Kills the whole process tree on timeout (taskkill /T on Windows,
    process group SIGKILL on POSIX) — killing just cmd.exe leaves npm/node
    holding pipes open and the readloop hangs forever.
  - Non-interactive env (npm_config_yes, GIT_TERMINAL_PROMPT=0, etc.) plus
    stdin=DEVNULL so anything that would ask for input EOFs and dies fast.
  - Strips secrets from the child's env before spawning.
  - Detects missing language runtimes up front and returns a structured
    `runtime_missing` result instead of a cryptic "not recognized" stderr.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Awaitable, Callable

from .base import BaseTool
from .runtime_probe import fresh_path, missing_runtime

DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 600
MAX_OUTPUT_SIZE = 10_000

_SECRET_MARKERS = (
    "API_KEY", "APIKEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD",
    "CREDENTIAL", "CONNECTION_STRING", "PRIVATE_KEY",
)

_DANGEROUS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\brm\b.*\s-[^\s]*[rR]", re.I), "recursive file deletion (rm -r)"),
    (re.compile(r"\brd\b.*\s/s", re.I), "recursive directory delete (rd /s)"),
    (re.compile(r"\brmdir\b.*\s/s", re.I), "recursive directory delete (rmdir /s)"),
    (re.compile(r"\bdrop\s+(table|database|schema)\b", re.I), "database drop"),
    (re.compile(r"\btruncate\s+table\b", re.I), "table truncation"),
    (re.compile(r"\bformat\s+\w+:", re.I), "disk format"),
    (re.compile(r"\bmkfs\b", re.I), "filesystem format"),
    (re.compile(r"\bdd\s+if=", re.I), "raw disk write (dd)"),
    (re.compile(r"\b(shutdown|reboot|halt|poweroff)\b", re.I), "system shutdown/reboot"),
]


def _non_interactive_env() -> dict[str, str]:
    env = {
        k: v for k, v in os.environ.items()
        if not any(marker in k.upper() for marker in _SECRET_MARKERS)
    }
    env.update({
        "PATH": fresh_path(),
        "npm_config_yes": "true",
        "GIT_TERMINAL_PROMPT": "0",
        "PIP_NO_INPUT": "1",
        "DEBIAN_FRONTEND": "noninteractive",
    })
    return env


def _dangerous_reason(command: str) -> str | None:
    for pattern, reason in _DANGEROUS:
        if pattern.search(command):
            return reason
    return None


async def _kill_tree(pid: int) -> None:
    try:
        if sys.platform == "win32":
            proc = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
        else:
            import signal
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    except Exception:  # noqa: BLE001
        pass


class RunTerminalTool(BaseTool):
    name = "run_terminal"
    SUPPORTS_STREAMING = True

    @staticmethod
    def build_description(is_windows: bool) -> str:
        return (
            "Execute a shell command inside the workspace. Streams each "
            "output line back as a `terminal_output` event so the user sees "
            "progress in real time. Returns stdout, stderr, exit code. "
            "Default timeout 60s (max 600). NON-INTERACTIVE — there is no "
            "keyboard: pass auto-confirm flags (`npx --yes`, `npm init -y`, "
            "`pip install --no-input`) and all options up front. "
            + (
                "Shell is cmd.exe (Windows): use `mkdir dir` not `mkdir -p`, "
                "chain with `&&`."
                if is_windows else
                "Shell is POSIX sh."
            )
        )

    description = build_description(sys.platform == "win32")

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command to run."},
                "timeout": {
                    "type": "integer",
                    "description": f"Seconds (default {DEFAULT_TIMEOUT}, max {MAX_TIMEOUT}).",
                },
                "force": {
                    "type": "boolean",
                    "description": "Set true after the user has approved a destructive command.",
                },
            },
            "required": ["command"],
        }

    async def run(
        self,
        command: str,
        timeout: int | None = None,
        force: bool = False,
        on_event: Callable[[str, dict], Awaitable[None] | None] | None = None,
    ) -> dict[str, Any]:
        cmd = str(command or "").strip()
        if not cmd:
            return {"error": "command is required", "exit_code": -1}
        timeout_secs = float(min(max(1, int(timeout or DEFAULT_TIMEOUT)), MAX_TIMEOUT))

        if not force:
            reason = _dangerous_reason(cmd)
            if reason:
                return {
                    "status": "permission_required",
                    "command": cmd,
                    "reason": reason,
                    "instruction": (
                        "This command needs user approval. Ask the user first, "
                        "then re-run with force=true if they agree."
                    ),
                }

        missing = missing_runtime(cmd)
        if missing:
            missing["exit_code"] = -1
            return missing

        env = _non_interactive_env()
        run_id = uuid.uuid4().hex[:12]

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                cwd=self.workspace,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except NotImplementedError:
            return await self._run_via_threads(cmd, timeout_secs, on_event, run_id, env)
        except Exception as e:  # noqa: BLE001
            return {
                "error": f"Failed to start command: {type(e).__name__}: {e}",
                "command": cmd,
                "exit_code": -1,
            }

        if on_event:
            await _maybe_await(on_event("terminal_start", {"run_id": run_id, "command": cmd}))

        stdout_buf: list[str] = []
        stderr_buf: list[str] = []
        timed_out = False

        async def _pump(stream: asyncio.StreamReader, label: str, sink: list[str]) -> None:
            while True:
                try:
                    line_bytes = await stream.readline()
                except Exception:  # noqa: BLE001
                    return
                if not line_bytes:
                    return
                text = line_bytes.decode("utf-8", errors="replace")
                sink.append(text)
                if on_event:
                    await _maybe_await(on_event("terminal_output", {
                        "run_id": run_id,
                        "stream": label,
                        "line": text.rstrip("\r\n"),
                    }))

        pumps = [
            asyncio.create_task(_pump(proc.stdout, "stdout", stdout_buf)),
            asyncio.create_task(_pump(proc.stderr, "stderr", stderr_buf)),
        ]

        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_secs)
        except asyncio.TimeoutError:
            timed_out = True
            await _kill_tree(proc.pid)
        finally:
            for t in pumps:
                if not t.done():
                    t.cancel()
            for t in pumps:
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass

        exit_code = proc.returncode if proc.returncode is not None else -1
        stdout = "".join(stdout_buf)
        stderr = "".join(stderr_buf)
        truncated = False
        if len(stdout) > MAX_OUTPUT_SIZE:
            stdout = stdout[:MAX_OUTPUT_SIZE] + "\n... (truncated)"
            truncated = True
        if len(stderr) > MAX_OUTPUT_SIZE:
            stderr = stderr[:MAX_OUTPUT_SIZE] + "\n... (truncated)"
            truncated = True

        if on_event:
            await _maybe_await(on_event("terminal_done", {
                "run_id": run_id, "command": cmd,
                "exit_code": -1 if timed_out else exit_code,
                "timed_out": timed_out,
            }))

        if timed_out:
            return {
                "error": (
                    f"Command timed out after {int(timeout_secs)}s. If it stopped at a "
                    f"prompt, re-run with non-interactive flags (--yes, -y, --no-input) "
                    f"or pass a longer timeout."
                ),
                "stdout": stdout,
                "stderr": stderr,
                "command": cmd,
                "exit_code": -1,
                "timed_out": True,
            }

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "truncated": truncated,
        }

    async def _run_via_threads(
        self,
        command: str,
        timeout_secs: float,
        on_event,
        run_id: str,
        env: dict[str, str],
    ) -> dict[str, Any]:
        """Windows Selector-loop fallback: subprocess.Popen + threaded pumps."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        try:
            proc = subprocess.Popen(  # noqa: S602
                command,
                shell=True,
                cwd=self.workspace,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
        except Exception as e:  # noqa: BLE001
            return {
                "error": f"Failed to start command: {type(e).__name__}: {e}",
                "command": command,
                "exit_code": -1,
            }

        if on_event:
            await _maybe_await(on_event("terminal_start", {"run_id": run_id, "command": command}))

        def _pump(stream, label: str) -> None:
            try:
                for raw in iter(stream.readline, b""):
                    text = raw.decode("utf-8", errors="replace")
                    loop.call_soon_threadsafe(queue.put_nowait, (label, text))
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, (label, None))

        for stream, label in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
            threading.Thread(target=_pump, args=(stream, label), daemon=True).start()

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        eof_count = 0
        timed_out = False
        deadline = time.monotonic() + timeout_secs

        while eof_count < 2:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                label, line = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                timed_out = True
                break
            if line is None:
                eof_count += 1
                continue
            (stdout_lines if label == "stdout" else stderr_lines).append(line)
            if on_event:
                await _maybe_await(on_event("terminal_output", {
                    "run_id": run_id,
                    "stream": label,
                    "line": line.rstrip("\r\n"),
                }))

        if timed_out:
            await _kill_tree(proc.pid)
            if on_event:
                await _maybe_await(on_event("terminal_done", {
                    "run_id": run_id, "command": command,
                    "exit_code": -1, "timed_out": True,
                }))
            return {
                "error": f"Command timed out after {int(timeout_secs)}s.",
                "stdout": "".join(stdout_lines)[:MAX_OUTPUT_SIZE],
                "stderr": "".join(stderr_lines)[:MAX_OUTPUT_SIZE],
                "command": command,
                "exit_code": -1,
                "timed_out": True,
            }

        try:
            exit_code = await asyncio.wait_for(asyncio.to_thread(proc.wait), timeout=10.0)
        except asyncio.TimeoutError:
            exit_code = -1

        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
        truncated = False
        if len(stdout) > MAX_OUTPUT_SIZE:
            stdout = stdout[:MAX_OUTPUT_SIZE] + "\n... (truncated)"
            truncated = True
        if len(stderr) > MAX_OUTPUT_SIZE:
            stderr = stderr[:MAX_OUTPUT_SIZE] + "\n... (truncated)"
            truncated = True

        if on_event:
            await _maybe_await(on_event("terminal_done", {
                "run_id": run_id, "command": command,
                "exit_code": exit_code, "timed_out": False,
            }))

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "truncated": truncated,
        }


async def _maybe_await(result) -> None:
    if hasattr(result, "__await__"):
        await result
