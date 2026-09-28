"""
SpecWorkflow — the phase state machine (SPEC_DRIVEN_PLAN.md §2, §7).

This class contains NO intelligence. It sequences phases, sandboxes each one
through the per-request permission system, validates outputs, and pauses at
gates. All thinking happens inside the ONE existing OrchestratorAgent that
each phase run drives with a phase-specific prompt.

    for each phase:
        1. build the phase prompt (prompts/spec/<phase>.md + prior files)
        2. bind the phase's tool/path sandbox (permission ContextVar)
        3. run OrchestratorAgent (the same loop normal chat uses)
        4. validate produced files (one self-repair round on failure)
        5. emit gate_request over SSE, await the user's decision
        6. approve → next phase | revise → re-run with feedback | abort → stop

Pattern C note: when the workspace lives on the CLIENT machine, file writes
already flow through client-delegated tools unchanged, but the server cannot
read the results back. The workflow detects that (spec dir not visible
locally) and degrades gracefully: validation is skipped (the gate review IS
the validation) and execution runs in single-run mode where the agent itself
walks tasks.md.
"""

import asyncio
import os
import re
import time
from dataclasses import replace
from pathlib import Path
from typing import Callable, List, Optional

from agents.orchestrator import OrchestratorAgent
from context.permissions import PermissionConfig, set_config
from prompts.loader import PromptLoader
from utils.logger import get_logger
from utils.naming import slugify

from .gate_broker import gate_broker
from .parsers import find_persona_for_task, parse_agents, parse_tasks, tick_task
from .phases import (
    AgentsPhase,
    DesignPhase,
    ExecutionPhase,
    PhaseContext,
    RequirementsPhase,
    RosterPhase,
    ScaffoldPhase,
    SpecPhase,
    TasksPhase,
)
from .phases.roster import ROSTER_KEY
from .spec_store import SpecWorkflowStore

log = get_logger(__name__)

# How long a gate waits for the user before the workflow pauses (resumable).
GATE_TIMEOUT = int(os.getenv("SPEC_GATE_TIMEOUT_SECONDS", "1800"))
# Keepalive interval while parked at a gate — keeps the stream watchdog
# (AGENT_STALL_TIMEOUT) from declaring the run dead during a long review.
GATE_KEEPALIVE = 60
MAX_REVISE_ROUNDS = 3
# Claude Code behaviour: a PLAN does not park for approval — it streams
# into the chat as narration and generation continues; the REAL files are
# the approval point (gate 2). Set SPEC_PLAN_APPROVAL_GATE=1 to restore an
# explicit plan-approval checkpoint (BMAD-strict mode).
PLAN_APPROVAL_GATE = os.getenv("SPEC_PLAN_APPROVAL_GATE", "0") == "1"

# ── Keyword compatibility (BMAD + GitHub Spec Kit) ──────────────────
# Message prefixes/aliases → the phase to START generation from (or the
# execution mode). Adding a vocabulary is a data change, not a code change.
#
# NOTE: plain spec_mode=generation (no keyword) runs the AGENT-BUILDER
# pipeline (roster → scaffold → BMAD-aligned agent/skill files). The
# requirements/design/tasks pipeline (GitHub Spec Kit style) is the LEGACY
# path, still reachable through these keywords.
KEYWORD_MAP = {
    # GitHub Spec Kit commands (legacy spec pipeline)
    "/specify":   ("generation", "requirements"),
    "/clarify":   ("generation", "requirements"),
    "/plan":      ("generation", "design"),
    "/tasks":     ("generation", "tasks"),
    "/implement": ("execution", None),
    # Agent-builder (explicit alias for the default)
    "/agents":    ("generation", "roster"),
    # BMAD personas
    "@analyst":   ("generation", "requirements"),
    "@pm":        ("generation", "requirements"),
    "@architect": ("generation", "design"),
    "@sm":        ("generation", "tasks"),
    "@po":        ("generation", "tasks"),
    "@dev":       ("execution", None),
    "@qa":        ("execution", None),
}


def resolve_start(message: str, spec_mode: str) -> tuple:
    """(mode, start_phase) — a leading keyword refines the UI dropdown choice
    (e.g. '/plan redesign the API' starts generation at the design phase)."""
    first_word = (message.strip().split() or [""])[0].lower()
    if first_word in KEYWORD_MAP:
        return KEYWORD_MAP[first_word]
    return spec_mode, None


