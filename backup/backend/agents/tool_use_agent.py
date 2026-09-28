"""
Tool Use Agent — Claude Code approach

HOW THE LOOP WORKS (3 rules):
──────────────────────────────
1. Send full conversation history + tool schemas to the LLM.
2. LLM returns TOOL CALLS → run them, add results to history, repeat.
3. LLM returns TEXT ONLY  → task is done. Return the answer.

The LLM decides when it's done. There is NO step limit.
When history gets too large, we compress old messages and KEEP GOING.
We never stop because of context size.

The only things that stop the loop:
  • LLM returns text with no tool calls  (normal, healthy stop)
  • User cancels via should_stop()
  • Stall guard: same tools called 3× in a row — nudge the LLM.
    After 5 nudges with zero progress we force-stop (true infinite loop).
──────────────────────────────
"""

import asyncio
import json
import os
import re
import time
from typing import Awaitable, Callable, Optional

from . import vision_buffer
from .base_agent import BaseAgent
from .skill_detector import detect_skills
from context import checkpoint, context_spill
from tools import subagent_registry
from context.token_estimator import estimate_messages_tokens, estimate_tokens
from context.budget_manager import allocate_budget, measure_system_overhead
from token_tracking.base_tracking import cached_tokens_from
from prompts.loader import PromptLoader
from utils.logger import get_logger

log = get_logger(__name__)

EventCallback = Callable[[str, dict], Optional[Awaitable[None]]]
StopCheck    = Callable[[], bool]

# Stall guard constants.
# STALL_NUDGE_AFTER: identical consecutive steps before we inject a hint.
# MAX_STALL_NUDGES:  after this many hints with no progress → force stop.
#                    This is the ONLY forced stop — the LLM controls everything else.
STALL_NUDGE_AFTER = 3
MAX_STALL_NUDGES  = 5

# Turn budgets (Phase 4) — graceful stop with a partial answer when exceeded.
# 0 = unlimited, which preserves the default "the LLM decides when it's done"
# behaviour. Set via env for deployments that want a hard ceiling per turn.
MAX_AGENT_STEPS  = int(os.getenv("MAX_AGENT_STEPS", "0"))
MAX_AGENT_TOKENS = int(os.getenv("MAX_AGENT_TOKENS", "0"))

# Auto-continue: GPT-4.1 likes to stop mid-task with "Let me know if you want
# me to continue!" even when its own task list has pending items. Claude Code
# never checks in like this — it runs to completion. When we detect that
# pattern we push the loop forward instead of ending the run. 0 disables.
AUTO_CONTINUE_MAX = int(os.getenv("AGENT_AUTO_CONTINUE_MAX", "6"))

# Mid-stream retry — the LLM layer only retries BEFORE the first streamed
# token (a retry inside the generator would duplicate tokens the consumer
# already received). When the connection drops MID-response (httpx.ReadError:
# Azure resets long streams under TPM pressure), the agent retries here
# instead: message state is intact, so we discard the partial text, emit
# `content_reset` so the UI clears it, and re-request. 0 disables.
STREAM_RETRY_MAX = int(os.getenv("AGENT_STREAM_RETRY_MAX", "2"))

# When the LLM truncates its output (finish_reason=length) mid tool-call, the
# arguments are cut off — acting on them blanks files. We regenerate with a
# doubled output budget, up to this cap. The cap must never exceed the model's
# real output limit (a bigger request 400s), so it defaults to the same
# .env-configured ceiling the LLM layer uses (LLM_MAX_OUTPUT_TOKENS) — set that
# to your deployment's max (gpt-5.6-sol: 128000).
TRUNCATION_RETRY_MAX = int(os.getenv("AGENT_TRUNCATION_RETRY_MAX", "3"))
TOOL_OUTPUT_TOKENS_CAP = int(
    os.getenv("LLM_MAX_OUTPUT_TOKENS_CAP")
    or os.getenv("LLM_MAX_OUTPUT_TOKENS")
    or "65536"
)

# Error type names (not classes — keeps the agent decoupled from httpx)
# considered transient connection failures worth retrying mid-run.
_TRANSIENT_STREAM_ERRORS = {
    "ReadError", "ReadTimeout", "WriteError", "ConnectError", "ConnectTimeout",
    "RemoteProtocolError", "ProtocolError", "IncompleteRead", "ConnectionError",
    "ConnectionResetError",
}

# Tools that modify files on disk. The first of these in a run triggers the
# automatic checkpoint. `create_output` is included (it writes into the user's
# workspace); read-only and terminal tools are not — a shell command can of
# course change files, but checkpointing before every command would snapshot
# on `ls`.
_CHECKPOINTED_TOOLS = {
    "file_write", "code_edit", "notebook_edit", "create_output",
}

_CHECKIN_RE = re.compile(
    r"(let me know|shall i|should i|would you like|do you want|want me to|"
    r"if you(?:'d| would) like|like to proceed|ready to proceed|"
    r"continue with the next|review the generated)",
    re.IGNORECASE,
)


