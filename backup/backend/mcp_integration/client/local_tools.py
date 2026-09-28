"""
Local (stdio) MCP tools → delegating tools.

A local MCP server runs on the USER's machine via the daemon (Pattern C). The
DevSphere backend can't reach it, so — instead of a server-side session (that's
what tool_adapter.MCPTool does for REMOTE servers) — each local tool becomes a
ClientDelegatingTool. Calling it emits a `client_tool_use` event that the browser
proxies to the daemon's /mcp/call and posts the result back, reusing the EXACT
parked-future path run_terminal already uses.

The client discovers these tools by starting the servers via the daemon and
sends their manifest up as the `mcp_local_tools` form field.
"""

from __future__ import annotations

import json
from typing import List

from tools.base_tool import BaseTool
from tools.client_delegating_tool import ClientDelegatingTool
from utils.logger import get_logger
from ..security import mark_readonly
from .tool_adapter import MAX_MCP_TOOLS, mcp_tool_name

log = get_logger(__name__)


def build_local_mcp_tools(manifest, thread_id: str, workspace: str) -> List[BaseTool]:
    """Parse the client's local-MCP manifest into ClientDelegatingTool instances.

    manifest: JSON string or dict —
        {"<server>": {"tools": [{"name","description","inputSchema"}], "error"?}}
    """
    try:
        data = json.loads(manifest) if isinstance(manifest, str) else (manifest or {})
    except (json.JSONDecodeError, TypeError) as e:
        log.warning("mcp_local_tools: could not parse manifest — %s", e)
        return []
    if not isinstance(data, dict):
        return []

    tools: List[BaseTool] = []
    for server, info in data.items():
        if not isinstance(info, dict):
            continue
        if info.get("error"):
            log.warning("Local MCP server %r failed on the client: %s", server, info["error"])
            continue
        for t in info.get("tools", []) or []:
            name = (t or {}).get("name")
            if not name:
                continue
            if len(tools) >= MAX_MCP_TOOLS:
                log.warning("MCP tool cap (%d) reached — dropping remaining local "
                            "MCP tools (raise MCP_MAX_TOOLS to allow more)", MAX_MCP_TOOLS)
                break
            desc = (t.get("description") or "").strip()
            schema = t.get("inputSchema") or {"type": "object", "properties": {}}
            full = mcp_tool_name(server, name)
            tools.append(ClientDelegatingTool(
                name=full,
                description=f"[MCP:{server}] " + (desc or name),
                parameters_schema=schema,
                thread_id=thread_id,
                workspace=workspace,
            ))
            # readOnlyHint (client forwards the server's annotation) → skip approval.
            ann = t.get("annotations") or {}
            if isinstance(ann, dict) and ann.get("readOnlyHint"):
                mark_readonly(full)
    if tools:
        log.info("Built %d local MCP delegating tools: %s",
                 len(tools), ", ".join(t.name for t in tools))
    return tools
