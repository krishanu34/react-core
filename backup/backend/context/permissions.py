"""
Permission System — Tool Access Control

TWO MODES, and only two:

  "manual"  (DEFAULT) — reads and searches run freely; anything that CHANGES
                        something pauses for a human decision. This is the
                        default because the expensive failure on an existing
                        codebase is an unreviewed edit, not a slow one.
  "auto"              — nothing is gated; the agent edits and executes on its
                        own. For throwaway workspaces and greenfield scaffolds
                        where review happens at the end.

`ask`, `standard` and `strict` are gone. Requests still sending them are
normalised (see `normalize_mode`) rather than rejected, so older clients and
existing PERMISSION_MODE env values keep working:

  ask       → manual   (it was manual under a different name)
  standard  → manual   (a hard block became a prompt — the user can now say
                        yes instead of getting a dead-end failure)
  strict    → manual   (strict's real teeth were `allow_tools`, which still
                        applies in every mode — see below — so a caller that
                        passed strict+allow_tools keeps the same narrowing)

WHAT ASKS, IN MANUAL MODE

The rule is inverted on purpose: a small, explicit set of READ-ONLY tools runs
free, and EVERYTHING ELSE asks. Listing the mutating tools instead would mean
a tool added next month is silently ungated until someone remembers to add it
— the failure is invisible and points the wrong way. With the read-only list,
a new tool defaults to "ask", which is merely annoying.

On top of that, `context/sensitive_ops.py` inspects the ARGUMENTS: a call can
be pulled into the ask path because of what it touches (.env, a migration, a
`terraform apply`) even when the tool itself would have been free, and the
category it returns is what the approval card shows the human.

SESSION APPROVAL

The human gets three answers: this call only, the whole session, or reject.
"Whole session" is a blanket — nothing else is gated for the rest of the
session, which is what makes it usable on a long build instead of a per-tool
grant that still interrupts twenty more times. Two things are deliberately
NOT covered by it:
  • The destructive-command gate in run_terminal_tool (`rm -rf`, `DROP
    TABLE`, disk formats) — that has always been a separate confirmation and
    stays one.
  • Approvals are keyed by ROOT thread, so a sub-agent honours the grant the
    human gave on the conversation. Per-TOOL grants made in one place still
    do not silently widen anything, because the grant is a human act either
    way.

OPERATOR NARROWING (mode-independent)

  allow_tools  : ["read_file", "grep_search"]  — only these tools run at all
  deny_tools   : ["run_terminal"]              — these never run
  allow_paths  : ["src/**"]                    — only these paths are usable
  deny_paths   : ["config/prod.json"]          — these are blocked
  allow_write_paths : write-only fence used by spec phases

These are policy, not a mode, so they apply in `auto` too — a custom agent's
tool list must not become unrestricted just because the user picked auto.

Note: path-level blocking is for operator-configured lists. Secret VALUES in
files are handled by tools/sensitive_guard.py (content redaction), NOT by
blocking the files — the agent can and should read .env and config files to
understand the project (security rule S2).
"""

import os
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from .sensitive_ops import SensitiveOp, classify as classify_sensitive

MODE_MANUAL = "manual"
MODE_AUTO = "auto"
VALID_MODES = (MODE_MANUAL, MODE_AUTO)

# Retired mode names → the mode that now covers them. Kept as data so the
# mapping is testable and so a stale value in a .env file or a cached client
# bundle degrades to a working mode instead of an exception.
_LEGACY_MODES = {
    "ask": MODE_MANUAL,
    "standard": MODE_MANUAL,
    "strict": MODE_MANUAL,
    "default": MODE_MANUAL,
    "manual": MODE_MANUAL,
    "auto": MODE_AUTO,
    "bypass": MODE_AUTO,
    "yolo": MODE_AUTO,
    "acceptedits": MODE_AUTO,
}


def normalize_mode(mode: Optional[str]) -> str:
    """Map any incoming mode string onto one of the two live modes.

    Unknown values resolve to `manual`, never `auto`: a typo in a config file
    must not silently disable every approval prompt.
    """
    if not mode:
        return MODE_MANUAL
    return _LEGACY_MODES.get(str(mode).strip().lower(), MODE_MANUAL)


