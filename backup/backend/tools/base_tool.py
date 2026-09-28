"""
Base Tool

All tools inherit from this. Every tool receives the project_root
path — the actual directory where the user's code lives. This is
what tools read from, search in, and execute commands within.

project_root is NOT the .devaccel sandbox. It's the real codebase.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseTool(ABC):

    name: str
    description: str

    # Set to True in tools that accept an `on_event` callback for live streaming.
    # When True, _call_tool in the agents will pass on_event into run().
    SUPPORTS_STREAMING: bool = False

    def __init__(self, workspace: str):
        # "workspace" here means the project root — the actual
        # directory containing the user's code. Named "workspace"
        # to keep the BaseTool interface stable, but it points to
        # the real project, not the .devaccel sandbox.
        self.workspace = workspace
        # Set by ToolRegistry.build_for_workspace() after construction — lets
        # file tools scope read-tracking (context/read_tracker.py) to the
        # thread that's actually running, without changing every __init__.
        self.thread_id: str = "default"

    def schema(self) -> Dict[str, Any]:
        """JSON schema exposed to the LLM for tool selection."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters()
        }

    @abstractmethod
    def parameters(self):
        """Return JSON Schema dict for this tool's parameters."""
        pass

    @abstractmethod
    async def run(self, **kwargs):
        """Execute the tool and return results."""
        pass

    def _resolve_path(self, path: str) -> str:
        """
        Resolve a relative path against the project root.
        Used by file-based tools to turn agent-provided paths
        (like "agents/orchestrator.py") into absolute paths.

        Includes sandboxing: blocks path traversal (../) and
        ensures the resolved path stays within the workspace.
        """
        import os
        from pathlib import Path

        # Block obvious traversal attempts
        if ".." in path:
            clean = path.replace("..", "").replace("\\", "/")
            path = clean

        if os.path.isabs(path):
            resolved = str(Path(path).resolve())
        else:
            resolved = str(Path(os.path.join(self.workspace, path)).resolve())

        # Sandbox: ensure path is within workspace
        workspace_resolved = str(Path(self.workspace).resolve())
        if not resolved.startswith(workspace_resolved):
            return os.path.join(self.workspace, os.path.basename(path))

        return resolved
