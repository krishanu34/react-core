"""Execution phase — no gate (the normal permission system gates it: in
'manual' mode, mutating tools still prompt the user per call).

Walks the approved tasks.md task-by-task through the ONE agent loop. Two
operating modes, chosen automatically by SpecWorkflow:

  per-task   tasks.md is visible server-side → the workflow parses it and
             runs one focused agent turn per unchecked task, ticking the
             checkbox after each (tasks.md IS the progress state, so a
             stopped execution resumes at the first unchecked task).

  single-run tasks.md lives only on the client machine (Pattern C) → one
             agent run is instructed to read tasks.md itself and work
             through every unchecked task, ticking as it goes.

Artifacts (api.yaml, schema.json, architecture.mmd) need no special logic:
the tasks phase is prompted to include them as ordinary tasks.
"""

from typing import List, Optional

from .base import PhaseContext, SpecPhase


class ExecutionPhase(SpecPhase):
    name = "execution"
    gate = None
    produces = []                 # progress is tracked in tasks.md, not files
    allow_tools = []              # empty == FULL toolset (no strict sandbox);
                                  # run_terminal/code_edit/git all available,
                                  # subject to the request's permission_mode
    allow_write_paths = []        # writes go wherever the tasks demand
    prompt_template = "execution_all"

    def build_prompt(self, ctx: PhaseContext) -> str:
        """Single-run mode prompt (client-side workspace)."""
        return self._load_prompt(
            self.prompt_template,
            spec_dir=ctx.spec_dir,
            artifacts_dir=ctx.artifacts_dir,
        )

    def build_task_prompt(
        self,
        ctx: PhaseContext,
        task: dict,
        persona: Optional[dict] = None,
    ) -> str:
        """Per-task mode prompt. `task` comes from parsers.parse_tasks();
        `persona` is the matching agents.md entry (or None)."""
        persona_text = ""
        if persona:
            persona_text = (
                f"Adopt this persona for the task:\n"
                f"[{persona['name']}] {persona.get('description', '')}\n"
                f"{persona.get('system_prompt', '')}"
            )
        return self._load_prompt(
            "execution_task",
            task_id=task["id"],
            task_title=task["title"],
            spec_dir=ctx.spec_dir,
            artifacts_dir=ctx.artifacts_dir,
            requirements=ctx.prior_files.get(f"{ctx.spec_dir}/requirements.md", ""),
            design=ctx.prior_files.get(f"{ctx.spec_dir}/design.md", ""),
            persona=persona_text,
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        # Per-task validation is "the checkbox got ticked" — handled by the
        # workflow re-reading tasks.md. Nothing structural to check here.
        return []