class ToolUseAgent(BaseAgent):
    """
    Agent loop that uses the LLM's native function-calling protocol.

    The LLM is in charge of deciding when the task is done.
    It signals "done" by simply replying with text and no tool calls.
    """

    def __init__(
        self,
        llm,
        tool_registry=None,
        memory=None,
        token_tracker=None,
        context_window=8192,
        thread_id="default",
        agent_id=None,
        parent_agent_id=None,
        agent_role="",
        max_run_tokens=None,
        quota_probe=None,
    ):
        tools = tool_registry.list_tools() if tool_registry else []
        super().__init__(llm, tools, memory)
        self.tool_registry  = tool_registry
        self.token_tracker  = token_tracker
        self.context_window = context_window
        self.thread_id      = thread_id
        self.budget         = allocate_budget(context_window)
        # Per-run token ceiling. From the caller's quota when they have one,
        # else MAX_AGENT_TOKENS — the process-wide env setting that was the
        # only option before quotas existed. 0/None = unlimited.
        self.max_run_tokens = max_run_tokens or MAX_AGENT_TOKENS
        # Callback that re-reads the user's budget mid-run and returns a notice
        # dict when their standing has worsened, else None. A callback rather
        # than a direct quota import so this loop keeps knowing nothing about
        # users, teams or the database — it just relays what it's handed.
        self.quota_probe = quota_probe
        # Identity within a run, used to key checkpoints. The top-level agent
        # is ROOT_AGENT_ID; a sub-agent passes the id SubAgentTool generated,
        # so a resume can tell which branches of a fan-out never finished.
        self.agent_id        = agent_id or checkpoint.ROOT_AGENT_ID
        self.parent_agent_id = parent_agent_id
        self.agent_role      = agent_role
        # One automatic checkpoint per run, before the first edit.
        self._checkpointed = False

    # ── SSE helper ────────────────────────────────────────────────────────

    async def _emit(self, on_event, event_type: str, data: dict):
        """Send one SSE event to the client, if a callback was provided."""
        if on_event is None:
            return
        result = on_event(event_type, data)
        if result is not None:
            await result

    async def _emit_context_state(self, on_event, raw_usage: dict):
        """How full the context window is right now.

        This is NOT the cumulative token count the UI used to show. A run
        re-sends its whole prompt every step, so summing `total_tokens` across
        steps grows superlinearly and says nothing about how much room is
        left — a 40-step run can show "800k tokens" on a 128k model.

        The honest measure is the provider's own `prompt_tokens` for the call
        just made: that IS how many tokens occupied the window. Measured, not
        estimated. `cached_tokens` rides along because the same occupancy costs
        very different amounts depending on how much of it the cache served.

        The breakdown is advisory — it is the BUDGET allocated to each
        component (context/budget_manager.py), not a per-component measurement
        of the current prompt, which the provider doesn't break out.
        """
        prompt_tokens = int(raw_usage.get("prompt_tokens", 0) or 0)
        if not prompt_tokens or not self.context_window:
            return

        await self._emit(on_event, "context_state", {
            "used": prompt_tokens,
            "window": self.context_window,
            "pct": round(min(prompt_tokens / self.context_window, 1.0) * 100, 1),
            "cached": cached_tokens_from(raw_usage),
            "breakdown": {
                "system_and_tools": self.budget.system_and_tools,
                "memory": self.budget.memory_context,
                "scratchpad": self.budget.scratchpad,
                "completion_reserve": self.budget.completion_reserve,
            },
        })

    # ── Build schemas & prompts ───────────────────────────────────────────

    # ── Pre-task analysis (the "think before acting" pass) ────────────────

    # Below this length a message cannot carry a real task ("hi", "thanks",
    # "yes"), so the analysis call would be pure latency. This is a cheap
    # length check, NOT a judgement about what the task is — that is the
    # model's job (see _pre_task_analysis).
    _TRIVIAL_INPUT_CHARS = 12

    def _should_plan(self, user_input: str) -> bool:
        """
        Whether to run the pre-execution thinking pass.

        This used to match a hardcoded English keyword list against the input,
        which failed three ways: exact-token matching ("refactoring" missed
        "refactor"), an 8-word floor that discarded short-but-huge requests
        ("migrate everything to Postgres" = 4 words), and English only. The
        model now decides whether the work is complex — this only filters out
        greetings that plainly contain no task at all.
        """
        return len((user_input or "").strip()) >= self._TRIVIAL_INPUT_CHARS

    async def _pre_task_analysis(
        self,
        user_input: str,
        memory_context: str,
    ) -> str:
        """
        Make ONE LLM call to reason about the task BEFORE any tools run.

        This simulates Claude Code's extended-thinking pass: the model reads
        the request, thinks about what files to explore, plans the execution
        sequence, flags risks, and JUDGES WHETHER THE WORK SHOULD BE SPLIT —
        all before touching anything.

        The output is injected into the message list as a system-level
        context block so every subsequent tool call starts with this plan.

        Returns {"text": str, "assessment": dict}. Empty text on failure —
        planning never blocks execution.
        """
        tool_desc = self.tool_registry.descriptions_text() if self.tool_registry else ""
        try:
            plan_prompt = PromptLoader.load(
                "pre_task_analysis",
                user_input=user_input,
                memory_context=memory_context or "(no prior context)",
                tool_descriptions=tool_desc,
            )
        except FileNotFoundError:
            return {"text": "", "assessment": {}}

        try:
            # Room for the analysis AND the decomposition block; the old 700
            # cap truncated the JSON when several agents were suggested.
            analysis, usage = await self.llm.invoke(
                [{"role": "user", "content": plan_prompt}],
                temperature=0.0,
                max_tokens=1400,
            )
            if self.token_tracker:
                model = getattr(self.llm, "deployment", "unknown")
                self.token_tracker.record_usage(usage, model=model)
            text = analysis.strip()
            return {"text": text, "assessment": self._parse_assessment(text)}
        except Exception as e:
            log.warning(f"Pre-task analysis failed (non-fatal): {e}")
            return {"text": "", "assessment": {}}

    @staticmethod
    def _fanout_files_changed(tool_calls_batch: list, results: list) -> list:
        """
        Files changed by a PARALLEL fan-out in this step, or [] if there wasn't
        one.

        Only fires for 2+ concurrent sub_agent calls: a single delegated task
        is no more at risk of not-composing than doing the work inline, so
        nudging there would just be noise.
        """
        spawns = [tc for tc in tool_calls_batch if tc.name == "sub_agent"]
        if len(spawns) < 2:
            return []

        changed: list = []
        for tc, result, _kind in results:
            if tc.name != "sub_agent":
                continue
            try:
                # _call_tool stringifies the tool's dict return.
                import ast
                payload = ast.literal_eval(result) if result.startswith("{") else {}
            except (ValueError, SyntaxError):
                continue
            if isinstance(payload, dict):
                files = payload.get("files_changed")
                # Must be a LIST. A bare string here would iterate
                # character-by-character and report every letter as a filename.
                if isinstance(files, list):
                    changed.extend(str(f) for f in files if f)
        # Preserve order, drop duplicates (two agents may touch a shared file).
        return list(dict.fromkeys(changed))

    def _model_supports_vision(self) -> bool:
        """Whether this run's model can be sent images.

        Sending an image to a text-only deployment fails the WHOLE request, not
        just the image — so a wrong answer here costs the user their turn. The
        check is therefore on the model actually serving the run, and a model
        we cannot identify is assumed capable (every current GPT-4o/4.1/5-class
        deployment is, and refusing images to an unrecognised deployment name
        would silently disable the feature on most real installs).
        """
        from llm.model_capabilities import capabilities_for

        name = getattr(self.llm, "deployment", "") or getattr(self.llm, "model", "")
        return capabilities_for(name).supports_vision

    def _finish(self, status: str, answer: str, steps_taken: int,
                usage_totals: dict, messages: list, task: str) -> dict:
        """
        Every exit from the loop goes through here so the final checkpoint is
        written exactly once, whatever the outcome.

        A terminal status always flushes to the database (see
        context/checkpoint.py), which is what lets a resume tell a finished
        agent from one that was interrupted mid-flight.
        """
        # A run that ended between a tool queueing images and the loop draining
        # them must not leave those images to surface in the NEXT turn, out of
        # the context that produced them.
        vision_buffer.clear(self.thread_id)
        checkpoint.save(
            self.thread_id, self.agent_id, messages,
            status=status, parent_agent_id=self.parent_agent_id,
            role=self.agent_role, task=task[:2000],
            usage=dict(usage_totals), steps_taken=steps_taken,
        )
        return {
            "status": status,
            "answer": answer,
            "steps_taken": steps_taken,
            "usage": usage_totals,
        }

    @staticmethod
    def _parse_assessment(analysis: str) -> dict:
        """
        Pull the complexity/decomposition block out of the analysis.

        Advisory only — the agent still issues its own sub_agent calls. A model
        that omits or mangles the block just gets an empty assessment, never an
        error: the analysis text is useful on its own.
        """
        try:
            from llm.structured_output import extract_json
            parsed = extract_json(analysis)
        except Exception:  # noqa: BLE001 — a missing block is expected
            return {}
        if not isinstance(parsed, dict):
            return {}
        agents = parsed.get("suggested_agents")
        return {
            "complexity": str(parsed.get("complexity") or "").lower(),
            "decompose": bool(parsed.get("decompose")),
            "suggested_agents": agents if isinstance(agents, list) else [],
        }

    def _build_tool_schemas(self) -> list:
        """Convert the tool registry into OpenAI function-calling format."""
        if not self.tool_registry:
            return []
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters(),
                },
            }
            for tool in self.tool_registry.list_tools()
        ]

    def _build_system_prompt(self, memory_context: str, skill_content: str = "",
                             catalog_block: str = "", agents_block: str = "",
                             session_variables: str = "") -> str:
        tool_desc = self.tool_registry.descriptions_text() if self.tool_registry else ""
        base = PromptLoader.load(
            "tool_use_agent",
            tool_descriptions=tool_desc,
            memory_context=memory_context or "(no prior memory)",
            catalog=catalog_block or "(no catalog entries in this workspace)",
            agent_catalog=agents_block or "(no agent personas defined)",
            session_variables=session_variables or "(none)",
        )
        if skill_content:
            base = base + "\n\n---\n\n## Domain Expertise (Injected for This Request)\n\n" + skill_content
        return base

    # ── Tool narration ────────────────────────────────────────────────────

    @staticmethod
    def _tool_description(name: str, args: dict) -> str:
        """
        Human-readable one-liner for what a tool call is doing.
        Shown in the client alongside the tool_start event — same as
        how Claude Code narrates "Reading auth.py..." or "Searching for authMiddleware".
        """
        def _q(key, fallback=""):
            return str(args.get(key, fallback))

        descriptions = {
            "grep_search":          lambda: f"Searching for '{_q('query')}'",
            "read_file":            lambda: f"Reading {_q('path')}",
            "file_write":           lambda: f"Writing {_q('path')}",
            "code_edit":            lambda: f"Editing {_q('path')}",
            "file_search":          lambda: f"Finding files matching '{_q('pattern')}'",
            "workspace_tree":       lambda: f"Listing files in {_q('path', '.')}",
            "batch_read_files":     lambda: f"Reading {len(args.get('paths', []))} files in parallel",
            "list_directory":       lambda: f"Listing directory {_q('path', '.')}",
            "project_context":      lambda: "Detecting project type, framework, and commands",
            "run_terminal":         lambda: f"Running: {_q('command')[:80]}",
            "create_output":        lambda: f"Creating output file: {_q('filename')}",
            "ask_user":             lambda: f"Asking: {_q('question')[:80]}",
            "update_project_memory":lambda: f"Updating project memory ({_q('section')})",
            "remember":             lambda: f"Saving to memory: {_q('content')[:60]}",
            "web_search":           lambda: f"Searching the web for '{_q('query')}'",
            "web_fetch":            lambda: f"Fetching {_q('url')[:80]}",
            "git":                  lambda: f"Git: {_q('command')}",
            "notebook_edit":        lambda: f"Editing notebook cell in {_q('path')}",
            "task_manager":         lambda: f"Task manager: {_q('operation')}",
            "sub_agent":            lambda: f"Delegating subtask: {_q('task')[:60]}",
        }
        fn = descriptions.get(name)
        if fn:
            try:
                return fn()
            except Exception:
                pass
        return f"Calling {name}"

    # ── Tool execution ────────────────────────────────────────────────────

    async def _call_tool(
        self,
        tool_name: str,
        arguments: dict,
        on_event=None,
        should_stop=None,
    ) -> tuple:
        """
        Run one tool.

        Returns (text, error_kind) where error_kind is None on success and
        otherwise a classified kind from tools/tool_errors.py. The kind is what
        lets the loop tell the model whether retrying can possibly help — and
        lets the stall guard spot an agent thrashing on the same KIND of
        failure with superficially different arguments, which byte-identical
        signature matching misses.
        """
        from tools.tool_errors import classify, classify_exception

        def _fail(detail: str, err=None) -> tuple:
            e = err or classify(detail)
            return e.format(tool_name, detail), e.kind

        tool = self.tool_registry.get(tool_name) if self.tool_registry else None
        if tool is None:
            available = self.tool_registry.names() if self.tool_registry else []
            return _fail(f"unknown tool '{tool_name}'. Available: {available}")

        # The LLM's tool-call arguments failed to parse as JSON (truncated or
        # malformed — flagged in the LLM layer). Running the tool now would pass
        # empty args (e.g. file_write with no content → a blanked file). Return
        # a retryable error so the model re-issues the call with valid JSON.
        if isinstance(arguments, dict) and arguments.get("__args_parse_error__"):
            return _fail(
                f"the arguments for '{tool_name}' were not valid JSON and could "
                f"not be parsed, so the call was NOT executed"
            )

        # Undo point, taken once per run before the FIRST file-modifying call.
        # Brownfield edits land in a real repo that may have uncommitted work in
        # it; without this a wrong edit is only recoverable if the user happened
        # to commit first. `git stash create` snapshots without touching the
        # working tree, index or stash list, so the user's own git commands see
        # nothing new. Failure is silent by design — a checkpoint that cannot be
        # taken must not block the edit it was protecting.
        if tool_name in _CHECKPOINTED_TOOLS and not self._checkpointed:
            self._checkpointed = True
            try:
                from tools import checkpoint_git
                made = await checkpoint_git.create_checkpoint(
                    tool.workspace, self.thread_id,
                    label=f"before {tool_name}",
                )
                if made is not None:
                    await self._emit(on_event, "checkpoint", {
                        "id": made.index, "label": made.label,
                    })
            except Exception as e:  # noqa: BLE001
                log.debug("Checkpoint skipped: %s", e)

        # Tool-level permission check. `arguments` is passed so the decision
        # can be about what this call DOES (writing .env, running a migration)
        # rather than which tool it is — see context/sensitive_ops.py.
        from context.permissions import check_tool_permission
        perm = check_tool_permission(tool_name, workspace=tool.workspace,
                                     arguments=arguments)
        if not perm.allowed:
            # Manual mode: pause and request interactive approval. An operator
            # policy denial (deny_tools / allow_tools) is a hard block — there
            # is no human answer that should override configured least
            # privilege, so it never becomes a prompt.
            if perm.ask and on_event is not None:
                decision = await self._request_permission(
                    tool_name, arguments, on_event,
                    reason=perm.reason, category=perm.category,
                )
                if decision != "allow":
                    return _fail(f"permission denied by user: '{tool_name}' was not approved")
                # approved → fall through and execute
            elif perm.ask:
                # No event channel to ask on (background/sub-agent run started
                # without a stream). Denying is the only safe answer, but say
                # WHY — "denied" with no cause reads as a bug.
                return _fail(
                    f"'{tool_name}' requires approval and there is no interactive "
                    f"channel on this run; re-run in auto mode or from a live session"
                )
            else:
                return _fail(f"permission denied: {perm.reason}")

        try:
            extra = {}
            if on_event and getattr(tool, "SUPPORTS_STREAMING", False):
                extra["on_event"] = on_event
            # Long-running tools that host their own agent loop (sub_agent) need
            # the cancellation check, or a user's Stop leaves children running.
            if getattr(tool, "WANTS_STOP_CHECK", False):
                extra["should_stop"] = should_stop
            result = str(await tool.run(**arguments, **extra))
        except TypeError as e:
            return _fail(f"invalid arguments for '{tool_name}': {e}")
        except Exception as e:  # noqa: BLE001 — a tool must not kill the loop
            return _fail(f"{type(e).__name__}: {e}", classify_exception(e))

        # A tool may also report failure in its RETURN value rather than by
        # raising (most return {"error": ...}), so classify those too — the
        # model needs the same routing signal either way.
        if result.startswith("Error") or result.lstrip().startswith("{'error'"):
            return result, classify(result).kind
        return result, None

    # ── Clarification fallback helpers ────────────────────────────────────

    def _pending_tasks(self) -> int:
        """How many tasks in this thread's task_manager are not finished.
        The strong signal that a text-only exit is a mid-task abandonment."""
        if not self.tool_registry:
            return 0
        tm = self.tool_registry.get("task_manager")
        if tm is None or not hasattr(tm, "_get_tasks"):
            return 0
        try:
            return sum(
                1 for t in tm._get_tasks()
                if t.get("status") in ("pending", "in_progress")
            )
        except Exception:
            return 0

    @staticmethod
    def _extract_question_lines(text: str) -> list:
        """Pull clarifying questions out of a plain-text reply.

        A line counts as a question when it ends in '?' after stripping list
        markers AND any trailing examples parenthetical — GPT-4.1 typically
        writes 'Which database should be used? (e.g., MySQL, PostgreSQL)',
        so the raw line ends with ')' not '?'. The parenthetical doubles as
        the option chips for the clarification card.

        Returns [{"question", "options", "raw"}]; "raw" is the original
        stripped line so the caller can remove it from the text answer.
        """
        out = []
        for raw in text.splitlines():
            line = raw.strip().lstrip("-*•").strip()
            line = re.sub(r"^\d+[.)]\s*", "", line)
            options = []
            m = re.search(r"\(([^()]*)\)\s*$", line)
            if m:
                inner = re.sub(
                    r"^(?:e\.?\s?g\.?,?|such as|like|for example,?)\s*",
                    "", m.group(1).strip(), flags=re.IGNORECASE,
                )
                options = [
                    o.strip() for o in re.split(r",|\bor\b", inner)
                    if o.strip() and len(o.strip()) < 60
                ]
                line = line[:m.start()].strip()
            if line.endswith("?") and len(line) > 10:
                out.append({"question": line, "options": options, "raw": raw.strip()})
        return out

    # ── Interactive permission (ask mode) ─────────────────────────────────

    async def _request_permission(self, tool_name: str, arguments: dict, on_event,
                                  reason: str = "", category: str = "") -> str:
        """
        Pause and ask the user to approve a mutating tool (manual mode).

        Emits a `permission_request` event and awaits the user's decision via
        the permission broker (resolved by POST /api/agent/permission_response).
        Returns "allow" (run it) or "deny" (skip it).

        Three answers, matching the card:
          allow          — this call only
          allow_session  — blanket for the rest of the session; nothing is
                           gated again, so a long build is not interrupted
                           twenty more times
          deny           — skip it

        Safe defaults: if already session-approved → allow without prompting;
        if the user never answers within the timeout → deny.
        """
        import asyncio
        import os
        import uuid
        from tools.permission_broker import permission_broker
        from context.permissions import is_session_approved, approve_all_for_session
        from . import change_preview

        if is_session_approved(self.thread_id, tool_name):
            return "allow"

        PERMISSION_TIMEOUT = int(os.getenv("PERMISSION_TIMEOUT_SECONDS", "300"))
        request_id = uuid.uuid4().hex
        # Approval travels on the ROOT channel: the browser POSTs its decision
        # to /api/agent/permission_response under the thread id it opened the
        # stream with, never a child's derived id. A sub-agent that registered
        # here under "{root}::sub::{id}" was waiting on a key nothing would
        # resolve — so in ask mode every sub-agent request timed out and, by
        # the safe default, became a DENIAL. Fan-out was silently unusable
        # under any mode but auto.
        from .thread_ids import root_thread_id
        channel = root_thread_id(self.thread_id)
        fut = permission_broker.create(channel, request_id)

        await self._emit(on_event, "permission_request", {
            "id": request_id,
            "tool": tool_name,
            "input": arguments,
            "description": self._tool_description(tool_name, arguments),
            # Why this call in particular needs a human. Blank for an ordinary
            # edit; set to a sensitive_ops category ("secrets", "database", …)
            # when the ARGUMENTS are what raised the prompt — the card shows it
            # so the user approves the operation, not the tool name.
            "category": category,
            "reason": reason,
            # WHAT the call will actually do — a diff for an edit, the content
            # for a write, the full command for a terminal call. A card that
            # names only the tool and the path is not something a human can
            # judge, so they approve everything and the gate protects nobody.
            # Built from the arguments alone (the workspace is usually on the
            # user's machine), and redacted. See agents/change_preview.py.
            "preview": change_preview.build(tool_name, arguments),
        })

        try:
            decision = await asyncio.wait_for(fut, timeout=PERMISSION_TIMEOUT)
        except asyncio.TimeoutError:
            permission_broker.discard(channel, request_id)
            return "deny"

        if decision == "allow_session":
            approve_all_for_session(self.thread_id)
            return "allow"
        return decision  # "allow" or "deny"

    # ── Tool-result eviction (Phase 5) ────────────────────────────────────

    # Keep this many most-recent tool results verbatim; older large ones get
    # replaced by a stub so a 50-turn session doesn't drag every old file read
    # along forever. The agent can always re-read if it still needs the content.
    _EVICT_KEEP_RECENT = 6

    def _evict_stale_tool_results(self, messages: list) -> list:
        """
        Replace old, large tool results with a short stub. Runs every iteration
        (cheap) so context stays lean continuously — distinct from the heavier
        _compress_if_needed pass that only fires when the whole prompt overflows.

        Only tool messages are touched, and only their `content` string — role
        and tool_call_id are preserved, so the OpenAI tool-call structure stays
        valid.
        """
        tool_idxs = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
        if len(tool_idxs) <= self._EVICT_KEEP_RECENT:
            return messages

        # ~5% of the scratchpad budget, in chars (4 chars/token), min 1 000.
        threshold = max(1000, (self.budget.scratchpad // 20) * 4)
        stale = tool_idxs[:-self._EVICT_KEEP_RECENT]
        for i in stale:
            content = messages[i].get("content") or ""
            if len(content) <= threshold or content.startswith("[offloaded"):
                continue
            # Spill to disk BEFORE dropping it, so the agent can pull the exact
            # bytes back instead of re-running whatever produced them. Only if
            # the write fails do we fall back to the old lossy tombstone.
            ref = context_spill.spill(
                self.thread_id, content,
                label=f"tool result from step ~{i}",
            )
            if ref:
                replacement = context_spill.pointer(ref, len(content), "earlier tool result")
            else:
                replacement = (
                    f"[evicted: {len(content)} chars of an earlier tool result — "
                    f"re-read the file or re-run the search if you still need it]"
                )
            messages[i] = {**messages[i], "content": replacement}
        return messages

    # ── Context compression ───────────────────────────────────────────────

    def _compress_if_needed(self, messages: list) -> list:
        """
        Keep the conversation history within the model's context window.

        When history grows too large, summarise old messages into one-liners
        and keep the recent messages verbatim.  The agent KEEPS RUNNING after
        this — we never stop just because context is filling up.

        What gets kept verbatim:   the system message + the last 1/3 of turns.
        What gets summarised:      everything older than that.

        Summary length per message is derived from the budget so it scales
        with the model's context window — not hardcoded.
        """
        if estimate_messages_tokens(messages) <= self.budget.total_prompt_budget:
            return messages  # still fits — nothing to do

        system_msg = messages[0] if messages[0]["role"] == "system" else None
        rest       = messages[1:] if system_msg else messages

        # Keep at least 6 messages (≈3 turns), or the last third, whichever is more.
        keep_count = max(6, len(rest) // 3)
        old_msgs   = rest[:-keep_count]
        recent     = rest[-keep_count:]

        # Summary chars per message: give each old message a fair share of
        # 20% of the total prompt budget (the summary block shouldn't dominate).
        # Minimum 40 chars so summaries are still readable.
        summary_budget_chars = max(
            40,
            (self.budget.total_prompt_budget * 4 // 5) // max(len(old_msgs), 1),
        )

        # Spill the originals before summarising: the one-liners below are
        # lossy by design, but the full text stays retrievable by ref so the
        # agent can recover a detail it turns out to need.
        spill_ref = context_spill.spill(
            self.thread_id,
            json.dumps(old_msgs, ensure_ascii=False, default=str),
            label=f"{len(old_msgs)} compressed messages",
        )

        # Turn old messages into compact one-liners.
        summary_lines = []
        for msg in old_msgs:
            role    = msg.get("role", "")
            content = msg.get("content", "") or ""
            if role == "tool":
                short = (content[:summary_budget_chars] + "...") if len(content) > summary_budget_chars else content
                summary_lines.append(f"[tool result: {short}]")
            elif role == "assistant":
                if msg.get("tool_calls"):
                    names = [tc.get("function", {}).get("name", "?") for tc in msg["tool_calls"]]
                    summary_lines.append(f"[called tools: {', '.join(names)}]")
                elif content:
                    summary_lines.append(f"[assistant: {content[:summary_budget_chars]}]")
            elif role == "user":
                summary_lines.append(f"[user: {content[:summary_budget_chars]}]")

        compressed = []
        if system_msg:
            compressed.append(system_msg)
        if summary_lines:
            header = "## Earlier steps (compressed to free context)"
            if spill_ref:
                header += (
                    f"\nThe full text of these steps is saved as `{spill_ref}` — "
                    f"call restore_context(\"{spill_ref}\") if you need a detail "
                    f"the summary lost. Do NOT re-run work to recover it."
                )
            compressed.append({
                "role": "system",
                "content": header + "\n" + "\n".join(summary_lines),
            })
        compressed.extend(recent)

        log.info(
            f"Context compressed: {len(old_msgs)} old messages → 1 summary block"
            + (f" (spilled as {spill_ref})" if spill_ref else " (spill unavailable)")
        )
        return compressed

    # ── Main loop ─────────────────────────────────────────────────────────

    async def run(
        self,
        input: str,
        memory_context: str = "",
        on_event: Optional[EventCallback] = None,
        should_stop: Optional[StopCheck] = None,
        agent_logger=None,
        images: list = None,
    ):
        """
        Run the agent loop until the LLM says it's done.

        The LLM signals "done" by responding with plain text and no tool calls.
        Until then, we execute whatever tools it requests and feed the results
        back into the conversation.
        """
        # ── Skill catalog ─────────────────────────────────────────────────
        # The catalog lists every definition this workspace exposes — ours and
        # any framework the user imported — as name + description, one line
        # each. The model reads it and calls skill("<name>") for the bodies it
        # actually needs. Same progressive disclosure Claude Code and Copilot
        # use, and the reason a 200-file framework doesn't cost 200 files of
        # context on every turn.
        catalog_block = agents_block = session_variables = ""
        _skill_tool = self.tool_registry.get("skill") if self.tool_registry else None
        if _skill_tool is not None and getattr(_skill_tool, "catalog", None):
            from skills.catalog import render_agents_block, render_catalog
            from skills.variables import render_session_variables
            catalog_block = render_catalog(_skill_tool.catalog)
            agents_block = render_agents_block(_skill_tool.catalog)
            session_variables = render_session_variables(_skill_tool.session_scope)
            log.info(f"Skill catalog: {len(_skill_tool.catalog)} entries "
                     f"({sum(1 for e in _skill_tool.catalog if e.kind == 'agent')} agents)")

        # Keyword detection still runs: it tells the UI what the turn looks
        # like, and it is the FALLBACK body injection for contexts with no
        # catalog (sub-agents, spec phases) — there, nothing would reach the
        # model otherwise.
        skill_match = detect_skills(input, project_context=memory_context)
        skill_content = ""
        if not catalog_block:
            from spec_driven.parsers import parse_skill
            for skill_name in skill_match.skills:
                try:
                    _raw = PromptLoader.load(f"skills/{skill_name}")
                except FileNotFoundError:
                    log.warning(f"Skill file not found: skills/{skill_name}.md")
                    continue
                # Inject the instructions, not the frontmatter — the metadata
                # is for the catalog, and pasting it into the prompt as prose
                # just spends context on a header the model can't act on.
                _parsed = parse_skill(_raw, fallback_name=skill_name)
                skill_content += (_parsed["instructions"] if _parsed else _raw) + "\n\n"
            if skill_match.skills:
                log.info(
                    f"Skills injected (no catalog): {skill_match.skills} "
                    f"(confidence={skill_match.confidence}) — "
                    f"{'; '.join(skill_match.reasons)}"
                )

        # Give ask_user the original task so its question-set completion knows
        # what the user actually asked for (see AskUserTool._maybe_expand).
        if self.tool_registry:
            _ask = self.tool_registry.get("ask_user")
            if _ask is not None and hasattr(_ask, "set_task_context"):
                _ask.set_task_context(input if isinstance(input, str) else str(input))

        system_prompt = self._build_system_prompt(
            memory_context,
            skill_content=skill_content.strip(),
            catalog_block=catalog_block,
            agents_block=agents_block,
            session_variables=session_variables,
        )
        tool_schemas  = self._build_tool_schemas()

        # Measure actual system overhead now that we have the real text.
        # This replaces the conservative default estimate so the remaining
        # budget is partitioned correctly between memory and scratchpad.
        import json as _json
        actual_overhead = measure_system_overhead(
            system_text=system_prompt,
            tools_text=_json.dumps(tool_schemas),
        )
        self.budget = allocate_budget(self.context_window, system_overhead=actual_overhead)

        # Tool result cap: one result shouldn't use more than ~10% of the
        # scratchpad budget. Convert tokens → chars (4 chars per token).
        # Floor at 2 000 chars so even tiny budgets stay usable.
        _tool_result_cap_chars = max(2000, (self.budget.scratchpad // 10) * 4)

        # Emit what this turn can reach. `skills` stays the keyword match the
        # UI already renders; `catalog` is what the model can actually load,
        # so the user can see an imported framework registered.
        await self._emit(on_event, "skills_loaded", {
            "skills": skill_match.skills,
            "confidence": skill_match.confidence,
            "reasons": skill_match.reasons,
            "catalog": [e.to_dict() for e in (_skill_tool.catalog if _skill_tool else [])],
        })

        # ── Pre-task analysis — "think before acting" ─────────────────────
        # For complex tasks, make ONE dedicated LLM call to reason through
        # the full approach BEFORE any tools run. This mirrors Claude Code's
        # extended-thinking pass: identify what to read, plan the sequence,
        # flag risks — all upfront, so execution is confident rather than
        # reactive step-by-step discovery.
        #
        # Runs BEFORE the messages list is built so the analysis can be
        # injected directly into the conversation as a system context block.
        pre_analysis = ""
        if self._should_plan(input):
            await self._emit(on_event, "thinking", {
                "thought": "[Analysing task before execution...]",
            })
            _analysis = await self._pre_task_analysis(input, memory_context)
            pre_analysis = _analysis["text"]
            assessment = _analysis["assessment"]
            if pre_analysis:
                await self._emit(on_event, "thinking", {
                    "thought": f"[Pre-task analysis]\n{pre_analysis}",
                })
                log.info(
                    f"Pre-task analysis complete ({len(pre_analysis)} chars, "
                    f"complexity={assessment.get('complexity') or 'unrated'}, "
                    f"decompose={assessment.get('decompose', False)})"
                )
            if assessment.get("decompose") and assessment.get("suggested_agents"):
                # Advisory — the agent still issues the real sub_agent calls.
                # Surfaced so the UI can show "planning N agents" before any
                # subagent_start arrives.
                await self._emit(on_event, "decomposition", {
                    "complexity": assessment.get("complexity", ""),
                    "agents": assessment["suggested_agents"],
                })

        # Build the first user message — plain text, or multipart if images attached.
        # Claude Code approach: each request starts a fresh conversation with
        # the LLM. Cross-session continuity comes from memory_context (text),
        # devaccel.md (project facts), and the workspace itself (files on disk).
        # We never inject prior raw tool-call messages — that causes structural
        # errors (tool message with no preceding tool_calls) and is not how
        # Claude Code works.
        if images:
            user_content: list | str = [{"type": "text", "text": input}]
            for img in images:
                user_content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{img['mime_type']};base64,{img['data']}"},
                })
        else:
            user_content = input

        messages = [
            {"role": "system", "content": system_prompt},
        ]

        # Inject pre-task analysis as a second system message so the model
        # starts execution already holding its own reasoned plan.
        # Positioned between the main instructions and the user's message —
        # same placement as Claude Code's extended thinking output.
        if pre_analysis:
            messages.append({
                "role": "system",
                "content": (
                    "## Your pre-execution analysis\n\n"
                    + pre_analysis
                    + "\n\n---\nExecute the plan above. "
                    "Use the tools you identified. Follow the sequence you outlined."
                ),
            })

        messages.append({"role": "user", "content": user_content})

        usage_totals = {"prompt_tokens": 0, "completion_tokens": 0,
                        "total_tokens": 0, "cached_tokens": 0}
        steps_taken   = 0
        stall_count   = 0
        stall_nudges  = 0          # how many stall nudges we've given so far
        asked_user    = False      # True once ask_user has run (tool or fallback)
        auto_continues = 0         # mid-task check-ins we've pushed through
        integration_checked = False  # post-fan-out build/test nudge, once per run
        last_step_signature: frozenset = frozenset()

        def _accumulate_usage(raw: dict):
            usage_totals["prompt_tokens"]      += raw.get("prompt_tokens", 0)
            usage_totals["completion_tokens"]   += raw.get("completion_tokens", 0)
            usage_totals["total_tokens"]        += raw.get("total_tokens", 0)
            usage_totals["cached_tokens"]       += cached_tokens_from(raw)
            if self.token_tracker:
                model = getattr(self.llm, "deployment", "unknown")
                self.token_tracker.record_usage(raw, model=model)

        # Threshold levels already announced, so a long run reports each
        # crossing once instead of repeating the same banner every step.
        quota_seen: set = set()

        async def _probe_quota():
            """Warn mid-run when the user crosses a budget threshold.

            Without this a run that starts at 70% and ends at 130% says
            nothing until the NEXT message — by which point the tokens are
            already spent. This never stops the run: the per-run ceiling and
            the next run's opening check do the stopping.
            """
            if self.quota_probe is None:
                return
            try:
                notice = self.quota_probe(usage_totals["total_tokens"])
            except Exception as e:  # noqa: BLE001 — budgeting must not break work
                log.debug(f"Quota probe failed: {e}")
                return
            if notice and notice.get("level") not in quota_seen:
                quota_seen.add(notice["level"])
                await self._emit(on_event, "quota_notice", notice)

        # ═══════════════════════════════════════════════════════════════════
        #  THE LOOP  —  runs until the LLM decides it's done
        #  ─────────────────────────────────────────────────────────────────
        #  ① User stop?         → exit
        #  ② History too large? → compress and KEEP GOING
        #  ③ Call the LLM
        #  ④ LLM text only      → DONE ✓  (normal exit)
        #  ⑤ LLM tool calls     → run tools, add results, loop
        #  ⑥ Stall guard        → nudge if same tools 3× in a row
        #  ⑦ Empty response     → nudge and retry
        # ═══════════════════════════════════════════════════════════════════
        while True:

            # ① User pressed stop?
            if should_stop and should_stop():
                # Background children don't observe should_stop between their own
                # steps, so cancel them explicitly — otherwise Stop leaves work
                # running against the user's workspace after the run reports
                # stopped.
                await subagent_registry.cancel_all(self.thread_id)
                await self._emit(on_event, "stopped", {"steps_taken": steps_taken})
                return self._finish(
                    "stopped", "Run was stopped by user.",
                    steps_taken, usage_totals, messages, str(input),
                )

            # ①½ Turn budget (Phase 4) — graceful stop with partial progress.
            _over_steps = MAX_AGENT_STEPS and steps_taken >= MAX_AGENT_STEPS
            _over_tokens = self.max_run_tokens and usage_totals["total_tokens"] >= self.max_run_tokens
            if _over_steps or _over_tokens:
                limit = f"{MAX_AGENT_STEPS} steps" if _over_steps else f"{self.max_run_tokens} tokens"
                answer = (
                    f"I reached the turn budget ({limit}) before finishing. Here's where I got "
                    f"to after {steps_taken} step(s) — send another message to continue."
                )
                await self._emit(on_event, "final", {"answer": answer})
                return self._finish(
                    "budget_exceeded", answer,
                    steps_taken, usage_totals, messages, str(input),
                )

            # ①¾ Background children that finished since the last turn. Injected
            #     BEFORE compression so a long report is subject to the same
            #     budget as any other content, and before the LLM call so the
            #     model sees the result on its very next turn.
            for _note in subagent_registry.drain(self.thread_id):
                await self._emit(on_event, "subagent_notification", {
                    "agent_id": _note["agent_id"],
                    "role": _note["role"],
                    "status": (_note["report"] or {}).get("status", "unknown"),
                })
                messages.append({
                    "role": "user",
                    "content": subagent_registry.format_notification(_note),
                })

            # ②a Evict stale large tool results (Phase 5) — keep context lean
            #     continuously, before the heavier compression check below.
            messages = self._evict_stale_tool_results(messages)

            # ② Compress history if needed — never stop because of context size.
            _before_compress = len(messages)
            messages = self._compress_if_needed(messages)
            if len(messages) < _before_compress:
                # Surfaced so the user sees WHY the agent's memory of earlier
                # steps just got fuzzier. Claude Code announces its auto-compact
                # for the same reason: silent context loss reads as the agent
                # forgetting things at random.
                await self._emit(on_event, "compaction", {
                    "messages_before": _before_compress,
                    "messages_after": len(messages),
                    "window": self.context_window,
                })

            # ③ Call the LLM.
            await self._emit(on_event, "thinking", {"step": steps_taken + 1, "status": "calling_llm"})

            stream_attempt = 0
            truncation_attempt = 0
            tool_budget = None  # None → LLM default budget; grows on truncation
            while True:
                try:
                    text_parts: list       = []
                    tool_calls_batch: list = []
                    stream_usage: dict     = {}
                    truncation: dict       = None

                    _stream_kwargs = {"tools": tool_schemas}
                    if tool_budget is not None:
                        _stream_kwargs["max_tokens"] = tool_budget
                    async for kind, value in self.llm.stream_with_tools(messages, **_stream_kwargs):
                        if kind == "content":
                            text_parts.append(value)
                            await self._emit(on_event, "content", {"delta": value})  # live token streaming
                        elif kind == "tool_calls":
                            tool_calls_batch = value
                        elif kind == "usage":
                            stream_usage = value
                        elif kind == "truncated":
                            truncation = value

                    _accumulate_usage(stream_usage)
                    await self._emit(on_event, "token_usage", {"usage": dict(usage_totals)})

                    # Context occupancy, measured rather than estimated: the
                    # provider's own prompt_tokens for the call just made IS
                    # how full the window was. Emitted every step so the meter
                    # tracks the run instead of updating once at the end.
                    await self._emit_context_state(on_event, stream_usage)
                    await _probe_quota()

                    # Output hit the token cap mid-turn (finish_reason=length):
                    # the tool-call arguments / text are cut off. Acting on a
                    # half-formed call is exactly what wrote empty files — so
                    # DON'T. Regenerate with a doubled budget (capped), the way
                    # Claude Code gives large writes room to finish. Only the
                    # budget grew; message state is intact, so this is safe.
                    if truncation and truncation_attempt < TRUNCATION_RETRY_MAX:
                        truncation_attempt += 1
                        prev = int(truncation.get("max_tokens") or 16384)
                        new_budget = min(prev * 2, TOOL_OUTPUT_TOKENS_CAP)
                        if new_budget > (tool_budget or 0):
                            tool_budget = new_budget
                            await self._emit(on_event, "content_reset", {})
                            await self._emit(on_event, "thinking", {
                                "thought": (
                                    f"[Output was truncated at {prev} tokens — "
                                    f"regenerating with a larger budget "
                                    f"({tool_budget} tokens); attempt "
                                    f"{truncation_attempt}/{TRUNCATION_RETRY_MAX}]"
                                ),
                            })
                            continue
                        # Already at the cap — fall through with what we have
                        # rather than spinning; the loop degrades to the partial
                        # text instead of an empty write.

                    reply_text = "".join(text_parts).strip()
                    break

                except Exception as e:
                    err_name = type(e).__name__
                    if err_name in _TRANSIENT_STREAM_ERRORS and stream_attempt < STREAM_RETRY_MAX:
                        # Connection dropped mid-response. Messages are still
                        # intact, so retry the whole call: tell the UI to
                        # discard the partial text, back off, and re-request.
                        stream_attempt += 1
                        delay = 2 ** stream_attempt
                        log.warning(
                            f"LLM stream dropped mid-response ({err_name}) — "
                            f"retry {stream_attempt}/{STREAM_RETRY_MAX} in {delay}s"
                        )
                        await self._emit(on_event, "content_reset", {})
                        await self._emit(on_event, "thinking", {
                            "thought": (
                                f"[Connection dropped mid-response ({err_name}) — "
                                f"retrying {stream_attempt}/{STREAM_RETRY_MAX}]"
                            ),
                        })
                        await asyncio.sleep(delay)
                        continue

                    detail = str(e) or (
                        "connection dropped mid-response — likely Azure closing "
                        "the stream under rate-limit (TPM) pressure"
                        if err_name in _TRANSIENT_STREAM_ERRORS else "(empty)"
                    )
                    error_msg = f"{err_name}: {detail}"
                    await self._emit(on_event, "error", {"message": error_msg})
                    return self._finish(
                        "failed", f"LLM call failed: {error_msg}",
                        steps_taken, usage_totals, messages, str(input),
                    )

            # ④ TEXT ONLY, no tool calls → the LLM decided it is done.
            #    This is the normal, healthy exit from the loop.
            if reply_text and not tool_calls_batch:
                # Clarification fallback — GPT-4.1 sometimes writes its clarifying
                # questions as plain text instead of calling ask_user, leaving the
                # user with no buttons. Detect that (early step, 2+ question lines,
                # ask_user never used) and route the questions through the tool so
                # the UI still gets the structured card, with the expander adding
                # option suggestions.
                if steps_taken <= 1 and not asked_user and self.tool_registry:
                    q_lines = self._extract_question_lines(reply_text)
                    if len(q_lines) >= 2:
                        ask_tool = self.tool_registry.get("ask_user")
                        if ask_tool is not None:
                            try:
                                await ask_tool.run(
                                    questions=[
                                        {"question": q["question"], "options": q["options"]}
                                        for q in q_lines
                                    ],
                                    on_event=on_event,
                                )
                                asked_user = True
                                # The card now carries the questions — drop the
                                # duplicated plain-text lines from the answer.
                                drop = {q["raw"] for q in q_lines}
                                reply_text = "\n".join(
                                    ln for ln in reply_text.splitlines()
                                    if ln.strip() not in drop
                                ).strip()
                                log.info(
                                    f"Clarification fallback: converted {len(q_lines)} "
                                    f"plain-text questions into an ask_user card"
                                )
                            except Exception as e:
                                log.warning(f"Clarification fallback failed (non-fatal): {e}")

                # Auto-continue — the model stopped mid-task to check in even
                # though its own task list still has pending items. Claude Code
                # never does this; GPT-4.1 does despite prompt rules. Push the
                # loop forward instead of ending the run and forcing the user to
                # type "continue" after every batch.
                pending = self._pending_tasks()
                if (
                    not asked_user
                    and auto_continues < AUTO_CONTINUE_MAX
                    and steps_taken >= 1
                    and pending > 0
                    and _CHECKIN_RE.search(reply_text[-400:])
                ):
                    auto_continues += 1
                    log.info(
                        f"Auto-continue #{auto_continues}/{AUTO_CONTINUE_MAX}: model "
                        f"checked in mid-task with {pending} task(s) still pending"
                    )
                    await self._emit(on_event, "thinking", {
                        "thought": f"[Auto-continuing — {pending} task(s) still pending]",
                    })
                    messages.append({"role": "assistant", "content": reply_text})
                    messages.append({"role": "user", "content": (
                        "Continue with the remaining tasks autonomously — do not stop to "
                        "ask or report progress. If you are genuinely blocked and need my "
                        "decision, call the ask_user tool instead of asking in plain text."
                    )})
                    continue

                # Background children still working? The run CANNOT end here —
                # their reports would be dropped and the answer would describe
                # work that hadn't happened. Wait, then loop so the model sees
                # every report and can revise its answer.
                _still_running = subagent_registry.pending(self.thread_id)
                if _still_running:
                    log.info(
                        f"Holding the answer for {len(_still_running)} background "
                        f"subagent(s) still running"
                    )
                    await self._emit(on_event, "thinking", {
                        "thought": (
                            f"[Waiting for {len(_still_running)} background "
                            f"agent(s) to finish before answering]"
                        ),
                    })
                    messages.append({"role": "assistant", "content": reply_text})
                    # should_stop is polled while waiting: otherwise Stop during
                    # a long fan-out did nothing until the slowest child ended,
                    # because the loop was parked here and never reached its own
                    # stop check at ①.
                    await subagent_registry.wait_all(
                        self.thread_id, should_stop=should_stop,
                    )
                    continue

                # Reports that landed after the last drain but before this exit.
                if subagent_registry.undelivered(self.thread_id):
                    messages.append({"role": "assistant", "content": reply_text})
                    continue

                log.info(f"Agent finished naturally after {steps_taken} steps")
                await self._emit(on_event, "final", {"answer": reply_text})
                if self.memory:
                    self.memory.add(
                        content=f"Q: {input[:200]}\nA: {reply_text[:200]}",
                        tags=["conversation"],
                    )
                return self._finish(
                    "done", reply_text,
                    steps_taken, usage_totals, messages, str(input),
                )

            # ⑤ TOOL CALLS → run every tool (in parallel), add results, loop.
            if tool_calls_batch:

                # The LLM's narrative text before the tool calls was already
                # streamed token-by-token as "content" events above.
                # Emit a narration_done marker so the client knows text is finished
                # and tool execution is starting — do NOT re-emit as "thinking"
                # (that would duplicate what was already shown).
                if reply_text:
                    await self._emit(on_event, "narration_done", {"text": reply_text})

                if agent_logger:
                    agent_logger.log_agent_step(
                        step_number=steps_taken + 1,
                        thought=reply_text or "",
                        action=", ".join(tc.name for tc in tool_calls_batch),
                    )

                # Add the assistant's decision to history
                messages.append({
                    "role": "assistant",
                    "content": reply_text or None,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                        }
                        for tc in tool_calls_batch
                    ],
                })

                # Run all tools in parallel — same as Claude Code
                async def _run_tool(tc):
                    await self._emit(on_event, "tool_start", {
                        "tool": tc.name,
                        "input": tc.arguments,
                        "description": self._tool_description(tc.name, tc.arguments),
                    })
                    t0     = time.monotonic()
                    result, err_kind = await self._call_tool(
                        tc.name, tc.arguments, on_event=on_event,
                        should_stop=should_stop,
                    )
                    ms     = round((time.monotonic() - t0) * 1000)

                    is_err = err_kind is not None
                    await self._emit(
                        on_event,
                        "tool_error" if is_err else "tool_result",
                        {"tool": tc.name, "observation": result[:_tool_result_cap_chars]},
                    )
                    if agent_logger:
                        agent_logger.log_tool_call(
                            tool_name=tc.name, tool_input=tc.arguments,
                            tool_output_size=len(result), tool_duration_ms=ms,
                            tool_success=not is_err,
                            tool_error=result if is_err else None,
                            step_number=steps_taken + 1,
                        )
                    # A loaded catalog entry is worth announcing: `skill_loaded`
                    # shows the user which of their own files drove the turn,
                    # and `persona_active` lets the client pin the persona so
                    # it stays in character across the next messages.
                    if tc.name == "skill" and not is_err and _skill_tool is not None:
                        from skills.catalog import find_entry
                        _loaded = find_entry(_skill_tool.catalog,
                                             (tc.arguments or {}).get("name", ""))
                        if _loaded is not None:
                            await self._emit(on_event, "skill_loaded",
                                             _loaded.to_dict())
                            if _loaded.kind == "agent":
                                await self._emit(on_event, "persona_active", {
                                    "name": _loaded.name,
                                    "persona": _loaded.persona,
                                    "title": _loaded.title,
                                    "icon": _loaded.icon,
                                    "source": _loaded.source,
                                })
                    # NOTE: the ask_user SSE event is emitted by AskUserTool itself
                    # (with the EXPANDED question set) — emitting tc.arguments here
                    # would show the un-expanded original question in the UI.
                    return tc, result, err_kind

                if any(tc.name == "ask_user" for tc in tool_calls_batch):
                    asked_user = True

                results = await asyncio.gather(*[_run_tool(tc) for tc in tool_calls_batch])

                # Add every tool result to the conversation history,
                # capped to the budget-derived limit to protect context.
                for tc, result, _kind in results:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result[:_tool_result_cap_chars],
                    })

                # Images a tool produced (a screenshot it read, the rendered
                # pages of a scanned PDF) ride in a user message right after
                # the tool results — the protocol has no image part in a
                # `tool` message, so this is the only place they can go. See
                # agents/vision_buffer.py. Claude Code's Read shows images
                # visually; this is what makes that true here too.
                _tool_images = vision_buffer.drain(self.thread_id)
                if _tool_images and self._model_supports_vision():
                    _parts = [{
                        "type": "text",
                        "text": (
                            "Image(s) from the file(s) you just read, in the "
                            "order they were returned:"
                        ),
                    }]
                    for _img in _tool_images:
                        _parts.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{_img['mime_type']};base64,{_img['data']}",
                            },
                        })
                    messages.append({"role": "user", "content": _parts})
                    log.info(f"Attached {len(_tool_images)} tool-produced "
                             f"image(s) to the conversation")
                elif _tool_images:
                    # Vision-incapable model: say so in the transcript rather
                    # than dropping the images silently, or the model reasons
                    # about pictures it was told it would receive.
                    messages.append({"role": "user", "content": (
                        f"[{len(_tool_images)} image(s) were extracted from "
                        f"the file(s) you just read, but this model cannot "
                        f"process images. Work from the text, or tell the user "
                        f"a vision-capable model is needed for this file.]"
                    )})
                    log.info(f"Dropped {len(_tool_images)} image(s) — "
                             f"{getattr(self.llm, 'deployment', 'model')} has no vision")

                # ⑤a Post-fan-out integration check (§10c). Each child verified
                #     its OWN work in isolation; that does not mean the pieces
                #     compose — mismatched imports, duplicate definitions, a
                #     broken build. Serial execution catches this implicitly,
                #     parallel does not. Nudge once per fan-out that produced
                #     file changes, so the agent runs the project's build/test
                #     before it reports done.
                _fanout_changed = self._fanout_files_changed(tool_calls_batch, results)
                if _fanout_changed and not integration_checked:
                    integration_checked = True
                    messages.append({
                        "role": "user",
                        "content": (
                            "Your sub-agents changed these files independently: "
                            f"{', '.join(_fanout_changed[:20])}. "
                            "Each verified only its own work. Before you report "
                            "done, run this project's build and test commands "
                            "once to confirm the pieces actually compose, and "
                            "fix anything that broke."
                        ),
                    })

                steps_taken += 1

                # ⑤b Checkpoint — a step just completed, so this is the newest
                #    safe resume point. Writing AFTER the tool results are in
                #    `messages` means a resume never re-runs work whose result
                #    we already have. Best-effort by design (context/checkpoint.py).
                checkpoint.save(
                    self.thread_id, self.agent_id, messages,
                    status="running", parent_agent_id=self.parent_agent_id,
                    role=self.agent_role, task=str(input)[:2000],
                    usage=dict(usage_totals), steps_taken=steps_taken,
                )

                # ⑥ Stall guard — detect if the LLM is calling the same tools
                #    over and over with no progress.
                # Signature includes each call's ERROR KIND, not just its
                # arguments. Byte-identical matching alone misses semantic
                # thrashing — retrying `read_file` against a series of wrong
                # paths looks like progress by argument but is the same
                # not_found failure every time.
                this_signature = frozenset(
                    f"{tc.name}:{json.dumps(tc.arguments, sort_keys=True)}"
                    for tc in tool_calls_batch
                ) | frozenset(
                    f"kind:{tc.name}:{kind}"
                    for tc, _res, kind in results if kind
                )

                # A non-retriable failure repeated is always thrashing: the
                # model has been told plainly that retrying cannot help.
                _dead_ends = [
                    kind for _tc, _res, kind in results
                    if kind in ("permission_denied", "unknown_tool", "misconfigured")
                ]
                if _dead_ends:
                    messages.append({
                        "role": "user",
                        "content": (
                            f"That failed with '{_dead_ends[0]}', which retrying "
                            f"cannot fix. Take a different approach, or tell the "
                            f"user what you are unable to do and why."
                        ),
                    })
                if this_signature == last_step_signature:
                    stall_count += 1
                    if stall_count >= STALL_NUDGE_AFTER:
                        stall_nudges += 1
                        stall_count   = 0
                        last_step_signature = frozenset()

                        if stall_nudges >= MAX_STALL_NUDGES:
                            # Truly stuck — the ONLY forced stop in this loop
                            log.warning(f"Agent stuck after {MAX_STALL_NUDGES} stall nudges. Force stopping.")
                            answer = (
                                f"The agent got stuck repeating the same actions and could not make "
                                f"progress after {steps_taken} steps."
                            )
                            await self._emit(on_event, "final", {"answer": answer})
                            return self._finish(
                                "stalled", answer,
                                steps_taken, usage_totals, messages, str(input),
                            )

                        log.info(f"Stall nudge #{stall_nudges}: nudging LLM to try something different")
                        messages.append({
                            "role": "user",
                            "content": (
                                f"You have called the same tools with the same arguments {STALL_NUDGE_AFTER} "
                                "times in a row. Stop repeating yourself. Review what you have already done "
                                "and take a DIFFERENT action to move the task forward."
                            ),
                        })
                else:
                    stall_count         = 0
                    last_step_signature = this_signature

                continue  # ← back to top of loop

            # ⑦ LLM returned nothing at all (no text, no tools) — nudge and retry.
            log.warning(f"LLM returned empty response at step {steps_taken + 1}")
            messages.append({"role": "user", "content": "Please continue with the task."})
            steps_taken += 1

