"""
Sub-Agent Tool — Spawns a Child Agent for Complex Tasks

This is Claude Code's "Agent" tool. It spawns a subagent in a separate context
window to handle a subtask. The subagent works autonomously, then returns a
single structured report to the parent. The parent doesn't see intermediate
tool calls — only the report.

Why subagents?
  1. Context isolation — a deep investigation (reading 50 files) doesn't
     pollute the parent's scratchpad
  2. Parallel work — several independent subtasks at once
  3. Specialization — each child gets only the tools its job needs
  4. Recoverability — a child that fails doesn't destroy the parent's context

NO STATIC ROSTER. There is no fixed list of agent types. The calling LLM
AUTHORS each child at spawn time: its `role`, its `system_prompt`, and the
`tools` it may use. The agent spec is generated per requirement, not selected
from a menu.

KEY INVARIANTS
  • A child runs the SAME loop as its parent (agents/factory.build_agent) —
    never a weaker one.
  • A child gets its own thread_id namespace, so the read-before-overwrite
    tracker, task list and permission approvals do NOT leak between siblings.
    Without this, parallelism silently defeats the write-safety invariant:
    child A reading foo.py would make child B eligible to blind-overwrite it.
  • A child can never hold a tool its parent doesn't have.
  • Children that declare overlapping `owns_paths` are SERIALIZED, so two
    agents never edit the same file concurrently.
  • ask_user is blocked at every depth — children must be autonomous. The
    parent resolves ambiguity BEFORE spawning.
"""

import asyncio
import contextlib
import copy
import fnmatch
import os
import uuid
from typing import Optional

from .base_tool import BaseTool
from utils.logger import get_logger

log = get_logger(__name__)


# ── Spawn ceilings ───────────────────────────────────────────────────────────
# Three independent limits, mirroring the three Claude Code documents
# separately (depth / concurrent / per-session). Each is operator config, not
# agent behaviour: the LLM always decides how many children a task needs, and
# these only stop a runaway. Defaults match Claude Code's documented values so
# behaviour is comparable out of the box.

# How many layers of subagent may exist below the top-level agent. Depth 0 is
# the top-level agent, so 3 allows parent → child → grandchild → great-grandchild.
# Set to 1 to turn nesting off entirely.
MAX_SUBAGENT_DEPTH = int(os.getenv("MAX_SUBAGENT_DEPTH", "3"))

# How many subagents may run AT ONCE. Note for Pattern C deployments: every
# child's read_file/run_terminal is delegated through the SINGLE DevAccel daemon
# on the user's machine, so a wide fan-out queues on one transport rather than
# going faster — lowering this is reasonable there. Set to 0 to disable.
MAX_CONCURRENT_SUBAGENTS = int(os.getenv("MAX_CONCURRENT_SUBAGENTS", "20"))

# Total spawns allowed over one conversation, counting nested children and
# retries. Guards the case the concurrency gate cannot see: an agent that
# spawns serially in a loop, never exceeding the concurrent cap, but burning
# budget indefinitely. Cannot be disabled — that is the point of a backstop.
MAX_SUBAGENTS_PER_SESSION = max(1, int(os.getenv("MAX_SUBAGENTS_PER_SESSION", "200")))

# Refuse new spawns once the run has burned this fraction of its token budget,
# so a decomposition loop can't quietly cost N × context window.
SUBAGENT_TOKEN_BUDGET_RATIO = float(os.getenv("SUBAGENT_TOKEN_BUDGET_RATIO", "0.8"))

# Caps on what crosses the parent/child boundary, in characters (≈ tokens × 4).
_BRIEF_CAP = 6_000        # parent → child briefing
_SUMMARY_CAP = 4_000      # child → parent narrative
_FINDING_CAP = 500        # one finding/follow-up line

# Never handed to a child at any depth.
# Never handed to a child at any depth. `resume_agent` is here because a child
# holding it could resume its own SIBLINGS — reaching into transcripts that the
# per-child thread namespace exists specifically to keep separate. Resuming is
# the parent's job; it is the one agent that legitimately knows the whole fan-out.
_ALWAYS_BLOCKED = {"ask_user", "summarize_workspace", "resume_agent"}

# Tools that mutate the workspace. A child only gets these if it declared
# owns_paths — investigate wide in parallel, write narrow.
_WRITE_TOOLS = {"file_write", "code_edit", "create_output", "notebook_edit"}

