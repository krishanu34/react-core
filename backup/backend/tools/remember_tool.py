"""
Remember Tool

Lets the agent explicitly save a fact, preference, or observation to
long-term memory so it can be recalled in future runs - even after
the server restarts.

This is how the agent "learns" about the user and their project over
time. Without this tool, the agent can only remember things within a
single run (via the scratchpad) or within one server session (via
conversation history). With this tool, the agent can persist anything
it considers worth remembering to disk-backed long-term memory.

Examples of what the agent might remember:
  - "The user prefers TypeScript over JavaScript"
  - "This project uses FastAPI for the backend and React for the UI"
  - "The main database config is in config/db.py"
  - "The user asked to always run tests after code changes"

Unlike other tools that need workspace access, this one needs a
reference to the LongTermMemory instance. It's wired up separately
in the ToolRegistry (see tools/registry.py).
"""

from .base_tool import BaseTool


class RememberTool(BaseTool):
    """
    Persist a fact or observation to long-term memory.
    The agent calls this when it learns something worth keeping
    across conversations - user preferences, project facts, or
    anything that would be useful context in future interactions.
    """

    name = "remember"
    description = (
        "Save a fact, preference, or observation to long-term memory "
        "so it can be recalled in future conversations. Use this when "
        "you learn something about the user, their project, or their "
        "preferences that would be useful to remember later. Tags help "
        "organize memories for retrieval."
    )

    def __init__(self, workspace: str, long_term_memory=None):
        """
        workspace:         passed through to BaseTool (required by
                           the interface, but not used by this tool)
        long_term_memory:  the LongTermMemory instance to save into.
                           If None, the tool will return an error
                           instead of crashing.
        """
        super().__init__(workspace)
        self._memory = long_term_memory

    def parameters(self):
        """JSON schema for the tool's arguments."""
        return {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": (
                        "The fact, preference, or observation to remember. "
                        "Be specific and self-contained - this text will be "
                        "shown in future conversations without the current "
                        "context, so it should make sense on its own."
                    ),
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional tags to categorize this memory for easier "
                        "retrieval. Examples: ['user_preference'], "
                        "['project_fact'], ['architecture'], ['convention']."
                    ),
                },
            },
            "required": ["content"],
        }

    async def run(self, content: str, tags: list = None, **kwargs):
        """
        Save the content to long-term memory with optional tags.
        Returns a confirmation message so the agent knows it worked.
        """
        if self._memory is None:
            return {"error": "Long-term memory is not available in this context."}

        self._memory.add(content=content, tags=tags or [])

        return {
            "status": "remembered",
            "content": content,
            "tags": tags or [],
            "message": f"Saved to long-term memory: '{content[:80]}{'...' if len(content) > 80 else ''}'",
        }
