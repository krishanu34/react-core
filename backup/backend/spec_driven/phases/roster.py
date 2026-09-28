"""Roster phase — agent-builder gate 1, Claude Code plan-mode style.

The roster is a PLAN presented IN THE CHAT for approval — no file is
written to the workspace (that's what BMAD's planner agents and Claude
Code's plan mode both do: plan first, in conversation; files only after
approval). The phase runs READ-ONLY: it studies the project and answers
with the roster in the strict stacked-frontmatter format; the workflow
shows that answer on the gate card, and after approval carries it in
memory (ctx.prior_files[ROSTER_KEY]) into the scaffold phase."""

from typing import List

from .base import PhaseContext, SpecPhase
from .requirements import READ_TOOLS

# ctx.prior_files key holding the approved plan text — a virtual key, not
# a workspace path (nothing is written to disk at gate 1).
ROSTER_KEY = "(roster-plan)"


class RosterPhase(SpecPhase):
    name = "roster"
    gate = "gate1"
    produces = []                # nothing on disk — the ANSWER is the plan
    produces_files = False
    allow_tools = list(READ_TOOLS)   # read-only: study, don't touch
    allow_write_paths = []
    prompt_template = "roster"
    # The gate card shows the WHOLE plan (Claude Code plan-mode style),
    # not a 500-char preview.
    gate_summary_chars = 4000

    def build_prompt(self, ctx: PhaseContext) -> str:
        from prompts.loader import PromptLoader

        from .scaffold import TARGET_LAYOUTS, resolve_target

        target = resolve_target(ctx.target)
        layout = TARGET_LAYOUTS[target]
        return self._load_prompt(
            self.prompt_template,
            user_request=ctx.user_request,
            target=target,
            target_agent_path=layout["agent"][0][1].format(name="<name>"),
            target_skill_path=layout["skill"][0][1].format(name="<name>"),
            bmad_kb=PromptLoader.load("spec/bmad_kb"),
            revision_feedback=ctx.revision_feedback or "None — first draft.",
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        return []  # nothing on disk to validate — see validate_answer

    def validate_answer(self, answer: str) -> List[str]:
        from spec_driven.parsers import parse_roster

        roster = parse_roster(answer or "")
        problems = []
        if not roster.get("config", {}).get("target"):
            problems.append(
                "the plan is missing the 'type: config' block that records "
                "the target convention (target: devaccel | claude | copilot "
                "| bmad)"
            )
        if not roster["agents"]:
            problems.append(
                "the plan contains no parseable agents — each agent needs a "
                "frontmatter block with at least 'name:' and 'description:'"
            )
        skill_names = {s["name"] for s in roster["skills"]}
        for agent in roster["agents"]:
            missing = [s for s in agent["skills"] if s not in skill_names]
            if missing:
                problems.append(
                    f"agent '{agent['name']}' references undefined skill(s) "
                    f"{missing} — add a matching 'type: skill' block for each"
                )
        return problems
