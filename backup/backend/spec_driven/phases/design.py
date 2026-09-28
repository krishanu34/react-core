"""Design phase — gate 2. Produces design.md from the approved requirements
(GitHub Spec Kit's /plan step; BMAD's architect persona)."""

from typing import List

from .base import PhaseContext, SpecPhase
from .requirements import READ_TOOLS


class DesignPhase(SpecPhase):
    name = "design"
    gate = "gate2"
    produces = ["design.md"]
    allow_tools = READ_TOOLS + ["file_write"]
    allow_write_paths = ["*.devaccel/spec/*"]
    prompt_template = "design"

    def build_prompt(self, ctx: PhaseContext) -> str:
        return self._load_prompt(
            self.prompt_template,
            user_request=ctx.user_request,
            spec_dir=ctx.spec_dir,
            requirements=ctx.prior_files.get(
                f"{ctx.spec_dir}/requirements.md",
                f"(not inlined — read {ctx.spec_dir}/requirements.md with read_file first)",
            ),
            revision_feedback=ctx.revision_feedback or "None — first draft.",
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        problems = []
        content = self._read_local(workspace, f"{ctx.spec_dir}/design.md")
        if content is None:
            problems.append(f"{ctx.spec_dir}/design.md was not created")
        else:
            for heading in ("## Architecture", "## Data Model"):
                if heading not in content:
                    problems.append(f"design.md is missing the '{heading}' section")
        return problems