def default_mode() -> str:
    """Server default: PERMISSION_MODE env var, else manual."""
    return normalize_mode(os.getenv("PERMISSION_MODE", MODE_MANUAL))


@dataclass
class PermissionResult:
    allowed: bool
    reason: str = ""
    # True when the tool is not outright denied but needs interactive user
    # approval first. The agent turns this into a permission_request event
    # and waits for the user's decision.
    ask: bool = False
    # Set when sensitive_ops explained WHY this needs a human. Carried through
    # to the approval card so the user consents to the operation, not the tool.
    category: str = ""


# Tools that only OBSERVE. Everything absent from this set is treated as
# mutating and prompts in manual mode — see the module docstring for why the
# list is this way round.
#
#   ask_user / submit_plan  — talking to the human IS the approval flow;
#                             gating them deadlocks it.
#   checkpoint              — takes the pre-edit undo snapshot. Gating the
#                             safety net behind the prompt it protects is
#                             backwards, and it only ever adds a git object.
#   sub_agent               — spawns a child whose OWN tool calls are gated
#                             individually; prompting here too would ask
#                             twice for the same work.
#   task_manager / remember / update_project_memory
#                           — write only inside .devaccel/, never the user's
#                             source. Prompting on bookkeeping is the kind of
#                             noise that trains people to click through.
_READ_ONLY_TOOLS = {
    "read_file", "batch_read_files", "grep_search", "file_search",
    "list_directory", "workspace_tree", "project_context",
    "summarize_workspace", "report_scan", "lsp", "monitor",
    "web_search", "web_fetch",
    "ask_user", "submit_plan", "checkpoint", "sub_agent", "skill",
    "task_manager", "remember", "update_project_memory",
}


def is_read_only_tool(tool_name: str) -> bool:
    return tool_name in _READ_ONLY_TOOLS


# Exempt from allow_tools narrowing (see check_tool_permission). Deliberately
# tiny, and every member has to satisfy BOTH tests: it cannot change the
# user's project, and blocking it would break the agent's ability to consult
# the user or protect their work. `restore_context` and `resume_agent` are
# NOT here — they mutate, so policy applies to them normally.
_ALLOWLIST_EXEMPT = frozenset({"ask_user", "submit_plan", "skill", "checkpoint"})


# Per-thread session approvals. A value of "*" is the blanket grant.
_SESSION_WILDCARD = "*"
_session_approvals: Dict[str, Set[str]] = {}


def _session_key(thread_id: str) -> str:
    """Session approvals are a HUMAN decision about the conversation, so they
    are keyed by the root thread — a sub-agent spawned afterwards honours the
    grant instead of re-prompting for work the user already approved."""
    from agents.thread_ids import root_thread_id
    return root_thread_id(thread_id or "")


def is_session_approved(thread_id: str, tool_name: str) -> bool:
    granted = _session_approvals.get(_session_key(thread_id), set())
    return _SESSION_WILDCARD in granted or tool_name in granted


def approve_for_session(thread_id: str, tool_name: str) -> None:
    """Grant for one tool for the rest of the session."""
    _session_approvals.setdefault(_session_key(thread_id), set()).add(tool_name)


def approve_all_for_session(thread_id: str) -> None:
    """Blanket grant — nothing prompts again on this session."""
    _session_approvals.setdefault(_session_key(thread_id), set()).add(_SESSION_WILDCARD)


def clear_session_approvals(thread_id: str) -> None:
    _session_approvals.pop(_session_key(thread_id), None)


@dataclass
class PermissionConfig:
    """Per-request permission configuration."""
    mode: str = MODE_MANUAL
    allow_tools: Set[str] = field(default_factory=set)
    deny_tools: Set[str] = field(default_factory=set)
    allow_paths: List[str] = field(default_factory=list)
    deny_paths: List[str] = field(default_factory=list)
    # Write-only fence (spec-driven phases): when set, WRITES must match one
    # of these globs but READS stay unrestricted — the agent can study the
    # whole project while only being able to create files in, say,
    # .devaccel/spec/. Unlike allow_paths, which restricts both directions.
    allow_write_paths: List[str] = field(default_factory=list)

    def __post_init__(self):
        # Normalise once, at construction, so every read path sees a live
        # mode and no call site has to remember to translate.
        self.mode = normalize_mode(self.mode)


