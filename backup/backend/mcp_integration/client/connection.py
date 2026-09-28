"""
One live MCP server session.

Wraps the SDK's ClientSession + transport in a single object with a flat
lifecycle: connect() → (list_tools once, call_tool many) → aclose(). The two
nested `async with` blocks the SDK expects are held open via an AsyncExitStack
so the session survives across many tool calls in a turn instead of
re-handshaking every call.

Task-safety note: connect() and aclose() run in the SAME async task (the
request's streaming generator). call() may run from a gathered sub-task (parallel
tool calls) — that only SENDS on the session, which is safe; the context-manager
EXIT stays in the owning task.
"""

from __future__ import annotations

from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional

from mcp import ClientSession

from utils.logger import get_logger
from ..schemas import MCPServerConfig
from .transports.http import open_http_transport

log = get_logger(__name__)


class MCPConnection:
    def __init__(self, cfg: MCPServerConfig):
        self.cfg = cfg
        self._stack: Optional[AsyncExitStack] = None
        self.session: Optional[ClientSession] = None
        self.tools: List[Any] = []  # mcp.types.Tool

    async def connect(self) -> None:
        """Open the transport, initialize the session, cache the tool list."""
        # SSRF guard: refuse remote URLs that resolve to internal/loopback hosts
        # before we ever open a connection to them.
        from ..security import assert_remote_url_allowed
        if self.cfg.url:
            assert_remote_url_allowed(self.cfg.url)

        stack = AsyncExitStack()
        try:
            transport_cm = open_http_transport(self.cfg)
            streams = await stack.enter_async_context(transport_cm)
            read, write = streams[0], streams[1]
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            listed = await session.list_tools()
            self.session = session
            self.tools = list(listed.tools)
            self._stack = stack
        except BaseException:
            # Never leak a half-open transport if init/list failed.
            await stack.aclose()
            raise

    async def call(self, tool_name: str, arguments: Optional[Dict[str, Any]]):
        if self.session is None:
            raise RuntimeError(f"MCP server '{self.cfg.name}' is not connected")
        return await self.session.call_tool(tool_name, arguments or {})

    async def aclose(self) -> None:
        if self._stack is not None:
            try:
                await self._stack.aclose()
            finally:
                self._stack = None
                self.session = None
