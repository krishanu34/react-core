"""Tasks phase — gate 3. Produces tasks.md: the ordered, checkbox-tracked
work breakdown the execution phase walks (GitHub Spec Kit's /tasks step;
BMAD's scrum-master story files)."""

from typing import List

from .base import PhaseContext, SpecPhase
from .requirements import READ_TOOLS


class TasksPhase(SpecPhase):
    name = "tasks"
    gate = "gate3"
    produces = ["tasks.md"]
    allow_tools = READ_TOOLS + ["file_write"]
    allow_write_paths = ["*.devaccel/spec/*"]
    prompt_template = "tasks"

    def build_prompt(self, ctx: PhaseContext) -> str:
        return self._load_prompt(
            self.prompt_template,
            spec_dir=ctx.spec_dir,
            artifacts_dir=ctx.artifacts_dir,
            requirements=ctx.prior_files.get(
                f"{ctx.spec_dir}/requirements.md",
                f"(read {ctx.spec_dir}/requirements.md with read_file first)",
            ),
            design=ctx.prior_files.get(
                f"{ctx.spec_dir}/design.md",
                f"(read {ctx.spec_dir}/design.md with read_file first)",
            ),
            revision_feedback=ctx.revision_feedback or "None — first draft.",
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        problems = []
        content = self._read_local(workspace, f"{ctx.spec_dir}/tasks.md")
        if content is None:
            problems.append(f"{ctx.spec_dir}/tasks.md was not created")
        else:
            from spec_driven.parsers import parse_tasks
            if not parse_tasks(content):
                problems.append(
                    "tasks.md contains no parseable tasks — every task must be a "
                    "markdown checkbox line like '- [ ] T001 Description'"
                )
        return problems
