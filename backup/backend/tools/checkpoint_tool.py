"""
Checkpoint Tool — the agent's (and the user's) undo.

Exposes tools/checkpoint_git.py to the model. Checkpoints are created
AUTOMATICALLY before the first file-modifying tool of each run (see
agents/tool_use_agent.py), so the common case needs no tool call at all —
this is for looking at what changed and going back.

Deliberately read-and-restore only. There is no "delete checkpoint"
operation: the refs are capped and rotate on their own, and an agent that can
erase the undo history can erase the evidence of its own mistake.
"""

from .base_tool import BaseTool
from . import checkpoint_git


class CheckpointTool(BaseTool):

    name = "checkpoint"

    description = (
        "Undo for file changes made during this conversation. A checkpoint of "
        "the workspace is taken automatically before the first edit of each "
        "run (git-backed, invisible to the user's own git commands). "
        "Operations: 'list' (available checkpoints), 'diff' (what changed "
        "since one), 'restore' (put tracked files back). Use 'diff' before "
        "'restore' so you can tell the user what will change. Only works in a "
        "git repository."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["list", "diff", "restore", "create"],
                    "description": (
                        "'list' — show checkpoints for this conversation. "
                        "'diff' — files changed since checkpoint `id`. "
                        "'restore' — revert tracked files to checkpoint `id`. "
                        "'create' — take one now (rarely needed; edits are "
                        "checkpointed automatically)."
                    ),
                },
                "id": {
                    "type": "integer",
                    "description": "Checkpoint id, from 'list'. Required for diff/restore.",
                },
                "label": {
                    "type": "string",
                    "description": "For 'create': a short note about what is about to change.",
                },
            },
            "required": ["operation"],
        }

    async def run(self, operation, id=None, label=None):
        workspace = self.workspace

        if not await checkpoint_git.is_git_repo(workspace):
            return {
                "error": "Not a git repository — checkpoints need git to store "
                         "snapshots. Ask the user to `git init` if they want "
                         "undo protection for agent edits.",
            }

        if operation == "list":
            points = await checkpoint_git.list_checkpoints(workspace, self.thread_id)
            return {
                "checkpoints": [c.to_dict() for c in points],
                "count": len(points),
                "message": (
                    "No checkpoints yet — one is taken automatically before the "
                    "first file change of a run."
                    if not points else
                    f"{len(points)} checkpoint(s), newest first."
                ),
            }

        if operation == "create":
            made = await checkpoint_git.create_checkpoint(
                workspace, self.thread_id, label=label or "manual checkpoint",
            )
            if made is None:
                return {"created": False,
                        "message": "Nothing to checkpoint — the working tree is clean."}
            return {"created": True, "checkpoint": made.to_dict()}

        if id is None:
            return {"error": f"'{operation}' needs a checkpoint id. Call "
                             f"checkpoint(operation='list') first."}

        try:
            index = int(id)
        except (TypeError, ValueError):
            return {"error": f"Checkpoint id must be a number, got {id!r}."}

        if operation == "diff":
            return await checkpoint_git.diff_checkpoint(workspace, self.thread_id, index)

        if operation == "restore":
            return await checkpoint_git.restore_checkpoint(workspace, self.thread_id, index)

        return {"error": f"Unknown operation '{operation}'. "
                         f"Use list, diff, restore or create."}
