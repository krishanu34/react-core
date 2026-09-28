"""
Remote HTTP MCP transports.

Returns the SDK's transport context manager for a configured server — Streamable
HTTP by default, legacy HTTP+SSE when the server declares `"type": "sse"`. The
caller (MCPConnection) enters it inside an AsyncExitStack.

Both openers yield a stream tuple whose first two elements are (read, write);
Streamable HTTP adds a third (a session-id getter) we don't need. MCPConnection
takes [0] and [1], so either shape works.
"""

from __future__ import annotations

from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

from ...schemas import MCPServerConfig, MCPTransport


def open_http_transport(cfg: MCPServerConfig):
    """Return an *un-entered* async context manager for this server's transport.

    Only valid for HTTP/SSE servers; stdio servers run on the user's machine via
    the daemon (Phase 2), never here.
    """
    if cfg.transport not in (MCPTransport.HTTP, MCPTransport.SSE):
        raise ValueError(
            f"open_http_transport called for non-HTTP server {cfg.name!r} "
            f"({cfg.transport})"
        )
    headers = cfg.headers or None
    if cfg.transport == MCPTransport.SSE:
        return sse_client(cfg.url, headers=headers)
    return streamablehttp_client(cfg.url, headers=headers)