# ── Target convention (agent builder) ───────────────────────────────
# Which tool's folder convention the scaffold writes. DEFAULT is
# .devaccel (this product's workspace); the others apply ONLY when the
# user names them in the message — the workflow never asks.
_TARGET_HINTS = [
    ("bmad",     re.compile(r"\bbmad\b|\.agents/skills", re.IGNORECASE)),
    ("claude",   re.compile(r"\bclaude\b|\.claude\b", re.IGNORECASE)),
    ("copilot",  re.compile(r"\bcopilot\b|\.github/agents|chatmode", re.IGNORECASE)),
    ("devaccel", re.compile(r"\bdevaccel\b|\bdevsphere\b|\.devaccel\b", re.IGNORECASE)),
]


# Names for the emergency fallback plan only — the LLM picks a fitting one on
# every normal path. Chosen deterministically from the feature slug so a
# re-run of the same request recovers the same person rather than a new
# stranger.
_FALLBACK_PERSONAS = [
    "Avery", "Blake", "Casey", "Devon", "Ellis", "Finley",
    "Harper", "Jordan", "Kai", "Lennox", "Morgan", "Noor",
]


def _fallback_persona_name(slug: str) -> str:
    return _FALLBACK_PERSONAS[sum(ord(c) for c in slug) % len(_FALLBACK_PERSONAS)]


def detect_target(message: str) -> Optional[str]:
    """The target convention the user named in the message, or None."""
    for target, pattern in _TARGET_HINTS:
        if pattern.search(message or ""):
            return target
    return None


# Naming: the LLM proposes the feature slug (utils/naming.py slugify is the
# deterministic fallback). A valid slug is 1-4 kebab-case words.
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){0,3}$")
# A 4-word kebab slug is well under 10 tokens; headroom for stray formatting.
NAME_MAX_TOKENS = 24


