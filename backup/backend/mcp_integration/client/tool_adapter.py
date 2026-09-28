"""
MCPTool — one external MCP tool wrapped as a native DevSphere BaseTool.

This is the whole point of the client design: an MCP tool becomes
indistinguishable from a built-in tool, so it flows through the UNCHANGED path —
ToolRegistry → _build_tool_schemas() → check_tool_permission() → _call_tool().

Naming follows Claude Code exactly: `mcp__<server>__<tool>`. The permission
system already treats an `mcp__`-prefixed name as approval-required in ask mode
(see context/permissions.py), giving the per-server trust prompt.
"""

from __future__ import annotations

import json
import os
from typing import Any, List

from tools.base_tool import BaseTool
from utils.logger import get_logger
from ..security import mark_readonly

log = get_logger(__name__)

NAME_SEP = "__"

# Guard the context budget: one server can publish dozens of tools, and every
# resident tool schema costs prompt tokens. Cap the TOTAL attached across all
# servers; overflow is dropped with a warning. Override via MCP_MAX_TOOLS.
MAX_MCP_TOOLS = int(os.getenv("MCP_MAX_TOOLS", "64"))


def mcp_tool_name(server: str, tool: str) -> str:
    return f"mcp{NAME_SEP}{server}{NAME_SEP}{tool}"


def is_mcp_tool_name(name: str) -> bool:
    return name.startswith("mcp" + NAME_SEP)


class MCPTool(BaseTool):
    """Adapter: presents one remote MCP tool with a native tool interface."""

    def __init__(self, workspace: str, manager, server_name: str, tool: Any):
        super().__init__(workspace)
        self._manager = manager
        self._server = server_name
        self._remote_name = tool.name
        self.name = mcp_tool_name(server_name, tool.name)

        desc = (getattr(tool, "description", None) or "").strip()
        self.description = f"[MCP:{server_name}] " + (desc or tool.name)

        # The server's own JSON Schema for arguments — handed straight to the LLM.
        self._schema = getattr(tool, "inputSchema", None) or {
            "type": "object",
            "properties": {},
        }

        # readOnlyHint (when the server provides it) lets Phase 4 skip the
        # approval prompt for pure reads. Server-supplied hint — treat as advisory.
        ann = getattr(tool, "annotations", None)
        self.read_only = bool(getattr(ann, "readOnlyHint", False)) if ann else False

    def parameters(self):
        return self._schema

    async def run(self, **kwargs):
        try:
            result = await self._manager.call(self._server, self._remote_name, kwargs)
        except Exception as e:  # noqa: BLE001 — surface as a tool error, don't crash the loop
            return f"MCP tool '{self.name}' failed: {type(e).__name__}: {e}"
        return _stringify_result(result)


def _stringify_result(result: Any) -> str:
    """Flatten an MCP CallToolResult into the string the agent loop expects."""
    if isinstance(result, dict):  # our own {"error": ...} envelope
        return json.dumps(result)

    parts: List[str] = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text is not None:
            parts.append(text)
        else:
            # Non-text content (image/resource) — note its type rather than dump bytes.
            parts.append(f"[{getattr(block, 'type', 'content')} block]")

    # Prefer structured content when there's no text (some servers return only that).
    if not parts and getattr(result, "structuredContent", None) is not None:
        parts.append(json.dumps(result.structuredContent))

    text = "\n".join(parts) if parts else "(no content)"
    if getattr(result, "isError", False):
        return f"MCP tool error: {text}"
    return text


def attach_mcp_tools(registry, manager, workspace: str) -> List[str]:
    """Append an MCPTool for every discovered remote tool to `registry`.

    Uses the same direct-append pattern build_for_workspace already uses for
    sub_agent, so MCP tools appear in schemas(), list_tools(), and get(). A tool
    whose name would collide with an existing native tool is skipped (native
    wins) — the `mcp__` prefix makes collisions effectively impossible anyway.
    Returns the names added, for logging.
    """
    added: List[str] = []
    for server_name, tool in manager.tools():
        if len(added) >= MAX_MCP_TOOLS:
            log.warning("MCP tool cap (%d) reached — dropping remaining tools "
                        "(raise MCP_MAX_TOOLS to allow more)", MAX_MCP_TOOLS)
            break
        mt = MCPTool(workspace, manager, server_name, tool)
        if registry.get(mt.name) is not None:
            log.warning("MCP tool %s collides with an existing tool — skipping", mt.name)
            continue
        registry._tools.append(mt)
        registry._by_name[mt.name] = mt
        # Read-only tools skip the ask-mode trust prompt (permissions.py).
        if mt.read_only:
            mark_readonly(mt.name)
        added.append(mt.name)
    if added:
        log.info("Attached %d MCP tools: %s", len(added), ", ".join(added))
    return added
