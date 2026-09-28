"""
MCPClientManager — owns every connected MCP server for one agent run.

Built per request (like the ToolRegistry), given the enabled REMOTE servers
(stdio/local servers are handled via the daemon in Phase 2). connect_all()
opens each session and discovers its tools; a server that fails to connect is
recorded in `errors` and simply contributes no tools — one bad server never
breaks the run. aclose() must be awaited in the request's finally block.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from utils.logger import get_logger
from ..schemas import MCPServerConfig, MCPTransport
from .connection import MCPConnection

log = get_logger(__name__)


class MCPClientManager:
    def __init__(self, servers: Dict[str, MCPServerConfig]):
        # Only remote HTTP/SSE servers are managed here; stdio servers run on
        # the user's machine via the daemon (Phase 2).
        self.servers = {
            n: c for n, c in servers.items()
            if c.transport in (MCPTransport.HTTP, MCPTransport.SSE)
        }
        self.connections: Dict[str, MCPConnection] = {}
        self.errors: Dict[str, str] = {}

    async def connect_all(self) -> None:
        for name, cfg in self.servers.items():
            conn = MCPConnection(cfg)
            try:
                await conn.connect()
            except Exception as e:  # noqa: BLE001 — isolate per-server failures
                self.errors[name] = f"{type(e).__name__}: {e}"
                log.warning("MCP connect failed: %s — %s", name, self.errors[name])
                continue
            self.connections[name] = conn
            log.info("MCP connected: %s (%d tools)", name, len(conn.tools))

    def tools(self) -> List[Tuple[str, Any]]:
        """[(server_name, mcp.types.Tool), ...] across all connected servers."""
        out: List[Tuple[str, Any]] = []
        for name, conn in self.connections.items():
            for tool in conn.tools:
                out.append((name, tool))
        return out

    async def call(self, server: str, tool: str, arguments: Optional[Dict[str, Any]]):
        conn = self.connections.get(server)
        if conn is None:
            return {"error": f"MCP server '{server}' is not connected"}
        return await conn.call(tool, arguments)

    async def aclose(self) -> None:
        for name, conn in list(self.connections.items()):
            try:
                await conn.aclose()
            except Exception as e:  # noqa: BLE001 — best-effort cleanup
                log.debug("MCP close error for %s: %s", name, e)
        self.connections.clear()