# Per-request config. A ContextVar (not a module-level dict) so that two
# concurrent requests — even on the SAME workspace path — can never see or
# overwrite each other's rules. asyncio.create_task() snapshots the current
# context, so the config set by the router before spawning the orchestrator
# task is visible to every tool call inside that run and nowhere else.
_request_config: ContextVar[Optional[PermissionConfig]] = ContextVar(
    "devsphere_permission_config", default=None
)


def get_config(workspace: str = ".") -> PermissionConfig:
    """
    Return the permission config for the CURRENT request/run.

    The router calls set_config() on every request with the value from the
    permission_mode form param (falling back to the PERMISSION_MODE env var).
    This function is the read path used by check_*_permission() at tool time.
    If set_config() was never called in this context, defaults to the server
    default mode (useful for direct programmatic use / tests).

    `workspace` is kept for call-site compatibility but no longer keys the
    config — isolation is per request, not per path.
    """
    config = _request_config.get()
    if config is None:
        return PermissionConfig(mode=default_mode())
    return config


def set_config(workspace: str, config: PermissionConfig):
    """Bind `config` to the current async context (one request/run)."""
    _request_config.set(config)


def check_tool_permission(
    tool_name: str,
    workspace: str = ".",
    arguments: Optional[dict] = None,
) -> PermissionResult:
    """
    Decide whether a tool call runs, is blocked, or needs a human.

    `arguments` is optional so older call sites keep working, but passing it
    is what enables argument-aware gating: without it, a `.env` write and a
    README write are indistinguishable.
    """
    config = get_config(workspace)

    # ── Operator policy first. These apply in EVERY mode, including auto:
    # a custom agent narrowed to three tools must stay narrowed regardless of
    # which mode the user picked in the UI (least privilege).
    if tool_name in config.deny_tools:
        return PermissionResult(allowed=False, reason=f"Tool '{tool_name}' is denied")

    # A small set of tools is exempt from the allow-LIST (never from
    # deny_tools). All of them share one property: they have no effect on the
    # user's project, and they are the machinery the agent needs to consult
    # the human or protect their work. Blocking them cannot make a run safer,
    # and omitting them silently breaks the very flows the permission system
    # exists to serve.
    #
    #   ask_user / submit_plan — asking the human IS the safety mechanism.
    #                            Blocking it makes the agent guess instead.
    #   skill                  — reads an instruction file. A read.
    #   checkpoint             — takes the pre-edit undo snapshot; it only
    #                            adds a git object and nothing else.
    #
    # This also absorbs a real failure mode rather than only a theoretical
    # one: any client that sends a HAND-MAINTAINED allow_tools list will omit
    # tools it has never heard of, including every mcp__* tool added at
    # runtime. Our own browser did exactly that, and a cached bundle can still
    # do it after the fix. A whitelist should narrow capability, not
    # decapitate the run.
    if tool_name in _ALLOWLIST_EXEMPT:
        return PermissionResult(allowed=True)

    if config.allow_tools and tool_name not in config.allow_tools:
        return PermissionResult(allowed=False,
                                reason=f"Tool '{tool_name}' not in allow list")

    if config.mode == MODE_AUTO:
        return PermissionResult(allowed=True)

    # ── Manual mode ──────────────────────────────────────────────────────
    if not is_read_only_tool(tool_name):
        # Mutating: always asks. The classification only decides what the
        # approval card SAYS — "writes credentials" instead of "file_write".
        sensitive = classify_sensitive(tool_name, arguments)
        reason = f"'{tool_name}' needs your approval"
        if sensitive:
            reason = f"'{tool_name}' {sensitive.reason}"
        return PermissionResult(allowed=False, ask=True, reason=reason,
                                category=sensitive.category if sensitive else "")

    # A read-only tool is escalated only when its arguments contain something
    # EXECUTABLE — include_paths=False. The distinction matters: reading
    # `.env` or `migrations/001.sql` is exactly how the agent understands a
    # brownfield project (and secret values are redacted on the way out), so
    # prompting on it would be pure friction. A command smuggled into a
    # read-only tool's arguments is different — that runs.
    sensitive = classify_sensitive(tool_name, arguments, include_paths=False)
    if sensitive:
        return PermissionResult(
            allowed=False, ask=True,
            reason=f"'{tool_name}' {sensitive.reason}",
            category=sensitive.category,
        )

    # External MCP tools are third-party code. Unless the server marked the
    # tool read-only, it gets the same first-use approval as any other
    # mutating call.
    if tool_name.startswith("mcp__"):
        try:
            from mcp_integration.security import is_readonly
            if is_readonly(tool_name):
                return PermissionResult(allowed=True)
        except Exception:  # noqa: BLE001 — a missing/broken probe must not open the gate
            pass
        return PermissionResult(allowed=False, ask=True,
                                reason=f"'{tool_name}' is an external MCP tool")

    return PermissionResult(allowed=True)


