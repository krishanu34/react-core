"""
Restore Context Tool — pull back content that was offloaded to free space.

When the conversation outgrows the model's window, large tool results and old
messages are written to disk and replaced with a pointer like:

    [offloaded → ctx-19a3f-0421 (18.4 KB, earlier tool result)
     — call restore_context("ctx-19a3f-0421") if you need it again]

This tool turns that ref back into the original bytes. Its whole purpose is to
stop the agent re-running expensive work (a repo-wide grep, a 40-file read) to
recover something it already had.

Server-side only: the spill area is the agent's own state, not the user's
workspace, so there is nothing to delegate to a client.
"""

from .base_tool import BaseTool
from context import context_spill
from utils.logger import get_logger

log = get_logger(__name__)

# A restored blob goes straight back into the prompt, so cap it — restoring
# something enormous would re-trigger the very compaction that offloaded it.
_MAX_RESTORE_CHARS = 24_000


class RestoreContextTool(BaseTool):

    name = "restore_context"

    description = (
        "Retrieve content that was offloaded from the conversation to free up "
        "context. Pass the ref shown in an '[offloaded → ...]' marker. Use this "
        "instead of re-reading files or re-running a search you already ran."
    )

    def __init__(self, workspace: str, thread_id: str = "default"):
        super().__init__(workspace)
        self.thread_id = thread_id

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": (
                        "The ref from an '[offloaded → ...]' marker, "
                        "e.g. 'ctx-19a3f-0421'."
                    ),
                }
            },
            "required": ["ref"],
        }

    async def run(self, ref=None):
        if not ref:
            return {"error": "Provide the 'ref' from an '[offloaded → ...]' marker."}

        content = context_spill.restore(self.thread_id, ref)
        if content is None:
            return {
                "error": (
                    f"No offloaded content found for ref '{ref}'. It may belong to "
                    f"a different conversation, or the run has already finished. "
                    f"Re-read the file or re-run the search instead."
                )
            }

        meta = context_spill.describe(self.thread_id, ref)
        truncated = len(content) > _MAX_RESTORE_CHARS
        if truncated:
            content = content[:_MAX_RESTORE_CHARS]

        log.info(f"Context restored: {ref} ({len(content)} chars, truncated={truncated})")
        return {
            "ref": ref,
            "label": meta.get("label", ""),
            "content": content,
            "truncated": truncated,
        }
