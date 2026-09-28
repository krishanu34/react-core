"""
MCP configuration types (OUR domain model — not the wire protocol).

The `mcp` SDK already defines the on-the-wire protocol types (tools, results,
JSON-RPC messages) in `mcp.types`; we never redefine those. What lives here is
how DevSphere DESCRIBES a configured server after parsing `.mcp.json`: which
transport it uses, where it lives, and which scope declared it.

Two transports map to Pattern C's two worlds:
  • STDIO  → a process on the USER's machine, launched via the daemon (like
             Claude Code running a local filesystem/Playwright server). Its
             files + secrets stay on the client.
  • HTTP / SSE → a remote server the DevSphere backend connects to directly
             (network APIs whose credentials the backend holds).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


class MCPTransport(str, Enum):
    STDIO = "stdio"  # local process on the user's machine (via the daemon)
    HTTP = "http"    # remote Streamable HTTP
    SSE = "sse"      # remote legacy HTTP+SSE


# Scope precedence, lowest → highest. A server defined in a higher scope
# overrides a same-named one from a lower scope (mirrors permissions.py's
# user < project < local cascade).
SCOPE_ORDER = ("user", "project", "local")


@dataclass
class MCPServerConfig:
    """One configured MCP server, parsed from a `.mcp.json` entry."""

    name: str
    transport: MCPTransport

    # stdio transport
    command: Optional[str] = None
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)

    # http / sse transport
    url: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)

    # metadata
    enabled: bool = True
    scope: str = "project"  # one of SCOPE_ORDER

    def is_local(self) -> bool:
        """True when this server runs on the user's machine (stdio) and so must
        be launched via the daemon, never on the DevSphere backend."""
        return self.transport == MCPTransport.STDIO

    def redacted(self) -> dict:
        """A log-safe view — env values and header values are secrets (API
        keys, tokens) and must never be logged or sent to the model. Keys are
        kept so you can see WHICH secrets exist without revealing them."""
        return {
            "name": self.name,
            "transport": self.transport.value,
            "scope": self.scope,
            "enabled": self.enabled,
            "command": self.command,
            "args": list(self.args),
            "url": self.url,
            "env_keys": sorted(self.env.keys()),
            "header_keys": sorted(self.headers.keys()),
        }


class MCPConfigError(ValueError):
    """A `.mcp.json` entry was malformed or unsafe."""