class SpecWorkflow:

    # Default generation = AGENT BUILDER (BMAD-aligned): propose a roster,
    # gate, then scaffold one file per agent + one folder per skill.
    GENERATION_PHASES: List[type] = [
        RosterPhase, ScaffoldPhase,
    ]
    # Legacy Spec-Kit pipeline — reachable via /specify, /plan, /tasks and
    # the BMAD persona keywords (KEYWORD_MAP sets start_phase accordingly).
    LEGACY_GENERATION_PHASES: List[type] = [
        RequirementsPhase, DesignPhase, TasksPhase, AgentsPhase,
    ]

    def __init__(
        self,
        thread_id: str,
        workspace: str,               # tools_root — the user's project root
        llm,
        tool_registry,                # the registry agent_stream already built
        memory,                       # thread long-term memory
        token_tracker,
        context_window: int,
        base_permission_config: PermissionConfig,  # the REQUEST's own config,
                                                   # restored for execution
        store: Optional[SpecWorkflowStore] = None,
        client_tools: Optional[set] = None,        # Pattern C — tool names the
                                                   # CLIENT executes locally
    ):
        self.thread_id = thread_id
        self.workspace = workspace
        self.llm = llm
        self.tool_registry = tool_registry
        self.memory = memory
        self.token_tracker = token_tracker
        self.context_window = context_window
        self.base_permission_config = base_permission_config
        self.store = store or SpecWorkflowStore()
        self.client_tools = client_tools or set()
        self._usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        # Claude Code-style structured plan handoff: the roster phase ends
        # by CALLING submit_plan (schema enforced by native function
        # calling) instead of formatting its answer as parseable text.
        # Registered here so it exists ONLY for spec runs — normal chat
        # turns never see it. The text-parsing ladder stays as fallback.
        from tools.submit_plan_tool import SubmitPlanTool
        self._plan_tool = SubmitPlanTool(workspace)
        if tool_registry is not None and tool_registry.get("submit_plan") is None:
            tool_registry._tools.append(self._plan_tool)
            tool_registry._by_name[self._plan_tool.name] = self._plan_tool

    # ── Public entry points (called from router/agent_stream.py) ─────

    async def run_generation(
        self,
        user_request: str,
        memory_context: str,
        on_event: Callable,
        should_stop: Callable[[], bool],
        start_phase: Optional[str] = None,
        feature: Optional[str] = None,
    ) -> dict:
        """GENERATION. Default pipeline (agent builder, BMAD-aligned):
        roster → gate1 → scaffold → gate2, producing
        .devaccel/agents/<name>.md + .devaccel/skills/<name>/SKILL.md.
        Legacy pipeline (Spec Kit): requirements → design → tasks → agents,
        selected when start_phase names one of its phases (keywords).
        Returns an agent-loop-shaped result dict so agent_stream's
        run_summary handling works unchanged."""
        # Name the feature from the request's DOMAIN (LLM first, heuristic
        # fallback) unless the caller already pinned one ('001-user-auth').
        slug = None if feature else await self._resolve_feature_slug(user_request)
        ctx = self._make_context(user_request, feature, slug=slug)

        legacy_names = [cls.name for cls in self.LEGACY_GENERATION_PHASES]
        if start_phase and start_phase in legacy_names:
            phases = [cls() for cls in self.LEGACY_GENERATION_PHASES]
            phases = phases[legacy_names.index(start_phase):]
        else:
            phases = [cls() for cls in self.GENERATION_PHASES]
            builder_names = [p.name for p in phases]
            if start_phase in builder_names:  # e.g. /agents alias
                phases = phases[builder_names.index(start_phase):]

            # Agent builder — which folder convention should the output use?
            # DEFAULT: .devaccel (this product's workspace). Only when the
            # user NAMES another convention in the message (claude /
            # copilot / bmad keywords) does the output go there instead —
            # no question asked. The roster records the choice in its
            # `type: config` block for revise rounds and re-runs.
            target = detect_target(user_request)
            if target:
                ctx.target = target  # else PhaseContext default: "devaccel"

        self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                          phases[0].name, "running")

        phases_run = 0
        for phase in phases:
            if should_stop():
                return self._result("stopped", "spec_generation", phases_run, ctx)

            outcome = await self._run_gated_phase(
                phase, ctx, memory_context, on_event, should_stop
            )
            phases_run += 1
            if outcome != "approved":
                # "aborted" | "awaiting_gate" | "failed" | "stopped"
                return self._result(outcome, "spec_generation", phases_run, ctx)
            self._collect_prior_files(phase, ctx)

        last_phase = phases[-1].name
        self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                          last_phase, "completed")
        if last_phase == "scaffold":
            done_payload = {
                "mode": "generation",
                "feature": f"{ctx.feature_number}-{ctx.feature_slug}",
                "agents_dir": ".devaccel/agents",
                "skills_dir": ".devaccel/skills",
                "message": "Agent(s) and skills scaffolded under "
                           ".devaccel/agents/ and .devaccel/skills/. "
                           "Switch the Spec dropdown to Execution and pick "
                           "the agent to run it.",
            }
        else:
            done_payload = {
                "mode": "generation",
                "feature": f"{ctx.feature_number}-{ctx.feature_slug}",
                "spec_dir": ctx.spec_dir,
                "message": "All phases approved. Review the files, then start "
                           "the execution phase when ready.",
            }
        await on_event("spec_workflow_done", done_payload)
        return self._result("done", "spec_generation", phases_run, ctx)

    async def run_execution(
        self,
        memory_context: str,
        on_event: Callable,
        should_stop: Callable[[], bool],
        feature: str,
        user_request: str = "",
    ) -> dict:
        """EXECUTION: walk the approved tasks.md. Per-task mode when the
        server can read the workspace; single-run mode otherwise."""
        ctx = self._make_context(user_request or f"execute {feature}", feature)
        self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                          "execution", "running")
        phase = ExecutionPhase()

        # Execution uses the REQUEST's permission config (manual/auto), not a
        # phase sandbox — mutating tools behave like any normal run.
        set_config(self.workspace, self.base_permission_config)

        tasks_path = Path(self.workspace) / ctx.spec_dir / "tasks.md"
        server_can_read = tasks_path.is_file()

        if not server_can_read:
            # Pattern C: the agent reads/ticks tasks.md itself via delegated tools.
            await on_event("spec_phase_start", {
                "phase": "execution", "mode": "single-run",
                "feature": f"{ctx.feature_number}-{ctx.feature_slug}",
            })
            result = await self._run_agent(phase.build_prompt(ctx), memory_context,
                                           on_event, should_stop)
            status = "done" if result.get("status") == "done" else result.get("status", "failed")
            self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                              "execution", "completed" if status == "done" else status)
            return self._result(status, "spec_execution", 1, ctx)

        # Per-task mode — tasks.md IS the progress state: a stopped run
        # resumes at the first unchecked task next time.
        self._collect_prior_files(None, ctx)  # requirements/design for prompts
        agents_md = phase._read_local(self.workspace, f"{ctx.agents_dir}/agents.md")
        personas = parse_agents(agents_md) if agents_md else []

        done_count = 0
        while True:
            if should_stop():
                self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                                  "execution", "paused")
                return self._result("stopped", "spec_execution", done_count, ctx)

            content = tasks_path.read_text(encoding="utf-8", errors="replace")
            pending = [t for t in parse_tasks(content) if not t["done"]]
            if not pending:
                break
            task = pending[0]

            await on_event("spec_task_start", {"id": task["id"], "title": task["title"],
                                               "phase": task["phase"]})
            prompt = phase.build_task_prompt(
                ctx, task, find_persona_for_task(personas, task["id"])
            )
            result = await self._run_agent(prompt, memory_context, on_event, should_stop)

            # The prompt asks the agent to tick its own checkbox; if it forgot
            # (or ran out of steps) the workflow ticks it, so one flaky turn
            # can't wedge the loop on the same task forever.
            content = tasks_path.read_text(encoding="utf-8", errors="replace")
            still_open = any(t["id"] == task["id"] and not t["done"]
                             for t in parse_tasks(content))
            if still_open:
                if result.get("status") == "done":
                    tasks_path.write_text(tick_task(content, task["id"]), encoding="utf-8")
                else:
                    # Agent failed/stopped on this task — don't tick, don't loop.
                    await on_event("spec_task_done", {
                        "id": task["id"], "status": "blocked",
                        "detail": (result.get("answer") or "")[:300],
                    })
                    self.store.upsert(self.thread_id, ctx.feature_slug,
                                      ctx.feature_number, "execution", "paused")
                    return self._result("failed", "spec_execution", done_count, ctx)

            done_count += 1
            await on_event("spec_task_done", {"id": task["id"], "status": "done"})

        self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                          "execution", "completed")
        await on_event("spec_workflow_done", {
            "mode": "execution",
            "feature": f"{ctx.feature_number}-{ctx.feature_slug}",
            "tasks_completed": done_count,
        })
        return self._result("done", "spec_execution", done_count, ctx)

    # ── One gated phase ───────────────────────────────────────────────

    async def _run_gated_phase(self, phase: SpecPhase, ctx: PhaseContext,
                               memory_context: str, on_event, should_stop) -> str:
        """Run phase → validate → gate. Returns 'approved' | 'aborted' |
        'awaiting_gate' | 'awaiting_input' (agent asked the user a
        clarification — reply re-enters generation) | 'failed' | 'stopped'."""
        for round_no in range(1 + MAX_REVISE_ROUNDS):
            self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                              phase.name, "running")
            await on_event("spec_phase_start", {
                "phase": phase.name, "gate": phase.gate,
                "feature": f"{ctx.feature_number}-{ctx.feature_slug}",
                "round": round_no + 1,
            })

            # Phase sandbox: ALL tools are available (spec phases behave like
            # a normal agent turn — ask_user, web_search, run_terminal
            # included); the phase adds ONE restriction, the WRITE FENCE, so
            # file writes land inside the phase's output folders.
            #
            # The fence is LAYERED ONTO the request's own config rather than
            # replacing it. Hard-coding mode="auto" here meant spec mode
            # silently ran unattended: a user who picked manual still got
            # every phase editing and executing without a single approval
            # prompt, which is the opposite of what they asked for. The
            # user's mode and the operator's allow/deny lists survive; only
            # the write fence is phase-specific.
            _phase_cfg = replace(
                self.base_permission_config,
                allow_write_paths=list(phase.allow_write_paths),
            )
            set_config(self.workspace, _phase_cfg)

            # Fresh capture window for the structured plan handoff.
            if not phase.produces_files:
                self._plan_tool.reset()

            # Track whether the phase agent raised an ask_user clarification —
            # the card is already rendered by the event; the phase must then
            # end CLEANLY (no validation failure) so the user's reply can
            # re-enter generation as the next message on this thread.
            asked = {"clarify": False}

            async def phase_event(event_type: str, data: dict):
                if event_type == "ask_user":
                    asked["clarify"] = True
                await on_event(event_type, data)

            result = await self._run_agent(phase.build_prompt(ctx), memory_context,
                                           phase_event, should_stop)
            if result.get("status") == "stopped":
                return "stopped"
            if asked["clarify"]:
                self.store.upsert(self.thread_id, ctx.feature_slug,
                                  ctx.feature_number, phase.name, "awaiting_input")
                return "awaiting_input"

            # Structural validation + ONE self-repair attempt. File phases
            # check the workspace (skipped for client-side workspaces — the
            # gate review covers it); answer phases (roster/plan, Claude
            # Code plan-mode style) first NORMALIZE the answer — the agent
            # loop's final answers drift into prose, so the plan is made
            # machine-parseable deterministically (code fix for a missing
            # config block; one direct temperature-0 formatting call when
            # no blocks parse at all) before validation ever sees it.
            if phase.produces_files:
                problems = self._validate_if_visible(phase, ctx)
            else:
                plan = await self._plan_from_run(ctx, result.get("answer") or "")
                result = dict(result)
                result["answer"] = plan
                problems = phase.validate_answer(plan)
            if problems:
                repair = ("Validation of your output found problems:\n- "
                          + "\n- ".join(problems)
                          + ("\nFix them now by rewriting the affected file(s)."
                             if phase.produces_files else
                             "\nSubmit the corrected plan now with ONE "
                             "submit_plan tool call."))
                if not phase.produces_files:
                    self._plan_tool.reset()
                repair_result = await self._run_agent(repair, memory_context,
                                                      on_event, should_stop)
                if phase.produces_files:
                    problems = self._validate_if_visible(phase, ctx)
                else:
                    plan = await self._plan_from_run(
                        ctx, repair_result.get("answer") or "")
                    problems = phase.validate_answer(plan)
                    if not problems:
                        result = dict(repair_result)
                        result["answer"] = plan  # the repaired answer IS the plan
                if problems:
                    await on_event("error", {"message":
                        f"Phase '{phase.name}' failed validation: {problems}"})
                    self.store.upsert(self.thread_id, ctx.feature_slug,
                                      ctx.feature_number, phase.name, "failed")
                    return "failed"

            # Answer phases: carry the (normalized) plan in memory to the
            # next phase — nothing is written to the workspace at this gate.
            if not phase.produces_files:
                ctx.prior_files[ROSTER_KEY] = result.get("answer") or ""

                if not PLAN_APPROVAL_GATE:
                    # Default (Claude Code style): don't park on the plan —
                    # the user already saw it stream into the chat; the
                    # generated FILES are the approval point at the next
                    # gate, where "revise" still covers plan-level changes.
                    self.store.record_gate(self.thread_id, ctx.feature_number,
                                           phase.gate,
                                           {"decision": "auto-approved"})
                    ctx.revision_feedback = None
                    return "approved"

            for path in phase.output_paths(ctx):
                await on_event("spec_file_generated", {"phase": phase.name, "path": path})

            decision = await self._await_gate(phase, ctx, result, on_event, should_stop)

            if decision is None:
                return "awaiting_gate"
            self.store.record_gate(self.thread_id, ctx.feature_number, phase.gate, decision)
            await on_event("gate_result", {"gate": phase.gate, **decision})

            if decision["decision"] == "approve":
                ctx.revision_feedback = None
                return "approved"
            if decision["decision"] == "abort":
                self.store.upsert(self.thread_id, ctx.feature_slug,
                                  ctx.feature_number, phase.name, "aborted")
                return "aborted"
            # revise → loop with feedback. With the plan gate auto-approved
            # the file gate is the ONLY checkpoint, so feedback may target
            # the PLAN itself ("one agent is enough", "rename the skill") —
            # apply it to the in-memory plan before the phase re-runs, so
            # the file plan and validation follow the change.
            ctx.revision_feedback = decision.get("feedback") or "Please improve the draft."
            if phase.produces_files and ctx.prior_files.get(ROSTER_KEY):
                await self._revise_plan(ctx)

        # Revise rounds exhausted — pause instead of burning more tokens; the
        # user can edit the file by hand and continue with the next phase.
        await on_event("error", {"message":
            f"Gate {phase.gate}: {MAX_REVISE_ROUNDS} revision rounds used. "
            f"Edit {phase.produces} directly, then re-run generation — approved "
            f"phases are skipped via their existing files."})
        self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                          phase.name, "paused")
        return "failed"

    async def _await_gate(self, phase, ctx, result, on_event, should_stop) -> Optional[dict]:
        """Emit gate_request and park until the user decides. Emits a
        gate_waiting keepalive every GATE_KEEPALIVE seconds so the stream
        watchdog never mistakes a human review pause for a dead run.
        None = timed out / stopped (workflow pauses as awaiting_gate)."""
        fut = gate_broker.create(self.thread_id, phase.gate)
        self.store.upsert(self.thread_id, ctx.feature_slug, ctx.feature_number,
                          phase.name, "awaiting_gate")
        await on_event("gate_request", {
            "gate": phase.gate,
            "phase": phase.name,
            "feature": f"{ctx.feature_number}-{ctx.feature_slug}",
            "files": phase.output_paths(ctx),
            # Plan phases show the WHOLE plan on the card (Claude Code plan
            # mode); file phases keep the short preview — the files are the
            # deliverable there.
            "summary": (result.get("answer") or "")[
                :getattr(phase, "gate_summary_chars", 500)],
            "decisions": ["approve", "revise", "abort"],
        })

        deadline = time.monotonic() + GATE_TIMEOUT
        while True:
            try:
                return await asyncio.wait_for(fut, timeout=GATE_KEEPALIVE)
            except asyncio.TimeoutError:
                if should_stop() or time.monotonic() > deadline:
                    gate_broker.discard(self.thread_id, phase.gate)
                    await on_event("gate_result", {
                        "gate": phase.gate, "decision": "timeout",
                        "message": "No decision received — workflow paused. "
                                   "Re-run generation on this thread to continue.",
                    })
                    return None
                await on_event("gate_waiting", {"gate": phase.gate})

    # ── Helpers ───────────────────────────────────────────────────────

    async def _run_agent(self, prompt: str, memory_context: str,
                         on_event, should_stop) -> dict:
        """One run of the ONE existing agent loop, with usage aggregation."""
        orchestrator = OrchestratorAgent(
            llm=self.llm,
            tool_registry=self.tool_registry,
            memory=self.memory,
            token_tracker=self.token_tracker,
            context_window=self.context_window,
            thread_id=self.thread_id,
        )
        result = await orchestrator.run(
            prompt,
            memory_context=memory_context,
            on_event=on_event,
            should_stop=should_stop,
        )
        usage = result.get("usage") or {}
        for key in self._usage:
            self._usage[key] += int(usage.get(key, 0) or 0)
        return result

    async def _plan_from_run(self, ctx: PhaseContext, answer: str) -> str:
        """The plan produced by a roster run. Preferred source: the
        submit_plan TOOL CALL (schema-enforced, Claude Code style) —
        converted to roster text deterministically, so it can never fail
        validation. Falls back to the text-normalization ladder when the
        model never called the tool."""
        from .parsers import roster_text_from_plan

        captured = self._plan_tool.captured
        if captured:
            log.info("Roster plan captured via submit_plan tool call")
            return roster_text_from_plan(captured, ctx.target)
        return await self._normalize_plan(ctx, answer)

    async def _normalize_plan(self, ctx: PhaseContext, answer: str) -> str:
        """Make the roster phase's answer machine-parseable WITHOUT relying
        on the agent loop's final-answer style (GPT answers drift into
        prose). Ladder, cheapest first:
          1. already parses → unchanged
          2. agents parse but the config block is missing → prepend it in
             CODE (the target is already known — no LLM involved)
          3. no parseable agent blocks → ONE direct temperature-0
             formatting call converts the draft into the strict block
             format (same pattern as _resolve_feature_slug), then step 2
          4. formatting failed/unusable → a DETERMINISTIC minimal plan
             built in code (one agent named after the feature) — the
             scaffold phase's prompt + KB expand it into a full persona.
        Never raises and NEVER returns an unparseable plan — generation
        must not hard-fail on formatting."""
        from .parsers import parse_roster

        def _ensure_config(text: str) -> str:
            parsed = parse_roster(text)
            if parsed["agents"] and not parsed.get("config", {}).get("target"):
                return (f"---\ntype: config\ntarget: {ctx.target}\n---\n\n"
                        + text)
            return text

        answer = _ensure_config((answer or "").strip())
        if parse_roster(answer)["agents"]:
            log.info("Roster plan: agent's answer parsed directly")
            return answer

        log.info("Roster plan: answer not parseable — running formatting call")
        try:
            prompt = PromptLoader.load(
                "spec/roster_format",
                draft=answer[:8000] or ctx.user_request,
                target=ctx.target,
                user_request=ctx.user_request[:1000],
            )
            text, usage = await self.llm.invoke(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=2500,
            )
            for key in self._usage:
                self._usage[key] += int((usage or {}).get(key, 0) or 0)
            # Strip a stray outer code fence before parsing.
            formatted = re.sub(r"^```[a-z]*\s*\n|\n```\s*$", "",
                               (text or "").strip())
            formatted = _ensure_config(formatted.strip())
            if parse_roster(formatted)["agents"]:
                log.info("Roster plan normalized via direct formatting call")
                return formatted
            log.warning(f"Roster plan: formatting call returned an "
                        f"unparseable reply ({(text or '')[:120]!r}) — "
                        f"using the deterministic fallback plan")
        except Exception as e:
            log.warning(f"Roster plan: formatting call failed ({e}) — "
                        f"using the deterministic fallback plan")
        return self._fallback_plan(ctx)

    def _fallback_plan(self, ctx: PhaseContext) -> str:
        """Deterministic minimal plan — always parseable, always valid.
        One agent named after the feature; the scaffold phase expands the
        persona from the request + BMAD KB. Emergency path only (logged).

        Still gets a human name: an agent the user cannot address by name is
        a worse recovery than one with an arbitrary but usable identity, and
        the scaffold prompt has nothing to build a persona section around
        otherwise."""
        name = (ctx.feature_slug if SLUG_PATTERN.match(ctx.feature_slug or "")
                else "task-agent")
        description = " ".join((ctx.user_request or "").split())[:120] \
            or "Handles the user's request end-to-end"
        persona = _fallback_persona_name(name)
        return (
            f"## Generation Plan — {name} (auto-recovered minimal plan)\n\n"
            f"---\ntype: config\ntarget: {ctx.target}\n---\n\n"
            f"---\nname: {name}\n"
            f"persona: {persona}\n"
            f"title: {name.replace('-', ' ').title()} Lead\n"
            f"description: {description}. Use when the user asks about this, "
            f"or asks to talk to {persona}.\n"
            f"tools: read_file, grep_search, file_write, code_edit, run_terminal\n"
            f"---\n"
            f"# {persona}\n\n"
            f"You own this request end-to-end: {description}. Study the "
            f"project first, work in small verified steps, follow the "
            f"project's conventions, and present your results for review.\n"
        )

    async def _revise_plan(self, ctx: PhaseContext) -> None:
        """Apply gate-2 revise feedback to the in-memory plan (one direct
        temperature-0 call). The prompt returns the plan UNCHANGED when the
        feedback is content-only; a reply that doesn't parse keeps the old
        plan. Never raises."""
        from .parsers import parse_roster

        try:
            prompt = PromptLoader.load(
                "spec/roster_revise",
                plan=(ctx.prior_files.get(ROSTER_KEY) or "")[:8000],
                feedback=(ctx.revision_feedback or "")[:2000],
                target=ctx.target,
            )
            text, usage = await self.llm.invoke(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=2500,
            )
            for key in self._usage:
                self._usage[key] += int((usage or {}).get(key, 0) or 0)
            formatted = re.sub(r"^```[a-z]*\s*\n|\n```\s*$", "",
                               (text or "").strip()).strip()
            if parse_roster(formatted)["agents"]:
                ctx.prior_files[ROSTER_KEY] = formatted
        except Exception as e:
            log.warning(f"Plan revise skipped ({e}) — keeping the current plan")

    async def _resolve_feature_slug(self, user_request: str) -> str:
        """Semantic feature name, the way Claude Code names things: the model
        reads the request and answers with a kebab-case domain slug
        ('user-login-otp' for 'I want to create a login page with OTP').
        Falls back to the stopword heuristic when the LLM is unreachable or
        answers off-format, so generation never blocks on naming."""
        try:
            prompt = PromptLoader.load("spec/feature_name",
                                       user_request=user_request[:500])
            text_out, usage = await self.llm.invoke(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=NAME_MAX_TOKENS,
            )
            for key in self._usage:
                self._usage[key] += int((usage or {}).get(key, 0) or 0)
            candidate = (text_out or "").strip().strip("`'\"").rstrip(".").lower()
            if SLUG_PATTERN.match(candidate):
                return candidate
            log.warning(f"Feature naming: off-format LLM reply {candidate!r}, "
                        f"using heuristic slug")
        except Exception as e:
            log.warning(f"Feature naming: LLM call failed ({e}), using heuristic slug")
        return slugify(user_request)

    def _make_context(self, user_request: str, feature: Optional[str],
                      slug: Optional[str] = None) -> PhaseContext:
        """Resolve feature number+slug: explicit param ('001-user-auth') wins;
        else the semantic slug computed for this run; number from the
        workspace (server-visible) or the store."""
        if feature:
            number, _, f_slug = feature.partition("-")
            f_slug = f_slug or slug or slugify(user_request)
        else:
            f_slug = slug or slugify(user_request)
            number = self._next_number()
        return PhaseContext(
            feature_slug=f_slug,
            feature_number=number,
            user_request=user_request,
            spec_dir=f".devaccel/spec/{number}-{f_slug}",
            agents_dir=f".devaccel/agents/{number}-{f_slug}",
            artifacts_dir=f".devaccel/artifacts/{number}-{f_slug}",
            # Lets a phase see what is ALREADY on disk. Empty string when the
            # workspace is client-side, where _read_local returns None and the
            # phase falls back to planning the file (the agent then reads and
            # merges it, per the scaffold prompt).
            workspace=self.workspace or "",
        )

    def _next_number(self) -> str:
        spec_root = Path(self.workspace) / ".devaccel" / "spec"
        try:
            if spec_root.is_dir():
                numbers = [int(m.group(1)) for d in spec_root.iterdir()
                           if (m := re.match(r"^(\d{3})-", d.name))]
                return f"{max(numbers, default=0) + 1:03d}"
        except OSError:
            pass
        return self.store.next_feature_number(self.thread_id)

    def _validate_if_visible(self, phase: SpecPhase, ctx: PhaseContext) -> List[str]:
        """Run phase validation only when the phase's files were written on
        THIS machine. When file_write is client-delegated (Pattern C), the
        files land on the USER's machine — the server can't see them, so a
        server-side check would always (wrongly) report them missing. The
        human gate review covers validation in that case."""
        if "file_write" in self.client_tools:
            return []
        return phase.validate_outputs(self.workspace, ctx)

    def _collect_prior_files(self, phase: Optional[SpecPhase], ctx: PhaseContext):
        """Inline every spec file the server can read into ctx.prior_files so
        later phases' prompts carry them. Re-read from DISK each time — user
        edits between gates deliberately win over what the agent generated."""
        candidates = [f"{ctx.spec_dir}/requirements.md",
                      f"{ctx.spec_dir}/design.md",
                      f"{ctx.spec_dir}/tasks.md"]
        # (the agent-builder roster is NOT a file — the approved plan is
        # already in ctx.prior_files[ROSTER_KEY], set at gate 1)
        for rel in candidates:
            content = SpecPhase._read_local(self.workspace, rel)
            if content is not None:
                ctx.prior_files[rel] = content

    def _result(self, status: str, route: str, steps: int, ctx: PhaseContext) -> dict:
        """Shape matches OrchestratorAgent results so agent_stream's
        run_summary / memory handling needs no special-casing."""
        return {
            "status": status,
            "route": route,
            "steps_taken": steps,
            "answer": f"Spec workflow ({route}) finished with status '{status}' "
                      f"for feature {ctx.feature_number}-{ctx.feature_slug}.",
            "usage": dict(self._usage),
            "run_state": None,
        }
