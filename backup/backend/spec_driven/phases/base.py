"""
SpecPhase — one step of the spec-driven workflow (SPEC_DRIVEN_PLAN.md §4).

A phase is a RECIPE, not a loop: it says what prompt to run, which tools the
agent may use while running it, which files must exist afterwards, and which
gate (if any) must be approved before the workflow moves on. The actual
thinking is done by the ONE existing OrchestratorAgent that SpecWorkflow
drives with this recipe — there is no second agent loop.

To add a new phase:
  1. subclass SpecPhase and fill in the class attributes
  2. implement build_prompt() and validate_outputs()
  3. add the class to SpecWorkflow.GENERATION_PHASES (order matters)
  4. write its prompt template in prompts/spec/<name>.md
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class PhaseContext:
    """Everything a phase may need to build its prompt.

    prior_files maps a workspace-relative path -> file content for files that
    earlier phases produced (e.g. the design phase gets requirements.md), so
    a phase's prompt carries them without the agent re-reading the workspace.
    Files the server cannot read (Pattern C client workspaces) simply won't
    appear here — the prompt then tells the agent to read them itself with
    its (client-delegated) read_file tool.

    revision_feedback is set when the user answered a gate with "revise":
    the same phase re-runs with this feedback appended to its prompt.
    """
    feature_slug: str                      # "user-auth"
    feature_number: str                    # "001"
    user_request: str                      # the original chat message
    spec_dir: str                          # ".devaccel/spec/001-user-auth"
    agents_dir: str = ".devaccel/agents"   # SpecWorkflow._make_context overrides
                                           # this per feature, e.g.
                                           # ".devaccel/agents/001-user-auth"
    artifacts_dir: str = ""                # ".devaccel/artifacts/001-user-auth"
    # Agent-builder pipeline — which folder convention the scaffold writes:
    # "devaccel" (ours, the DEFAULT) | "claude" | "copilot" | "bmad".
    # Only a keyword in the user's message selects a non-default target;
    # the roster's `type: config` block persists the choice for revise
    # rounds and re-runs.
    target: str = "devaccel"
    # Absolute path to the user's project, when the SERVER can see it. Empty
    # for a client-side workspace (Pattern C). Phases use it to check what is
    # already on disk — a scaffold must not plan to rewrite a shared config
    # that earlier work put there.
    workspace: str = ""
    prior_files: Dict[str, str] = field(default_factory=dict)
    revision_feedback: Optional[str] = None


class SpecPhase(ABC):

    # ── Recipe (override in subclasses) ──────────────────────────────
    name: str = ""                 # "requirements" — key used in spec.yaml/DB
    gate: Optional[str] = None     # "gate1" | None (execution has no gate —
                                   # the normal permission system gates it)
    produces: List[str] = []       # files that MUST exist when the phase ends,
                                   # relative to spec_dir (or absolute-relative
                                   # to the workspace when starting with
                                   # ".devaccel/"). validate_outputs() checks
                                   # them; SpecWorkflow gives the agent ONE
                                   # self-repair round if any are missing.
    allow_tools: List[str] = []    # documentation of the tools a phase is
                                   # EXPECTED to use — NOT enforced: spec
                                   # phases run with the FULL toolset (like
                                   # a normal turn); only the write fence
                                   # below restricts them
    allow_write_paths: List[str] = []  # glob fence for WRITES only; reads stay
                                       # free so the agent can study the project
    prompt_template: str = ""      # filename under prompts/spec/ (no .md)
    # False → the phase's deliverable is its ANSWER TEXT, shown in the gate
    # card (Claude Code plan-mode style), not files on disk. The workflow
    # then validates via validate_answer() instead of validate_outputs().
    produces_files: bool = True

    # ── Contract (implement in subclasses) ───────────────────────────

    @abstractmethod
    def build_prompt(self, ctx: PhaseContext) -> str:
        """Render the phase's agent input from its template + context."""

    @abstractmethod
    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        """Return a list of problems (empty list == ok).

        SpecWorkflow feeds problems back to the agent for ONE self-repair
        attempt before failing the phase. Keep checks structural (file
        exists, required headings present, tasks parse) — judging content
        QUALITY is the human's job at the gate.

        When the workspace lives on the client machine (Pattern C) the files
        aren't visible server-side; SpecWorkflow detects that and skips
        validation entirely, so implementations may assume local visibility.
        """

    def validate_answer(self, answer: str) -> List[str]:
        """Structural checks for produces_files=False phases — the answer
        text IS the deliverable. Default: no checks."""
        return []

    # ── Shared helpers ────────────────────────────────────────────────

    def output_paths(self, ctx: PhaseContext) -> List[str]:
        """Workspace-relative paths of this phase's output files."""
        resolved = []
        for name in self.produces:
            # Entries that already carry a .devaccel/ prefix are absolute
            # within the workspace (agents.md); bare names live in spec_dir.
            resolved.append(name if name.startswith(".devaccel/") else f"{ctx.spec_dir}/{name}")
        return resolved

    @staticmethod
    def _read_local(workspace: str, rel_path: str) -> Optional[str]:
        """Read a workspace file if it's visible on THIS machine, else None."""
        try:
            p = Path(workspace) / rel_path
            if p.is_file():
                return p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
        return None

    @staticmethod
    def _load_prompt(template: str, **variables) -> str:
        from prompts.loader import PromptLoader
        return PromptLoader.load(f"spec/{template}", **variables)
