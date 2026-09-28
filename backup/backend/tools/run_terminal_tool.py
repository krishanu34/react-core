"""
Run Terminal Tool  —  Claude Code streaming approach

HOW THIS DIFFERS FROM A BASIC TERMINAL TOOL:
─────────────────────────────────────────────
Basic approach:
  run command → wait → return all stdout at once → LLM reads it

Claude Code approach (this file):
  run command → stream each output line as an SSE event in real time
              → user SEES progress live (npm install, builds, tests …)
              → no arbitrary kill timeout — user presses Stop if needed
              → LLM still gets the full output at the end

WHY THIS MATTERS:
  "npm install" takes 60-90 s on a cold cache.  With the basic approach
  the user stares at a spinner for 90 s then sees all output at once.
  With streaming they see each package as it downloads — they know it's
  working and can judge whether to wait or cancel.

ON-EVENT CALLBACK:
  When the agent passes `on_event`, this tool emits:
    terminal_start  {"run_id": "...", "command": "..."}
    terminal_output {"run_id": "...", "stream": "stdout"|"stderr", "line": "..."}
    terminal_done   {"run_id": "...", "exit_code": 0, "timed_out": False}

  The SSE events are forwarded to the client by the agent loop, identical
  to how Claude Code streams bash output in real time.

  run_id ties every line to ITS terminal block. The agent runs a turn's tool
  calls concurrently, so two run_terminal calls can be streaming at once and
  their events arrive interleaved on one SSE channel. Without the id a client
  can only guess ("the most recent unfinished terminal"), which sends both
  commands' output into one block and stamps the wrong exit code.

TIMEOUT:
  Default: 60 s (covers most quick commands).
  LLM can request up to 300 s for slow operations (npm install, builds).
  The orchestrator's global 600 s budget is the outer safety net.
  User /stop cancels the run at any time — that is the primary kill path.

PROCESS TREE KILL:
  Windows → taskkill /F /T kills cmd.exe + every child (npm, node, …)
  Unix    → os.killpg SIGKILL kills the whole process group
  Without this, killing cmd.exe leaves npm/node holding pipe handles open
  and the read() loop hangs (the original 63-minute bug).
"""

import asyncio
import logging
import os
import re
import sys
import uuid
from pathlib import Path

from .base_tool import BaseTool

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60    # seconds — sensible default for quick commands
MAX_TIMEOUT     = 600   # matches the orchestrator's own budget; user /stop is the real kill
MAX_OUTPUT_SIZE = 10_000  # chars per stream — truncate runaway output

# Env var NAME fragments that mark a server secret. Subprocesses get an
# environment WITHOUT these — a shell command composed by the LLM must never
# be able to `echo $AZURE_OPENAI_API_KEY` (or exfiltrate it via curl).
_SECRET_ENV_MARKERS = (
    "API_KEY", "APIKEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD",
    "CREDENTIAL", "CONNECTION_STRING", "PRIVATE_KEY",
)

# Commands that could cause irreversible data loss — require user approval first.
# Keyed by compiled regex → human-readable reason shown to the user.
_DANGEROUS: list[tuple[re.Pattern, str]] = [
    (re.compile(r'\brm\b.*\s-[^\s]*[rR]',         re.I), "recursive file deletion (rm -r*)"),
    (re.compile(r'\brd\b.*\s/s',                   re.I), "recursive directory delete (rd /s)"),
    (re.compile(r'\brmdir\b.*\s/s',                re.I), "recursive directory delete (rmdir /s)"),
    (re.compile(r'\bdrop\s+(table|database|schema)\b', re.I), "database drop"),
    (re.compile(r'\btruncate\s+table\b',           re.I), "table truncation"),
    (re.compile(r'\bformat\s+\w+:',                re.I), "disk format (Windows)"),
    (re.compile(r'\bmkfs\b',                       re.I), "filesystem format (mkfs)"),
    (re.compile(r'\bdd\s+if=',                     re.I), "raw disk write (dd)"),
    (re.compile(r'\b(shutdown|reboot|halt|poweroff)\b', re.I), "system shutdown / reboot"),
    (re.compile(r'>\s*/dev/(sd|hd|nvme)',          re.I), "direct disk write"),
]


