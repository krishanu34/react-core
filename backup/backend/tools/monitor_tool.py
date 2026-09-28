"""
Monitor Tool — Watch Something in the Background

Claude Code's Monitor runs a command in the background and feeds
each output line back to Claude so it can react to log entries,
file changes, or polled status mid-conversation.

Our implementation:
  1. Start a subprocess in the background via asyncio
  2. Capture stdout/stderr line by line
  3. Store captured output in a buffer per monitor
  4. Agent can check the buffer for new output

Operations:
  - start: begin monitoring a command
  - check: read captured output since last check
  - stop: kill the background process
  - list: show all active monitors

Monitors are per-thread and cleaned up when the thread finishes.
"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .base_tool import BaseTool
from utils.logger import get_logger

log = get_logger(__name__)

MAX_BUFFER_LINES = 500
MAX_MONITORS = 5


@dataclass
class MonitorProcess:
    """One background monitored process."""
    monitor_id: str
    command: str
    started_at: float
    process: Optional[asyncio.subprocess.Process] = None
    task: Optional[asyncio.Task] = None
    buffer: List[str] = field(default_factory=list)
    last_read: int = 0
    stopped: bool = False
    exit_code: Optional[int] = None


# Global monitor store, keyed by thread_id
_monitors: Dict[str, Dict[str, MonitorProcess]] = {}


class MonitorTool(BaseTool):

    name = "monitor"

    description = (
        "Run a command in the background and capture its output. Use this "
        "to watch log files, poll status, or track long-running processes. "
        "Operations: 'start' (begin monitoring), 'check' (read new output), "
        "'stop' (kill the process), 'list' (show active monitors)."
    )

    def __init__(self, workspace: str, thread_id: str = "default"):
        super().__init__(workspace)
        self._thread_id = thread_id

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "description": (
                        "Operation: 'start' (begin monitoring a command), "
                        "'check' (read new output from a monitor), "
                        "'stop' (kill a monitored process), "
                        "'list' (show all active monitors)"
                    )
                },
                "command": {
                    "type": "string",
                    "description": (
                        "For 'start': the command to run. "
                        "Examples: 'tail -f app.log', 'watch -n5 curl status', "
                        "'npm run dev'"
                    )
                },
                "monitor_id": {
                    "type": "string",
                    "description": (
                        "For 'check' and 'stop': the monitor ID "
                        "(returned by 'start')"
                    )
                }
            },
            "required": ["operation"]
        }

    def _get_monitors(self) -> Dict[str, MonitorProcess]:
        if self._thread_id not in _monitors:
            _monitors[self._thread_id] = {}
        return _monitors[self._thread_id]

    async def run(self, operation, command=None, monitor_id=None):
        monitors = self._get_monitors()

        if operation == "start":
            return await self._start(monitors, command)
        elif operation == "check":
            return self._check(monitors, monitor_id)
        elif operation == "stop":
            return await self._stop(monitors, monitor_id)
        elif operation == "list":
            return self._list(monitors)

        return {"error": f"Unknown operation '{operation}'. Use: start, check, stop, list"}

    async def _start(self, monitors, command):
        if not command:
            return {"error": "Provide a 'command' to monitor"}

        if len(monitors) >= MAX_MONITORS:
            return {"error": f"Max {MAX_MONITORS} monitors per thread. Stop one first."}

        import hashlib
        mid = hashlib.md5(f"{command}{time.time()}".encode()).hexdigest()[:8]

        monitor = MonitorProcess(
            monitor_id=mid,
            command=command,
            started_at=time.time(),
        )

        try:
            import sys
            import shutil

            shell_cmd = command
            if sys.platform == "win32":
                shell_exe = shutil.which("bash") or shutil.which("cmd")
                if shell_exe and "bash" in shell_exe:
                    process = await asyncio.create_subprocess_shell(
                        shell_cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        cwd=self.workspace,
                    )
                else:
                    process = await asyncio.create_subprocess_shell(
                        shell_cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        cwd=self.workspace,
                    )
            else:
                process = await asyncio.create_subprocess_shell(
                    shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=self.workspace,
                )

            monitor.process = process

            async def _reader():
                try:
                    while True:
                        line = await process.stdout.readline()
                        if not line:
                            break
                        decoded = line.decode("utf-8", errors="replace").rstrip()
                        monitor.buffer.append(decoded)
                        if len(monitor.buffer) > MAX_BUFFER_LINES:
                            monitor.buffer = monitor.buffer[-MAX_BUFFER_LINES:]
                except Exception:
                    pass
                finally:
                    monitor.stopped = True
                    monitor.exit_code = process.returncode

            monitor.task = asyncio.create_task(_reader())
            monitors[mid] = monitor

            log.info(f"Monitor started: id={mid}, cmd={command}")

            return {
                "operation": "started",
                "monitor_id": mid,
                "command": command,
                "message": f"Monitor '{mid}' started. Use check(monitor_id='{mid}') to read output.",
            }

        except Exception as e:
            return {"error": f"Failed to start monitor: {type(e).__name__}: {e}"}

    def _check(self, monitors, monitor_id):
        if not monitor_id:
            return {"error": "Provide 'monitor_id' to check"}
        if monitor_id not in monitors:
            return {"error": f"Monitor '{monitor_id}' not found"}

        monitor = monitors[monitor_id]
        new_lines = monitor.buffer[monitor.last_read:]
        monitor.last_read = len(monitor.buffer)

        result = {
            "monitor_id": monitor_id,
            "command": monitor.command,
            "running": not monitor.stopped,
            "new_lines": len(new_lines),
            "total_lines": len(monitor.buffer),
            "output": "\n".join(new_lines) if new_lines else "(no new output)",
        }

        if monitor.stopped:
            result["exit_code"] = monitor.exit_code

        return result

    async def _stop(self, monitors, monitor_id):
        if not monitor_id:
            return {"error": "Provide 'monitor_id' to stop"}
        if monitor_id not in monitors:
            return {"error": f"Monitor '{monitor_id}' not found"}

        monitor = monitors[monitor_id]
        if monitor.process and not monitor.stopped:
            try:
                monitor.process.terminate()
                await asyncio.wait_for(monitor.process.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    monitor.process.kill()
                except ProcessLookupError:
                    pass

        monitor.stopped = True
        del monitors[monitor_id]

        return {
            "operation": "stopped",
            "monitor_id": monitor_id,
            "command": monitor.command,
            "total_lines_captured": len(monitor.buffer),
        }

    def _list(self, monitors):
        if not monitors:
            return {"monitors": [], "message": "No active monitors"}

        info = []
        for mid, mon in monitors.items():
            elapsed = round(time.time() - mon.started_at)
            info.append({
                "monitor_id": mid,
                "command": mon.command,
                "running": not mon.stopped,
                "elapsed_seconds": elapsed,
                "buffer_lines": len(mon.buffer),
            })

        return {"monitors": info, "total": len(info)}