def describe_sensitivity(tool_name: str, arguments: Optional[dict]) -> Optional[SensitiveOp]:
    """Public helper for the approval card / audit log."""
    return classify_sensitive(tool_name, arguments)


def check_path_permission(path: str, workspace: str = ".", write: bool = False) -> PermissionResult:
    """
    Check if a file path is allowed for reading/writing.

    Only applies operator-configured allow/deny lists. Does NOT hard-block
    .env or credential files — reading them is legitimate and their secret
    values are redacted by sensitive_guard.py; WRITING them is what prompts,
    via check_tool_permission + sensitive_ops.
    """
    config = get_config(workspace)

    # Operator deny list (e.g. deny_paths=["config/prod.json"])
    for pattern in config.deny_paths:
        if _matches_glob(path, pattern):
            return PermissionResult(
                allowed=False,
                reason=f"Path denied by policy: '{path}' matches '{pattern}'",
            )

    # Operator allow list (if set, only these paths are accessible)
    if config.allow_paths:
        if not any(_matches_glob(path, p) for p in config.allow_paths):
            return PermissionResult(
                allowed=False,
                reason=f"Path not in allow list: '{path}'",
            )

    # Write-only fence (spec-driven phases): reads pass, writes must match.
    # Applies in auto mode too — it is a phase boundary, not a safety prompt.
    if write and config.allow_write_paths:
        if not any(_matches_glob(path, p) for p in config.allow_write_paths):
            return PermissionResult(
                allowed=False,
                reason=f"Writes are restricted to {config.allow_write_paths} "
                       f"in this phase; '{path}' is outside that fence",
            )

    return PermissionResult(allowed=True)


def check_command_permission(command: str, workspace: str = ".") -> PermissionResult:
    """
    Check whether a shell command needs a human before it runs.

    The tool-level check already gates run_terminal in manual mode, so this
    exists for callers that compose a command outside the normal tool path.
    Destructive-command blocking (rm -rf, DROP TABLE, …) is separate and
    lives in run_terminal_tool._dangerous_reason(); it fires in BOTH modes.
    """
    config = get_config(workspace)

    if config.mode == MODE_AUTO:
        return PermissionResult(allowed=True)

    from .sensitive_ops import classify_command
    hit = classify_command(command)
    if hit:
        return PermissionResult(allowed=False, ask=True,
                                reason=f"This command {hit.reason}",
                                category=hit.category)
    return PermissionResult(allowed=True)


def _matches_glob(path: str, pattern: str) -> bool:
    """Simple glob matching for permission patterns."""
    path = path.replace("\\", "/").lower()
    pattern = pattern.replace("\\", "/").lower()

    if "**" in pattern:
        prefix = pattern.split("**")[0]
        suffix = pattern.split("**")[-1]
        return path.startswith(prefix) and path.endswith(suffix)

    if "*" in pattern:
        parts = pattern.split("*")
        pos = 0
        for part in parts:
            if not part:
                continue
            idx = path.find(part, pos)
            if idx == -1:
                return False
            pos = idx + len(part)
        return True

    return path == pattern or path.endswith("/" + pattern) or path.endswith("\\" + pattern)
