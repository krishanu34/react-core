"""
Thread Workspace Paths

Every thread gets isolated folders for uploads and scratch space, BUT
tools operate on the ACTUAL PROJECT DIRECTORY (project_root), not the
sandbox. This is how Claude Code, Copilot, and every real coding agent
works — the user says "analyze my workspace" and means THEIR code,
not an empty sandbox.

Directory layout:
    project_root/                  <- WHERE TOOLS ACTUALLY WORK
        agents/
        tools/
        ...actual user code...

    .devaccel/{thread_id}/         <- per-thread state only
        input/                     <- user uploads
        workspace/                 <- agent scratch space
        output/                    <- final deliverables
        tmp/                       <- context spill + checkpoints (see
                                      context/context_spill.py); deleted on
                                      success, kept after a stop/crash so the
                                      run can resume
        long_term_memory.json      <- persistent memory

Why separate project_root from .devaccel/?
    - project_root is the real codebase the user wants to analyze,
      edit, search, and run commands in. Every read/list/grep/search
      tool targets this directory.
    - .devaccel/ is for per-thread isolation: uploaded files, scratch
      space for agent-generated temporary files, and deliverables.
      The user never directly interacts with .devaccel/.

How project_root is determined:
    - Default: the current working directory when the server starts
      (os.getcwd()). This matches how Claude Code works — you cd into
      your project, start the agent, and it operates on that directory.
    - Can be overridden with the PROJECT_ROOT environment variable
      for deployment scenarios where cwd isn't the project.
"""

import os
from dataclasses import dataclass

# Root directory all thread folders live under
DEVACCEL_ROOT = os.getenv("DEVACCEL_ROOT", ".devaccel")

# The actual project directory where tools operate.
# Default = cwd when server starts (same as Claude Code).
PROJECT_ROOT = os.getenv("PROJECT_ROOT", os.getcwd())


@dataclass(frozen=True)
class ThreadWorkspace:
    """
    Resolved paths for one thread. Contains:
      - project_root:  the actual codebase (tools read/write here)
      - input_dir:     uploaded files (per-thread)
      - workspace_dir: agent scratch space (per-thread)
      - output_dir:    final deliverables (per-thread)
    """

    thread_id: str
    project_root: str
    input_dir: str
    workspace_dir: str
    output_dir: str
    tmp_dir: str = ""

    @classmethod
    def for_thread(cls, thread_id: str) -> "ThreadWorkspace":
        """
        Resolve (and create if missing) all directories for a thread.
        project_root is NOT created — it must already exist (it's
        the user's actual project directory).
        """
        base = os.path.join(DEVACCEL_ROOT, thread_id)
        input_dir = os.path.join(base, "input")
        workspace_dir = os.path.join(base, "workspace")
        output_dir = os.path.join(base, "output")
        tmp_dir = os.path.join(base, "tmp")

        for path in (input_dir, workspace_dir, output_dir, tmp_dir):
            os.makedirs(path, exist_ok=True)

        return cls(
            thread_id=thread_id,
            project_root=PROJECT_ROOT,
            input_dir=input_dir,
            workspace_dir=workspace_dir,
            output_dir=output_dir,
            tmp_dir=tmp_dir,
        )

    def to_dict(self) -> dict:
        return {
            "thread_id": self.thread_id,
            "project_root": self.project_root,
            "input_dir": self.input_dir,
            "workspace_dir": self.workspace_dir,
            "output_dir": self.output_dir,
            "tmp_dir": self.tmp_dir,
        }
