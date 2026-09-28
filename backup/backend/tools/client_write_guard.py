"""Stops a client-owned workspace's writes from landing on the SERVER's disk.

When the client advertises `client_tools`, the user's files live on THEIR
machine and the server has no access to them. The registry already handles two
cases of that: server-only filesystem tools are dropped
(SERVER_FS_TOOLS_DISABLED_FOR_CLIENT), and run_terminal/git become explicit
"unavailable" stubs rather than executing against the wrong disk.

Write tools had no such guard. A client that advertised `client_tools` but not,
say, `code_edit` kept the SERVER's copy of the tool — which happily wrote to the
server's own checkout and returned success. The agent believed the edit was
made, the chat rendered the diff, and the user's real file was never touched.
Nothing anywhere reported a problem, which makes it far worse than an error:
the agent then reasons, and edits, against a file state that does not exist.

Refusing loudly is the only safe answer. There is no fallback that could be
correct here — the bytes cannot reach a disk the server cannot see.
"""

from __future__ import annotations

from typing import Any, Dict

from .base_tool import BaseTool


class ClientWriteUnavailableTool(BaseTool):
    """Stands in for a filesystem-writing tool the connected client didn't offer.

    Presents the same name/description/schema as the tool it replaces, so the
    LLM's view of the toolset is unchanged and the refusal arrives as a normal
    tool result it can act on — the same contract as
    RunTerminalUnavailableTool / GitUnavailableTool.
    """

    # True so the agent passes on_event in; the stub ignores it, but keeping the
    # call signature identical to the real tool means it can never be the reason
    # a call fails differently.
    SUPPORTS_STREAMING = True

    def __init__(self, name: str, description: str, parameters_schema: Dict[str, Any], workspace: str):
        super().__init__(workspace)
        self.name = name
        self.description = description
        self._parameters = parameters_schema

    def parameters(self):
        return self._parameters

    async def run(self, on_event=None, **kwargs) -> Dict[str, Any]:
        return {
            "error": "no_client_write_channel",
            "tool": self.name,
            "path": kwargs.get("path") or kwargs.get("filename"),
            "instruction": (
                f"This workspace lives on the user's machine, and the connected "
                f"client did not offer to execute '{self.name}' there. Writing on "
                f"the server would change a file the user will never see, so "
                f"nothing was written. Do NOT retry this or any other write, and "
                f"do NOT report the change as made. Tell the user to reconnect "
                f"their workspace (open the folder again, or install and start "
                f"the DevAccel daemon from the Daemon Setup tab), then re-send "
                f"the request. If they need the change now, show them the exact "
                f"content to apply themselves."
            ),
        }