# Additionally withheld from BACKGROUND children. A background agent runs while
# the parent is doing something else, so anything that mutates state the parent
# or user reasons about — persistent project memory, the run's task checklist —
# would change under them with no visible cause. Withheld on that basis, not
# because the tool is dangerous: a background child does its job and reports.
_BACKGROUND_BLOCKED = {
    "remember", "update_project_memory", "task_manager", "monitor",
}


_concurrency_gate: asyncio.Semaphore | None = None

# Write claims currently held, keyed by root thread id: {root: [owns_paths, …]}.
# A spawn whose paths overlap an active claim waits; disjoint writers proceed in
# parallel. Keyed by root so unrelated conversations never block each other.
_active_claims: dict[str, list] = {}
_claim_cv: dict[str, asyncio.Condition] = {}

# Spawns used so far, keyed by ROOT thread id, so one conversation's budget is
# never spent by another. A finished child still counts — the budget bounds
# total work attempted, not work in flight.
_session_spawns: dict[str, int] = {}


def _root_of(thread_id: str) -> str:
    """The top-level conversation a (possibly nested) thread belongs to."""
    return (thread_id or "default").split("::sub::")[0]


def reset_session_spawns(thread_id: str = "") -> None:
    """Clear the spawn budget — for a new conversation, or for test isolation."""
    if thread_id:
        _session_spawns.pop(_root_of(thread_id), None)
    else:
        _session_spawns.clear()


def _gate() -> asyncio.Semaphore | None:
    """Lazily built so the semaphore binds to the running loop, not import time."""
    global _concurrency_gate
    if MAX_CONCURRENT_SUBAGENTS <= 0:
        return None
    if _concurrency_gate is None:
        _concurrency_gate = asyncio.Semaphore(MAX_CONCURRENT_SUBAGENTS)
    return _concurrency_gate


def _summarize_task(task: str, limit: int = 140) -> str:
    """
    One readable line describing a spawn, for the UI card.

    Takes the first sentence and truncates on a WORD boundary. The full
    instruction is often several hundred words of specification; slicing it
    mid-word produced fragments like "...and archit" that looked like a bug.
    """
    text = " ".join((task or "").split())
    if not text:
        return "(no task given)"
    # First sentence, if there's a clean one worth using on its own.
    for stop in (". ", "? ", "! "):
        head = text.split(stop, 1)[0]
        if 20 <= len(head) <= limit:
            return head
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:-")
    return f"{cut}…"


def _model_aliases() -> list[str]:
    """Operator-configured model aliases, or [] when none are set."""
    try:
        from llm.factory import LLMFactory
        return LLMFactory.available_aliases()
    except Exception:  # noqa: BLE001 — the tool schema must always build
        return []


def _is_ancestor(holder_thread: str, my_thread: str) -> bool:
    """
    True if `holder_thread` is `my_thread` or one of its ancestors.

    Lineage lives in the thread id: a child of "root::sub::a" is
    "root::sub::a::sub::b". A write claim held by an ancestor must never block
    its own descendant — that claim is released only when the ancestor
    finishes, which is waiting on the descendant.
    """
    if not holder_thread or not my_thread:
        return False
    return my_thread == holder_thread or my_thread.startswith(holder_thread + "::sub::")


def _paths_overlap(a: list, b: list) -> bool:
    """True if two owns_paths glob lists could touch the same file."""
    for pa in a or []:
        for pb in b or []:
            if pa == pb or fnmatch.fnmatch(pa, pb) or fnmatch.fnmatch(pb, pa):
                return True
    return False