def _dangerous_reason(command: str) -> str | None:
    """Return a short reason string if the command looks destructive, else None."""
    for pattern, reason in _DANGEROUS:
        if pattern.search(command):
            return reason
    return None


def _non_interactive_env() -> dict:
    """
    Environment for headless command execution.

    There is no keyboard behind this terminal — any command that stops to
    ask a question hangs until the timeout kills it (the npx "Ok to
    proceed? (y)" freeze). These variables make the common offenders
    auto-confirm or fail fast instead of prompting:
      npm_config_yes      → npx auto-installs packages without asking
      GIT_TERMINAL_PROMPT → git errors immediately instead of asking for creds
      PIP_NO_INPUT        → pip never prompts
      DEBIAN_FRONTEND     → apt-style installers never prompt
    stdin is also set to DEVNULL at spawn, so anything not covered here
    reads EOF and exits quickly rather than blocking forever.
    """
    env = {
        k: v for k, v in os.environ.items()
        # Server secrets (Azure keys, DB passwords, JWT secrets, …) never
        # reach a subprocess the LLM composed. PATH/HOME/etc. pass through.
        if not any(marker in k.upper() for marker in _SECRET_ENV_MARKERS)
    }
    env.update({
        "npm_config_yes": "true",
        "GIT_TERMINAL_PROMPT": "0",
        "PIP_NO_INPUT": "1",
        "DEBIAN_FRONTEND": "noninteractive",
    })
    return env


def _self_exposure_reason(workspace: str) -> str | None:
    """Refuse to execute when the workspace can SEE DevSphere's own source —
    that's how a fallback-to-server-default workspace ends up building the
    product's own repo and leaking agent code into the chat. Legit workspaces
    (.devaccel/<thread>/workspace, real user folders) don't contain the
    backend package. DEVSPHERE_ALLOW_SELF_EXEC=1 overrides for development
    on this repo itself."""
    if os.getenv("DEVSPHERE_ALLOW_SELF_EXEC") == "1":
        return None
    try:
        backend_root = Path(__file__).resolve().parents[1]  # the devsphere_ai package
        ws = Path(workspace).resolve()
        if ws == backend_root or backend_root.is_relative_to(ws):
            return (
                f"the working directory '{ws}' contains the DevSphere backend's "
                f"own source code"
            )
    except (OSError, ValueError):
        pass
    return None


_TIMEOUT_HINT = (
    "If the output ends at a question or `(y/n)` prompt, the command was "
    "waiting for interactive input this terminal cannot provide — re-run it "
    "with non-interactive flags (`npx --yes`, `-y`, `--no-input`) and pass "
    "ALL options up front instead of relying on prompts. Otherwise use a "
    "higher timeout or break the command into smaller steps."
)


