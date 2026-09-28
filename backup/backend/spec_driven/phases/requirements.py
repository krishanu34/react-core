"""Requirements phase — gate 1. Produces requirements.md (GitHub Spec Kit's
/specify step; BMAD's analyst/pm persona)."""

from typing import List

from .base import PhaseContext, SpecPhase

# Base tools every generation phase gets: the agent must be able to study
# the real project before writing about it (Narrowing Funnel), and to ASK
# the user when the request is ambiguous — ask_user is side-effect-free
# and renders the clarification card in the chat; SpecWorkflow detects it
# and ends the phase cleanly so the user's reply re-enters generation.
READ_TOOLS = [
    "read_file", "grep_search", "file_search", "list_directory",
    "workspace_tree", "batch_read_files", "project_context",
    "ask_user",
]


class RequirementsPhase(SpecPhase):
    name = "requirements"
    gate = "gate1"
    produces = ["requirements.md"]
    # NOTE: the write tool's registry name is "file_write" (write_file_tool.py)
    allow_tools = READ_TOOLS + ["file_write"]
    # Writes are fenced to the spec folder — this phase can READ source code
    # but physically cannot modify it.
    allow_write_paths = ["*.devaccel/spec/*"]
    prompt_template = "requirements"

    def build_prompt(self, ctx: PhaseContext) -> str:
        return self._load_prompt(
            self.prompt_template,
            user_request=ctx.user_request,
            feature_slug=ctx.feature_slug,
            spec_dir=ctx.spec_dir,
            revision_feedback=ctx.revision_feedback or "None — first draft.",
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        problems = []
        content = self._read_local(workspace, f"{ctx.spec_dir}/requirements.md")
        if content is None:
            problems.append(f"{ctx.spec_dir}/requirements.md was not created")
        else:
            for heading in ("## User Stories", "## Acceptance Criteria"):
                if heading not in content:
                    problems.append(f"requirements.md is missing the '{heading}' section")
        return problems