class SubAgentTool(BaseTool):

    # Pattern C: the child needs the live client channel so that any
    # client-executed tool it calls (read_file, grep_search, …) still runs on
    # the client. _call_tool passes on_event into run() when this is True.
    SUPPORTS_STREAMING = True

    # This tool hosts a whole agent loop, so it must see the user's Stop —
    # otherwise cancelling the parent leaves its children running.
    WANTS_STOP_CHECK = True

    name = "sub_agent"

    description = (
        "Spawn a subagent to handle a subtask in its own context window. YOU "
        "define the agent: give it a `role`, write its `system_prompt`, and "
        "choose its `tools`. It works autonomously and returns a structured "
        "report. Use for: (1) investigation that would fill your context, "
        "(2) independent work you can run in parallel — issue several "
        "sub_agent calls in ONE message and they execute concurrently, "
        "(3) subtasks needing many tool calls. A subagent that will EDIT "
        "files must declare `owns_paths`; without it the child is read-only. "
        "Subagents cannot ask the user — resolve ambiguity before spawning."
    )

    class _ChildTracker:
        """Tags a child's usage with the child's own agent id.

        Children share the parent's tracker instance — that is deliberate, it
        is how a fan-out's spend rolls up into one run total. But without a tag
        the ledger can't answer "which of the twelve agents cost that much",
        which is the first question anyone asks of an expensive run. This wraps
        rather than replaces, so the shared total stays shared.

        Falls back to a plain call for trackers that predate the extra
        arguments (the in-memory AzureTokenTracker, and test doubles).
        """

        def __init__(self, inner, agent_id: str):
            self._inner = inner
            self._agent_id = agent_id

        def record_usage(self, raw_usage: dict, model: str = "unknown", **kwargs):
            try:
                return self._inner.record_usage(
                    raw_usage, model=model, agent_id=self._agent_id, is_subagent=True
                )
            except TypeError:
                return self._inner.record_usage(raw_usage, model=model)

        def __getattr__(self, item):
            return getattr(self._inner, item)

    def __init__(self, workspace: str, llm=None, tool_registry=None,
                 token_tracker=None, context_window=8192, thread_id="default",
                 depth=0, owner_agent_id=None):
        super().__init__(workspace)
        self._llm = llm
        self._parent_registry = tool_registry
        self._token_tracker = token_tracker
        self._context_window = context_window
        # BaseTool defines self.thread_id (the registry re-stamps it per
        # request). Deliberately NOT shadowed with a private copy — two
        # sources of truth here is exactly how a child ends up reusing its
        # parent's read-tracker namespace.
        self.thread_id = thread_id
        self._depth = depth
        # Which agent owns THIS spawner — the parent recorded on every child's
        # checkpoint. None at the top level, where the owner is the root agent.
        self._owner_agent_id = owner_agent_id or "__root__"

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": (
                        "What the subagent must do AND what it must return. Be "
                        "specific. Example: 'Read every file in tests/ and list "
                        "each test function with its file path.'"
                    )
                },
                "role": {
                    "type": "string",
                    "description": (
                        "Short label for this agent's job, e.g. 'schema-migrator' "
                        "or 'test-writer'. Shown to the user while it runs."
                    )
                },
                "system_prompt": {
                    "type": "string",
                    "description": (
                        "The persona and instructions YOU write for this agent — "
                        "its expertise, standards, and how to approach the task. "
                        "This becomes the child's operating brief. Omit when "
                        "you pass agent_name instead."
                    )
                },
                "agent_name": {
                    "type": "string",
                    "description": (
                        "Delegate to an agent defined in this workspace: a name "
                        "from the <agents> block in your system prompt. Its own "
                        "definition becomes the child's operating brief, so you "
                        "do not write system_prompt yourself. Use this instead "
                        "of paraphrasing a persona the workspace already defines."
                    )
                },
                "tools": {
                    "type": "array",
                    "description": (
                        "Which tools this agent may use. Give it only what the "
                        "job needs. Omit for all read/search tools. Example: "
                        "['read_file', 'grep_search', 'list_directory']"
                    ),
                    "items": {"type": "string"}
                },
                "owns_paths": {
                    "type": "array",
                    "description": (
                        "Glob paths this agent EXCLUSIVELY owns and may write, "
                        "e.g. ['src/api/**', 'tests/api/**']. Required for any "
                        "agent that edits files. Agents with overlapping paths "
                        "are run one at a time so they cannot clobber each other."
                    ),
                    "items": {"type": "string"}
                },
                "context": {
                    "type": "string",
                    "description": (
                        "Facts the agent needs: stack, conventions, decisions "
                        "already made. Example: 'Django + PostgreSQL; models "
                        "live in core/models.py; we already chose UUID PKs.'"
                    )
                },
                "model": {
                    "type": "string",
                    "description": (
                        "Which model this agent runs on, by alias. "
                        + (
                            f"Available: {', '.join(_model_aliases())}. Pick a "
                            f"cheaper/faster one for wide mechanical work "
                            f"(searching, listing, summarising) and keep the "
                            f"default for work needing real judgement."
                            if _model_aliases()
                            else "No aliases are configured on this deployment, "
                                 "so leave this unset."
                        )
                        + " Omit to use the same model as you."
                    )
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": (
                        "Run without waiting. Returns an agent id immediately and "
                        "you carry on; the agent's report arrives as a completion "
                        "notification in a later turn. Use this whenever you have "
                        "other useful work to do meanwhile — it is the better "
                        "default for independent work. Set false only when you "
                        "need the result before you can take your next step."
                    )
                }
            },
            "required": ["task"]
        }

    # ── Briefing: parent → child ──────────────────────────────────────────

    def _build_brief(self, task: str, role: str, system_prompt: str,
                     context: str, owns_paths: list) -> str:
        """
        Compose the child's operating brief.

        The child gets a SUMMARY of the situation, never the parent's raw
        scratchpad or conversation history — copying those in would defeat the
        context isolation that is the entire point of spawning. What it does
        get: what kind of project this is, the project's own instructions, and
        the LLM-authored persona/context for this specific job.
        """
        parts = []

        if role:
            parts.append(f"## You are: {role}")
        if system_prompt:
            parts.append(system_prompt.strip())

        # Project shape — a cache lookup, not a re-scan (scan_project caches
        # per workspace path).
        try:
            from context.project_scanner import scan_project
            ctx = scan_project(self.workspace)
            facts = []
            if ctx.primary_language:
                facts.append(f"Language: {ctx.primary_language}")
            if ctx.frameworks:
                facts.append(f"Frameworks: {', '.join(ctx.frameworks[:5])}")
            if ctx.test_command:
                facts.append(f"Test: {ctx.test_command}")
            if ctx.build_command:
                facts.append(f"Build: {ctx.build_command}")
            if facts:
                parts.append("## Project\n" + "\n".join(facts))
            # devaccel.md / CLAUDE.md equivalent — the project's own standing
            # instructions, the same source update_project_memory writes.
            if ctx.ai_instructions:
                parts.append("## Project instructions\n" + ctx.ai_instructions)
        except Exception as e:  # noqa: BLE001 — briefing must never break a spawn
            log.debug(f"Sub-agent brief: project context unavailable ({e})")

        if context:
            parts.append("## Context from the parent agent\n" + context.strip())

        if owns_paths:
            parts.append(
                "## Files you own\n"
                + "\n".join(f"- {p}" for p in owns_paths)
                + "\n\nWrite ONLY within these paths. Another agent may be "
                  "working elsewhere in the repo at the same time."
            )

        parts.append(
            "## Reporting\n"
            "You work autonomously — you cannot ask the user anything. If "
            "something is ambiguous, choose the most reasonable option and say "
            "so in your report.\n\n"
            "When done, end your final message with a JSON block:\n"
            "```json\n"
            "{\"summary\": \"what you did\", \"files_changed\": [\"path\"], "
            "\"findings\": [\"notable discovery\"], "
            "\"follow_ups\": [\"what still needs doing\"], "
            "\"verification\": [{\"command\": \"pytest\", \"exit_code\": 0}]}\n"
            "```\n"
            "`verification` must list commands you ACTUALLY ran. If you changed "
            "code and ran nothing, leave it empty and say so — do not invent it."
        )

        return "\n\n".join(p for p in parts if p)[:_BRIEF_CAP]

    # ── Reporting: child → parent ─────────────────────────────────────────

    @staticmethod
    def _parse_report(answer: str) -> dict:
        """
        Pull the structured report out of the child's final message.

        Defensive like PlannerAgent's step normalization: a model that drifts
        from the format must degrade to a usable result, never crash the
        parent. If no JSON block is found, the whole answer becomes the summary.
        """
        report = {
            "summary": "", "files_changed": [], "findings": [],
            "follow_ups": [], "verification": [],
        }
        text = (answer or "").strip()

        parsed = None
        try:
            from llm.structured_output import extract_json
            parsed = extract_json(text)
        except Exception:  # noqa: BLE001 — no JSON block is an expected case
            parsed = None

        if isinstance(parsed, dict):
            report["summary"] = str(parsed.get("summary") or "")[:_SUMMARY_CAP]
            for key in ("files_changed", "findings", "follow_ups"):
                val = parsed.get(key) or []
                if isinstance(val, list):
                    report[key] = [str(v)[:_FINDING_CAP] for v in val if v]
            ver = parsed.get("verification") or []
            if isinstance(ver, list):
                for v in ver:
                    if isinstance(v, dict) and v.get("command"):
                        report["verification"].append({
                            "command": str(v["command"])[:200],
                            "exit_code": v.get("exit_code"),
                        })

        if not report["summary"]:
            report["summary"] = text[:_SUMMARY_CAP]

        # The report is untrusted input to the PARENT's context: the child may
        # have read files, pages or command output nobody reviewed, and any of
        # that can reach these fields. Defang harness-imitating framing before
        # it crosses the boundary (tools/report_scan.py). Nothing is removed.
        from .report_scan import scan_report

        report, scan_findings = scan_report(report)
        if scan_findings:
            log.warning(
                f"SubAgent report matched instruction-shaped pattern(s): "
                f"{', '.join(scan_findings)}"
            )

        return report

    # ── Spawn ─────────────────────────────────────────────────────────────

    def _brief_from_catalog(self, agent_name: str) -> Optional[dict]:
        """The workspace's own definition of `agent_name`, as
        {system_prompt, role, tools}, or None when there is no such agent.

        Reads the catalog off the `skill` tool rather than holding its own
        copy — one registry, one catalog, no chance of the two drifting."""
        skill_tool = self._parent_registry.get("skill") if self._parent_registry else None
        catalog = getattr(skill_tool, "catalog", None)
        if not catalog:
            return None
        from skills.catalog import find_entry, load_body
        from skills.closure import resolve_closure

        entry = find_entry(catalog, agent_name)
        if entry is None or entry.kind != "agent":
            return None
        body = load_body(entry, self.workspace)
        if not body:
            return None
        # The child gets the persona AND its link list, so it can pull the
        # skills the persona depends on instead of working from the identity
        # section alone.
        links = resolve_closure(entry, catalog).as_text()
        return {
            "system_prompt": body if not links else f"{body}\n\n{links}",
            "role": entry.persona or entry.name,
            "tools": list(entry.tools) or None,
        }

    async def run(self, task, role=None, system_prompt=None, tools=None,
                  owns_paths=None, context=None, on_event=None,
                  should_stop=None, run_in_background=False, model=None,
                  agent_name=None):
        if not self._llm:
            return {"error": "SubAgent not configured: no LLM available"}
        if not self._parent_registry:
            return {"error": "SubAgent not configured: no tool registry"}

        # A named workspace agent supplies its own brief. Explicit arguments
        # still win — the caller may want the persona with a narrower toolset.
        if agent_name:
            brief = self._brief_from_catalog(agent_name)
            if brief is None:
                return {
                    "status": "error",
                    "error": (
                        f"No agent named '{agent_name}' in this workspace. Use a "
                        f"name from the <agents> block, or pass system_prompt to "
                        f"define the subagent inline."
                    ),
                }
            system_prompt = system_prompt or brief["system_prompt"]
            role = role or brief["role"]
            tools = tools or brief["tools"]
            log.info(f"Subagent delegated to workspace agent '{agent_name}'")

        if self._depth >= MAX_SUBAGENT_DEPTH:
            return {
                "status": "error",
                "error": (
                    f"Maximum sub-agent depth ({MAX_SUBAGENT_DEPTH}) reached. "
                    f"Complete this subtask directly instead of delegating further."
                ),
            }

        # Per-conversation spawn budget. Refused like the token ceiling — the
        # parent is told to finish inline, which is recoverable, rather than
        # erroring the run.
        root = _root_of(self.thread_id)
        if _session_spawns.get(root, 0) >= MAX_SUBAGENTS_PER_SESSION:
            log.warning(
                f"Subagent spawn budget exhausted for {root} "
                f"({MAX_SUBAGENTS_PER_SESSION})"
            )
            return {
                "status": "refused",
                "error": (
                    f"Subagent spawn limit reached ({MAX_SUBAGENTS_PER_SESSION} "
                    f"for this conversation). Do not retry — complete the "
                    f"remaining work directly with your own tools."
                ),
            }

        # Token ceiling — refuse politely so the parent finishes inline rather
        # than treating this as a hard failure.
        if self._over_token_budget():
            return {
                "status": "refused",
                "error": (
                    "Token budget for delegation is nearly exhausted. Complete "
                    "the remaining work directly instead of spawning more agents."
                ),
            }

        from agents.factory import build_agent
        from tools.registry import ToolRegistry

        role = (role or "subagent").strip()[:60]
        owns_paths = [p for p in (owns_paths or []) if isinstance(p, str)]
        agent_id = f"{role}-{uuid.uuid4().hex[:6]}"

        # A child that owns no paths is read-only. This is the pattern that
        # holds up in practice: investigate wide in parallel, write narrow.
        blocked = set(_ALWAYS_BLOCKED)
        if not owns_paths:
            blocked |= _WRITE_TOOLS
        if run_in_background:
            blocked |= _BACKGROUND_BLOCKED

        requested = set(tools) if tools else None
        allowed = [
            t.name for t in self._parent_registry.list_tools()
            if t.name not in blocked
            and (requested is None or t.name in requested)
        ]
        if not allowed:
            return {"error": "No tools available for subagent with those restrictions"}

        # Committed to spawning — charge the budget. Counted here rather than at
        # the guard above so a spawn rejected for having no usable tools doesn't
        # consume the conversation's allowance.
        _session_spawns[root] = _session_spawns.get(root, 0) + 1

        # ── Per-child state namespace (the safety fix) ────────────────────
        # Deriving the child's thread_id gives it its OWN read-before-overwrite
        # tracker, task list and permission approvals. Siblings can no longer
        # authorize each other's writes.
        from agents.thread_ids import SUB_SEPARATOR
        child_thread = f"{self.thread_id}{SUB_SEPARATOR}{agent_id}"

        # Reuse the PARENT's live tool instances (they carry client-delegation
        # wrappers and OS-specific descriptions) rather than rebuilding from
        # classes, but re-stamp each onto the child's thread so their
        # per-thread state is isolated. Shallow copy: shares config, not identity.
        child_tools = []
        for t in self._parent_registry.list_tools():
            if t.name not in allowed:
                continue
            clone = copy.copy(t)
            clone.thread_id = child_thread
            child_tools.append(clone)

        child_registry = ToolRegistry(child_tools)

        # Per-agent model, resolved BEFORE the child's own spawner is built so a
        # grandchild inherits this child's model rather than jumping back to the
        # top-level one. Falls back to the parent's LLM for ANY problem — an
        # unconfigured alias, a typo, a provider that can't do this — because a
        # spawn must never fail over model selection.
        child_llm = self._llm
        child_window = self._context_window
        if model:
            from llm.factory import LLMFactory, context_window_for_alias
            picked = LLMFactory.for_alias(model)
            if picked is not None:
                child_llm = picked
                # A cheaper deployment usually has a SMALLER window. Sizing the
                # child by its parent's window would let it fill past its own
                # limit before compaction ever triggered.
                alias_window = context_window_for_alias(model)
                if alias_window:
                    child_window = alias_window

        # Grandchildren: a fresh SubAgentTool at depth+1, wired to the child's
        # own registry so its children inherit the child's tool set — and its
        # model, unless they name one themselves.
        if self._depth + 1 < MAX_SUBAGENT_DEPTH:
            nested = SubAgentTool(
                self.workspace,
                llm=child_llm,
                tool_registry=child_registry,
                token_tracker=self._token_tracker,
                context_window=child_window,
                thread_id=child_thread,
                depth=self._depth + 1,
                owner_agent_id=agent_id,   # grandchildren record THIS child as parent
            )
            child_registry._tools.append(nested)
            child_registry._by_name[nested.name] = nested

        brief = self._build_brief(task, role, system_prompt, context, owns_paths)

        # The child checkpoints under its OWN agent_id with this agent as its
        # parent, so an interrupted fan-out resumes only the branches that
        # never finished (context/checkpoint.py).
        child_agent = build_agent(
            llm=child_llm,
            tool_registry=child_registry,
            token_tracker=(
                self._ChildTracker(self._token_tracker, agent_id)
                if self._token_tracker is not None else None
            ),
            context_window=child_window,
            thread_id=child_thread,
            agent_id=agent_id,
            parent_agent_id=self._owner_agent_id,
            agent_role=role,
        )

        log.info(
            f"SubAgent spawn: id={agent_id} depth={self._depth + 1} "
            f"tools={child_registry.names()} owns={owns_paths or '(read-only)'}"
        )

        # Forward the child's activity tagged with agent_id so the UI can nest
        # it under this spawn instead of interleaving into the parent timeline.
        # client_tool_use passes through untagged — the browser's dispatcher
        # matches on its own correlation id.
        # Every event a child emits is tagged with its agent_id, including
        # client_tool_use — the browser needs the correlation id to execute the
        # tool, but WITHOUT the tag the terminal output it produces renders as
        # an orphaned block at the bottom of the parent's timeline, detached
        # from the agent that ran it. That is what made a three-agent run
        # unreadable.
        _FORWARD = {
            "tool_start", "tool_result", "tool_error", "tasks",
            "terminal_start", "terminal_output", "terminal_done",
            "client_tool_use",
            # A child's approval request MUST reach the UI. Everything else on
            # this list is display; this one is a question the run is blocked
            # on. Dropped, the child waits out the 300s timeout and the safe
            # default turns silence into a DENIAL — so in manual mode every
            # sub-agent write failed for a reason the user never saw and could
            # not have answered. Same failure as the broker-channel bug: the
            # channel was right, the event never left the child.
            "permission_request",
            # Same argument for the clarification card — a child asking the
            # user a question it cannot proceed without.
            "ask_user",
        }

        async def _child_on_event(event_type: str, data: dict):
            if on_event is None or event_type not in _FORWARD:
                return  # child's narration/final stays inside its own context
            res = on_event(event_type, {**data, "agent_id": agent_id})
            if res is not None:
                await res

        await self._emit(on_event, "subagent_start", {
            "agent_id": agent_id, "role": role,
            # One readable line for the card. The full instruction can run to
            # thousands of characters; a hard slice cut it mid-word ("…archit")
            # which read as corruption rather than truncation.
            "task": _summarize_task(task),
            "tools": child_registry.names(), "owns_paths": owns_paths,
            "depth": self._depth + 1,
            # Who spawned this one. Empty at depth 1 (the main agent). Lets the
            # UI build the real spawn tree — descendant counts and the path back
            # to main — instead of inferring structure from depth alone, which
            # cannot tell two sibling subtrees apart.
            "parent_agent_id": self._owner_agent_id or "",
            "background": bool(run_in_background),
            # The deployment this child actually ran on — not the alias it asked
            # for, which may have silently fallen back. Showing the real one is
            # what makes a cost surprise visible instead of assumed.
            "model": getattr(child_llm, "deployment", "") or "",
        })

        async def _execute() -> dict:
            """
            The child's whole lifecycle. Identical for foreground and background
            spawns — only whether the caller awaits it differs, so a background
            child gets the same slot arbitration, retry, verification downgrade
            and read-merge as a foreground one.
            """
            try:
                prompt = f"{brief}\n\n---\n\n## Your task\n{task}"
                async with self._slot(owns_paths, child_thread):
                    result = await child_agent.run(
                        prompt, memory_context="",
                        on_event=_child_on_event, should_stop=should_stop,
                    )

                    # ONE retry with the failure fed back in. A child that failed
                    # is usually recoverable — a bad path, a wrong command, a
                    # syntax slip it can see once it's told. Previously a single
                    # failure sank the whole task. Bounded at one attempt so a
                    # genuinely wrong plan escalates instead of looping, and only
                    # when the user hasn't asked to stop.
                    if (
                        result.get("status") in ("failed", "error", "stalled")
                        and not (should_stop and should_stop())
                    ):
                        first = self._parse_report(result.get("answer", ""))
                        log.info(f"SubAgent {agent_id} failed — retrying once with feedback")
                        await self._emit(on_event, "subagent_retry", {
                            "agent_id": agent_id, "role": role,
                            "reason": (first["summary"] or "")[:300],
                        })
                        retry_prompt = (
                            f"{prompt}\n\n---\n\n"
                            f"## Previous attempt FAILED — do not repeat it\n"
                            f"Outcome: {result.get('status')}\n"
                            f"What it reported: {first['summary'][:1500]}\n"
                            f"Files it had already changed: "
                            f"{', '.join(first['files_changed']) or '(none)'}\n\n"
                            f"Diagnose why that failed and take a DIFFERENT approach. "
                            f"Account for any changes already on disk — do not blindly "
                            f"redo them."
                        )
                        result = await child_agent.run(
                            retry_prompt, memory_context="",
                            on_event=_child_on_event, should_stop=should_stop,
                        )

                report = self._parse_report(result.get("answer", ""))
                status = result.get("status", "unknown")

                # A child that changed code but ran nothing is UNVERIFIED, not done.
                # This is the cheapest guard against confidently-wrong completions.
                if status == "done" and report["files_changed"] and not report["verification"]:
                    status = "unverified"

                # The child legitimately saw these files on the parent's behalf, so
                # the parent inherits the reads; then drop the child's namespace.
                self._merge_and_clear_reads(child_thread)

                await self._emit(on_event, "subagent_done", {
                    "agent_id": agent_id, "role": role, "status": status,
                    "steps": result.get("steps_taken", 0),
                    "files_changed": report["files_changed"],
                    # What it actually DID, not what it was asked to do — the
                    # finished card should read like an outcome, not an echo of
                    # its own instructions.
                    "summary": report["summary"],
                })

                return {
                    "status": status,
                    "agent_id": agent_id,
                    "role": role,
                    **report,
                    "steps_taken": result.get("steps_taken", 0),
                    "tokens_used": result.get("usage", {}).get("total_tokens", 0),
                }

            except Exception as e:  # noqa: BLE001 — a child must never kill the parent
                log.error(f"SubAgent {agent_id} failed: {type(e).__name__}: {e}")
                self._merge_and_clear_reads(child_thread)
                await self._emit(on_event, "subagent_done", {
                    "agent_id": agent_id, "role": role, "status": "error",
                    "summary": f"{type(e).__name__}: {e}"[:_SUMMARY_CAP],
                })
                return {
                    "status": "error",
                    "agent_id": agent_id,
                    "error": f"SubAgent failed: {type(e).__name__}: {e}",
                }

        # ── Foreground: the caller needs the result to take its next step ──
        if not run_in_background:
            return await _execute()

        # ── Background: hand back an id now, report later ──────────────────
        # The parent keeps working; subagent_registry queues the report and the
        # agent loop injects it as a completion notification on a later turn.
        # The loop also refuses to finish while any child is still running, so
        # nothing here can be silently dropped.
        from . import subagent_registry

        async def _run_and_record():
            report = await _execute()
            subagent_registry.record_result(self.thread_id, agent_id, report)
            return report

        child_task = asyncio.create_task(
            _run_and_record(), name=f"subagent:{agent_id}"
        )
        subagent_registry.register(
            self.thread_id, agent_id, role, _summarize_task(task), child_task,
        )

        return {
            "status": "started",
            "agent_id": agent_id,
            "role": role,
            "background": True,
            "note": (
                f"Agent '{role}' ({agent_id}) is running in the background. "
                f"Continue with other work — its report will arrive "
                f"automatically when it finishes. Do NOT wait or poll for it, "
                f"and do not claim its work is done until you see its report."
            ),
        }

    # ── Helpers ───────────────────────────────────────────────────────────

    async def _emit(self, on_event, event_type: str, data: dict):
        if on_event is None:
            return
        res = on_event(event_type, data)
        if res is not None:
            await res

    def _over_token_budget(self) -> bool:
        tracker = self._token_tracker
        if tracker is None or SUBAGENT_TOKEN_BUDGET_RATIO <= 0:
            return False
        try:
            used = getattr(tracker, "total_tokens", None)
            if callable(used):
                used = used()
            budget = int(os.getenv("MAX_AGENT_TOKENS", "0"))
            if not budget or not used:
                return False
            return used >= budget * SUBAGENT_TOKEN_BUDGET_RATIO
        except Exception:  # noqa: BLE001 — budgeting must not block work
            return False

    @contextlib.asynccontextmanager
    async def _slot(self, owns_paths: list, child_thread: str):
        """
        Concurrency control for one spawn.

        TWO HOLD-AND-WAIT HAZARDS, both of which deadlocked a real run:

        1. The concurrency gate. A spawner holds its slot for the WHOLE of
           child_agent.run(), and a grandchild spawned inside that run would
           ask for another slot. Once (top-level agents + their children)
           exceeded the ceiling, the grandchildren waited for slots that only
           free when their own ancestors finish — which needs the grandchildren.
           So only DEPTH-0 spawns take the gate: one slot covers an entire
           subtree. The gate still bounds top-level fan-out (what actually
           pressures the daemon transport), and MAX_SUBAGENT_DEPTH bounds the
           rest.

        2. Write claims. A descendant declaring a path its own ancestor already
           claimed would wait on a claim released only when that ancestor
           finishes. Lineage is encoded in the thread id
           ("root::sub::a::sub::b"), so an ancestor's claim is skipped — it is
           the same line of work, not a competing writer. Claims between
           SIBLINGS still serialize, which is the point of owns_paths.
        """
        root = self.thread_id.split("::sub::")[0]
        gate = _gate() if self._depth == 0 else None

        if gate is not None:
            await gate.acquire()
        try:
            if not owns_paths:
                yield
                return

            cv = _claim_cv.setdefault(root, asyncio.Condition())
            claims = _active_claims.setdefault(root, [])

            def _free() -> bool:
                for holder, paths in claims:
                    if _is_ancestor(holder, child_thread):
                        continue          # my own lineage — never a conflict
                    if _paths_overlap(owns_paths, paths):
                        return False
                return True

            entry = (child_thread, owns_paths)
            async with cv:
                await cv.wait_for(_free)
                claims.append(entry)
            try:
                yield
            finally:
                async with cv:
                    if entry in claims:
                        claims.remove(entry)
                    cv.notify_all()
        finally:
            if gate is not None:
                gate.release()

    @staticmethod
    def _merge_and_clear_reads(child_thread: str) -> None:
        from agents.thread_ids import root_thread_id
        parent_thread = root_thread_id(child_thread)
        try:
            from context import read_tracker
            read_tracker.merge_thread(child_thread, parent_thread)
            read_tracker.clear_thread(child_thread)
            # Session APPROVALS are deliberately NOT cleared here. They are
            # keyed by root thread — a human's "approve for this session"
            # covers the conversation, not one child — so clearing on child
            # exit would wipe the user's own grant and start prompting again
            # partway through a fan-out. They expire with the session.
        except Exception as e:  # noqa: BLE001 — cleanup is best-effort
            log.debug(f"Sub-agent state cleanup skipped: {e}")
