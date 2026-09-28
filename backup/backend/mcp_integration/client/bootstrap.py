"""
Bootstrap the MCP client for one agent run — keeps router/agent_stream.py lean.

Phase 1 sources remote (HTTP/SSE) servers from `.mcp.json` on THIS machine
(user scope `~/.devaccel/mcp.json` + project scope under the workspace). Local
stdio servers are intentionally excluded here — they run on the user's machine
via the daemon (Phase 2). Returns None when no remote servers are configured, so
existing deployments are completely unaffected.
"""

from __future__ import annotations

from typing import Optional

from ..config import enabled_servers, load_from_disk
from ..schemas import MCPTransport
from .manager import MCPClientManager


def build_remote_manager(workspace_root: str) -> Optional[MCPClientManager]:
    servers = enabled_servers(load_from_disk(workspace_root))
    remote = {
        n: c for n, c in servers.items()
        if c.transport in (MCPTransport.HTTP, MCPTransport.SSE)
    }
    if not remote:
        return None
    return MCPClientManager(remote)