async def _kill_tree(pid: int) -> None:
    """Kill a process and all its children."""
    try:
        if sys.platform == "win32":
            kill = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(kill.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
        else:
            import os
            import signal
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    except Exception:
        pass


class RunTerminalTool(BaseTool):

    name = "run_terminal"
    SUPPORTS_STREAMING = True  # tells the agent to pass on_event into run()

    @staticmethod
    def build_description(is_windows: bool) -> str:
        """The tool description for the OS the command will EXECUTE on.

        By default that is this server's OS (sys.platform below). When the
        tool is client-delegated (Pattern C + daemon), the command runs on
        the USER's machine, which may be a different OS — the registry
        rebuilds the description from the client-reported OS so the LLM
        composes cmd.exe vs POSIX-sh commands for the right shell.
        """
        return (
            "Execute a shell command in the project directory. "
            "Streams output line-by-line so the user sees progress in real time. "
            "Returns stdout, stderr, and exit code when done. "
            "Default timeout: 60 s. For slow commands (npm install, builds) pass "
            "timeout=120 or timeout=300. "
            "Use for: running tests, installing packages, scaffolding, building, "
            "git operations, linting, etc. "
            "NON-INTERACTIVE: there is no keyboard — a command that stops to ask "
            "a question hangs until killed. Always pass auto-confirm flags and "
            "ALL options up front, e.g. `npx --yes create-next-app@latest frontend "
            "--ts --eslint --tailwind --app --src-dir --import-alias \"@/*\" "
            "--use-npm`, `npm init -y`, `pip install --no-input`. "
            + (
                "SHELL IS cmd.exe (Windows): no POSIX flags — use `mkdir dir` not "
                "`mkdir -p dir`, `&&` to chain, backslash or plain names for paths."
                if is_windows else
                "Shell is POSIX sh."
            )
        )

    description = build_description(sys.platform == "win32")

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": (
                        "Shell command to execute in the project directory. "
                        "Examples: 'npm install', 'python -m pytest', "
                        "'git status', 'npx create-next-app my-app --typescript'"
                    ),
                },
                "timeout": {
                    "type": "integer",
                    "description": (
                        "Timeout in seconds. Default: 60. "
                        "Use 120-300 for package installs or full builds."
                    ),
                },
                "force": {
                    "type": "boolean",
                    "description": (
                        "Set to true ONLY after the user has explicitly approved a "
                        "destructive command (rm -rf, DROP TABLE, etc.). "
                        "Never set force=true without asking the user first."
                    ),
                },
            },
            "required": ["command"],
        }

    async def _run_via_threads(self, command: str, timeout_secs: float, on_event=None,
                               run_id: str = "", env: dict = None) -> dict:
        """
        Fallback executor for event loops that can't spawn subprocesses
        (SelectorEventLoop — uvicorn's default policy on Windows).

        subprocess.Popen runs the command; two daemon threads pump stdout/
        stderr lines into an asyncio queue via call_soon_threadsafe, so the
        client still gets live terminal_output events and the return shape is
        identical to the native async path.
        """
        import subprocess
        import threading
        import time as _time

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        try:
            proc = subprocess.Popen(
                command,
                shell=True,
                cwd=self.workspace,
                stdin=subprocess.DEVNULL,   # no keyboard — prompts get EOF, not a hang
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                # Already carries the project venv when the caller resolved one.
                env=env if env is not None else _non_interactive_env(),
            )
        except Exception as e:
            return {
                "error": f"Failed to start command: {type(e).__name__}: {e}",
                "command": command,
                "exit_code": -1,
            }

        if on_event:
            await on_event("terminal_start", {"run_id": run_id, "command": command})

        def _pump(stream, label: str):
            try:
                for raw in iter(stream.readline, b""):
                    text = raw.decode("utf-8", errors="replace")
                    loop.call_soon_threadsafe(queue.put_nowait, (label, text))
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, (label, None))  # EOF

        for stream, label in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
            threading.Thread(target=_pump, args=(stream, label), daemon=True).start()

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        eof_count = 0
        timed_out = False
        deadline = _time.monotonic() + timeout_secs

        while eof_count < 2:
            remaining = deadline - _time.monotonic()
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
                await on_event("terminal_output", {
                    "run_id": run_id,
                    "stream": label,
                    "line": line.rstrip("\r\n"),
                })

        if timed_out:
            await _kill_tree(proc.pid)
            if on_event:
                await on_event("terminal_done", {
                    "run_id": run_id, "command": command,
                    "exit_code": -1, "timed_out": True,
                })
            return {
                "error": (
                    f"Command timed out after {int(timeout_secs)}s. {_TIMEOUT_HINT}"
                ),
                "stdout": "".join(stdout_lines)[:MAX_OUTPUT_SIZE],
                "stderr": "".join(stderr_lines)[:MAX_OUTPUT_SIZE],
                "command": command,
                "exit_code": -1,
            }

        try:
            exit_code = await asyncio.wait_for(asyncio.to_thread(proc.wait), timeout=10.0)
        except asyncio.TimeoutError:
            exit_code = -1

        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
        stdout_truncated = stderr_truncated = False
        if len(stdout) > MAX_OUTPUT_SIZE:
            stdout = stdout[:MAX_OUTPUT_SIZE] + f"\n... (truncated — {len(stdout_lines)} lines total)"
            stdout_truncated = True
        if len(stderr) > MAX_OUTPUT_SIZE:
            stderr = stderr[:MAX_OUTPUT_SIZE] + f"\n... (truncated — {len(stderr_lines)} lines total)"
            stderr_truncated = True

        if on_event:
            await on_event("terminal_done", {
                "run_id": run_id, "command": command,
                "exit_code": exit_code, "timed_out": False,
            })

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "truncated": stdout_truncated or stderr_truncated,
        }

    async def run(self, command: str, timeout: int = None, on_event=None, force: bool = False) -> dict:
        """
        Execute command and stream each output line as an SSE event.

        on_event: optional async callback (event_type, data) → None
                  When provided, lines are pushed to the client in real time.
                  The full stdout/stderr is still returned at the end so the
                  LLM can reason about the output.
        """
        timeout_secs = float(min(int(timeout or DEFAULT_TIMEOUT), MAX_TIMEOUT))

        # Identifies THIS command's stream. Two run_terminal calls in one
        # concurrent tool batch interleave their events on the single SSE
        # channel; the client uses this to route each line to the right
        # terminal block instead of guessing. See the module docstring.
        run_id = uuid.uuid4().hex[:12]

        # ── Self-exposure gate — never execute inside the product's own code ─
        reason = _self_exposure_reason(self.workspace)
        if reason:
            return {
                "error": (
                    f"Command blocked: {reason}. This usually means no user "
                    f"workspace was bound for this thread (server-default "
                    f"fallback). Do NOT retry. Tell the user to open/select a "
                    f"workspace folder first, or connect the DevAccel daemon "
                    f"so commands run on their machine."
                ),
                "command": command,
                "exit_code": -1,
            }

        # ── Permission gate — block destructive commands until approved ───
        if not force:
            reason = _dangerous_reason(command)
            if reason:
                return {
                    "status": "permission_required",
                    "command": command,
                    "reason": reason,
                    "instruction": (
                        "This command requires user approval before running. "
                        "Call ask_user with the command and reason, then if the user "
                        "approves call run_terminal again with force=true."
                    ),
                }

        env = _non_interactive_env()

        # NOTE on project-local environments (venv, node_modules, Maven's
        # local repo, GOPATH, bundler's vendor/bundle, …): this tool does NOT
        # rewrite commands or force an interpreter. Isolation is the AGENT's
        # decision, made per ecosystem from what project_context reports and
        # the `project_environment` skill explains — because the right answer
        # differs completely across languages, and a hardcoded rule can only
        # ever encode one of them. See prompts/skills/project_environment.md.

        # ── Start subprocess (non-blocking — event loop stays responsive) ──
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdin=asyncio.subprocess.DEVNULL,  # no keyboard — prompts get EOF, not a hang
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workspace,
                env=env,
            )
        except NotImplementedError:
            # uvicorn on Windows installs WindowsSelectorEventLoopPolicy, and
            # SelectorEventLoop cannot spawn subprocesses — every command dies
            # here with a blank "Failed to start command: " (str() of
            # NotImplementedError is empty). Fall back to a thread-driven
            # subprocess with identical streaming behaviour.
            return await self._run_via_threads(command, timeout_secs, on_event, run_id, env)
        except Exception as e:
            return {
                "error": f"Failed to start command: {type(e).__name__}: {e}",
                "command": command,
                "exit_code": -1,
            }

        if on_event:
            await on_event("terminal_start", {"run_id": run_id, "command": command})

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        # ── Stream stdout and stderr line-by-line (Claude Code style) ──────
        # Each line is forwarded to the client immediately so the user
        # sees "added 847 packages" as it happens, not 90 s later.

        async def _stream(stream, label: str, collector: list):
            async for raw in stream:
                line = raw.decode("utf-8", errors="replace")
                collector.append(line)
                if on_event:
                    await on_event("terminal_output", {
                        "run_id": run_id,
                        "stream": label,
                        "line": line.rstrip("\r\n"),
                    })

        stdout_task = asyncio.create_task(_stream(proc.stdout, "stdout", stdout_lines))
        stderr_task = asyncio.create_task(_stream(proc.stderr, "stderr", stderr_lines))
        wait_task   = asyncio.create_task(proc.wait())

        # ── Wait for all three with timeout ──────────────────────────────
        done, pending = await asyncio.wait(
            {stdout_task, stderr_task, wait_task},
            timeout=timeout_secs,
        )

        # ── Timeout path ──────────────────────────────────────────────────
        if pending:
            for t in pending:
                t.cancel()

            await _kill_tree(proc.pid)

            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

            if on_event:
                await on_event("terminal_done", {
                    "run_id": run_id,
                    "command": command,
                    "exit_code": -1,
                    "timed_out": True,
                })

            partial_stdout = "".join(stdout_lines)
            partial_stderr = "".join(stderr_lines)
            return {
                "error": (
                    f"Command timed out after {int(timeout_secs)}s. {_TIMEOUT_HINT}"
                ),
                "stdout": partial_stdout[:MAX_OUTPUT_SIZE] if partial_stdout else "",
                "stderr": partial_stderr[:MAX_OUTPUT_SIZE] if partial_stderr else "",
                "command": command,
                "exit_code": -1,
            }

        # ── Success path ──────────────────────────────────────────────────
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
        exit_code = proc.returncode

        stdout_truncated = stderr_truncated = False
        if len(stdout) > MAX_OUTPUT_SIZE:
            stdout = stdout[:MAX_OUTPUT_SIZE] + f"\n... (truncated — {len(stdout_lines)} lines total)"
            stdout_truncated = True
        if len(stderr) > MAX_OUTPUT_SIZE:
            stderr = stderr[:MAX_OUTPUT_SIZE] + f"\n... (truncated — {len(stderr_lines)} lines total)"
            stderr_truncated = True

        if on_event:
            await on_event("terminal_done", {
                "run_id": run_id,
                "command": command,
                "exit_code": exit_code,
                "timed_out": False,
            })

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "truncated": stdout_truncated or stderr_truncated,
        }


class RunTerminalUnavailableTool(RunTerminalTool):
    """Same name/schema as run_terminal, but the workspace lives on the CLIENT
    machine and no runtime host is connected there (browser without the
    DevAccel daemon). Executing on the server would run commands against the
    WRONG disk — the very bug that leaked the product's own code. Instead the
    agent gets a structured refusal it can turn into setup guidance for the
    user (see prompts/tool_use_agent.md, 'When a runtime is missing')."""

    async def run(self, command: str, timeout: int = None, on_event=None, force: bool = False) -> dict:
        return {
            "error": "no_runtime_host",
            "command": command,
            "exit_code": -1,
            "instruction": (
                "This workspace lives on the user's machine and no local "
                "runtime host is connected, so commands cannot be executed "
                "anywhere. Do NOT retry this or any other command. Tell the "
                "user: to enable command execution (builds, tests, installs), "
                "install and start the DevAccel daemon from the Setup Daemon "
                "tab, then re-send the request. As an alternative, give them "
                "the exact command to run themselves and ask them to paste "
                "the output."
            ),
        }
