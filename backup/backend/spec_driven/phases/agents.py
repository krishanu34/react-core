"""Agents phase — gate 4. Produces agents.md + skills.md: BMAD-style custom
agent roster the UI displays and the execution phase can delegate to via the
existing sub_agent tool."""

from typing import List

from .base import PhaseContext, SpecPhase
from .requirements import READ_TOOLS


class AgentsPhase(SpecPhase):
    name = "agents"
    gate = "gate4"
    # These live under the FEATURE's agents folder
    # (.devaccel/agents/<NNN-slug>/) — output_paths() below resolves them
    # against ctx.agents_dir, which SpecWorkflow names per feature.
    produces = ["agents.md", "skills.md"]
    allow_tools = READ_TOOLS + ["file_write"]
    # The glob matches per-feature subfolders too (permissions' '*' spans '/').
    allow_write_paths = ["*.devaccel/agents/*"]
    prompt_template = "agents"

    def output_paths(self, ctx: PhaseContext) -> List[str]:
        # Not spec_dir like other phases — the roster lives in agents_dir.
        return [f"{ctx.agents_dir}/{name}" for name in self.produces]

    def build_prompt(self, ctx: PhaseContext) -> str:
        return self._load_prompt(
            self.prompt_template,
            agents_dir=ctx.agents_dir,
            spec_dir=ctx.spec_dir,
            design=ctx.prior_files.get(
                f"{ctx.spec_dir}/design.md",
                f"(read {ctx.spec_dir}/design.md with read_file first)",
            ),
            tasks=ctx.prior_files.get(
                f"{ctx.spec_dir}/tasks.md",
                f"(read {ctx.spec_dir}/tasks.md with read_file first)",
            ),
            revision_feedback=ctx.revision_feedback or "None — first draft.",
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        problems = []
        content = self._read_local(workspace, f"{ctx.agents_dir}/agents.md")
        if content is None:
            problems.append(f"{ctx.agents_dir}/agents.md was not created")
        else:
            from spec_driven.parsers import parse_agents
            if not parse_agents(content):
                problems.append(
                    "agents.md contains no parseable agents — each agent needs a "
                    "frontmatter block with at least 'name:' and 'description:'"
                )
        if self._read_local(workspace, f"{ctx.agents_dir}/skills.md") is None:
            problems.append(f"{ctx.agents_dir}/skills.md was not created")
        return problems
