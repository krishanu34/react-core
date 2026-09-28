"""
DevSphere AS an MCP server.

Exposes a curated, safe subset of DevSphere's tools (registry_bridge) over MCP so
any MCP client — Claude Desktop, Cursor, VS Code, the MCP Inspector — can drive
them. Uses the SDK's low-level Server because our tools carry JSON Schemas
(BaseTool.parameters()) rather than typed Python signatures, which map 1:1 onto
MCP's Tool.inputSchema + tools/call.

Run it (from the devsphere_ai/ directory, so imports resolve):

    # stdio (how Claude Desktop / Cursor launch it)
    python -m mcp_integration.server.app --workspace /path/to/project

    # streamable HTTP (reachable by remote MCP clients)
    python -m mcp_integration.server.app --transport http --port 3335 --workspace .

Config via env: MCP_SERVER_WORKSPACE, MCP_SERVER_TRANSPORT, MCP_SERVER_HOST,
MCP_SERVER_PORT, MCP_SERVER_TOOLS (override tool list), MCP_SERVER_ALLOW_EXEC.
"""

from __future__ import annotations

import os
from typing import Dict, Tuple

import mcp.types as types
from mcp.server.lowlevel import Server

from tools.base_tool import BaseTool
from utils.logger import get_logger
from .registry_bridge import build_exposed_tools, stringify_tool_result

log = get_logger(__name__)

SERVER_NAME = "devsphere"


def build_server(workspace: str) -> Tuple[Server, Dict[str, BaseTool]]:
    """Wire a low-level MCP Server whose tools/list and tools/call dispatch to
    the curated DevSphere tools bound to `workspace`."""
    tools = build_exposed_tools(workspace)
    server: Server = Server(SERVER_NAME)

    @server.list_tools()
    async def _list_tools():  # noqa: ANN202
        return [
            types.Tool(
                name=t.name,
                description=t.description,
                inputSchema=t.parameters(),
            )
            for t in tools.values()
        ]

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict):  # noqa: ANN202
        tool = tools.get(name)
        if tool is None:
            return [types.TextContent(type="text", text=f"Unknown tool: {name}")]
        try:
            result = await tool.run(**(arguments or {}))
        except Exception as e:  # noqa: BLE001 — return as tool output, don't crash the server
            return [types.TextContent(
                type="text", text=f"Tool '{name}' failed: {type(e).__name__}: {e}")]
        return [types.TextContent(type="text", text=stringify_tool_result(result))]

    return server, tools


def _console_logs_to_stderr() -> None:
    """The MCP stdio transport OWNS stdout for JSON-RPC — any log line written
    there corrupts the protocol. DevSphere's logger installs a stdout console
    handler (utils/logger.setup_logging), so move it to stderr before the stdio
    session starts. Only needed for the stdio transport; HTTP is unaffected."""
    import logging
    import sys as _sys
    for h in logging.getLogger().handlers:
        if isinstance(h, logging.StreamHandler) and getattr(h, "stream", None) is _sys.stdout:
            h.stream = _sys.stderr


async def run_stdio(workspace: str) -> None:
    _console_logs_to_stderr()
    server, _ = build_server(workspace)
    from mcp.server.stdio import stdio_server
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def build_http_app(workspace: str):
    """A Starlette ASGI app serving the MCP server over Streamable HTTP at /mcp."""
    import contextlib

    from starlette.applications import Starlette
    from starlette.routing import Mount
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

    server, _ = build_server(workspace)
    manager = StreamableHTTPSessionManager(app=server, json_response=False, stateless=False)

    async def handle(scope, receive, send):
        await manager.handle_request(scope, receive, send)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        async with manager.run():
            yield

    return Starlette(routes=[Mount("/mcp", app=handle)], lifespan=lifespan)


def run_http(workspace: str, host: str, port: int) -> None:
    import uvicorn
    log.info("DevSphere MCP server (HTTP) on http://%s:%d/mcp (workspace=%s)", host, port, workspace)
    uvicorn.run(build_http_app(workspace), host=host, port=port)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="DevSphere MCP server")
    ap.add_argument("--workspace", default=os.getenv("MCP_SERVER_WORKSPACE") or os.getcwd(),
                    help="Project root the exposed tools operate on")
    ap.add_argument("--transport", default=os.getenv("MCP_SERVER_TRANSPORT", "stdio"),
                    choices=["stdio", "http"])
    ap.add_argument("--host", default=os.getenv("MCP_SERVER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.getenv("MCP_SERVER_PORT", "3335")))
    args = ap.parse_args()

    workspace = os.path.abspath(args.workspace)
    if args.transport == "http":
        run_http(workspace, args.host, args.port)
    else:
        # Redirect console logs off stdout FIRST — before any tool-build logging.
        _console_logs_to_stderr()
        import anyio
        log.info("DevSphere MCP server (stdio) starting (workspace=%s)", workspace)
        anyio.run(run_stdio, workspace)


if __name__ == "__main__":
    main()
