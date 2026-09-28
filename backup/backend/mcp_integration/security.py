"""
MCP security guards.

Two concerns handled here:

1. SSRF on REMOTE servers. A remote MCP `url` is reached FROM the DevSphere
   backend, and `.mcp.json` can be project-scoped (checked in) or sent up by a
   client — so an attacker-influenced config could point the backend at internal
   infra (cloud metadata 169.254.169.254, localhost, private ranges). We block
   those by default; MCP_ALLOW_PRIVATE_HOSTS=true opts back in for self-hosted
   local servers, and MCP_HTTP_ALLOWED_HOSTS is an explicit hostname-suffix
   allowlist.

2. Read-only tool tracking. MCP tools default to the ask-mode trust prompt, but
   a tool the server annotates readOnlyHint is a pure read and shouldn't nag —
   permissions.py consults is_readonly() to skip approval for those.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse

from utils.logger import get_logger
from .schemas import MCPConfigError

log = get_logger(__name__)


def _env_true(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes")


def _allowed_host_suffixes() -> list:
    raw = os.getenv("MCP_HTTP_ALLOWED_HOSTS", "")
    return [s.strip().lower() for s in raw.split(",") if s.strip()]


def _is_blocked_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # Loopback, private, link-local (incl. cloud metadata 169.254.169.254),
    # unspecified, and reserved ranges are all SSRF targets.
    return (
        addr.is_loopback or addr.is_private or addr.is_link_local
        or addr.is_unspecified or addr.is_reserved or addr.is_multicast
    )


def assert_remote_url_allowed(url: str) -> None:
    """Raise MCPConfigError if a remote MCP URL is disallowed (SSRF guard).

    Bypassed entirely by MCP_ALLOW_PRIVATE_HOSTS=true (self-hosted setups where
    an internal/localhost MCP server is legitimate)."""
    if _env_true("MCP_ALLOW_PRIVATE_HOSTS"):
        return

    host = (urlparse(url).hostname or "").lower()
    if not host:
        raise MCPConfigError(f"remote MCP url has no host: {url!r}")

    # Explicit allowlist wins.
    suffixes = _allowed_host_suffixes()
    if suffixes and any(host == s or host.endswith("." + s) for s in suffixes):
        return

    if host == "localhost" or host.endswith(".localhost"):
        raise MCPConfigError(
            f"remote MCP host {host!r} is loopback — blocked (set "
            f"MCP_ALLOW_PRIVATE_HOSTS=true for self-hosted local servers)"
        )

    # Resolve the host and reject if ANY address is internal (defends against a
    # public name that resolves to a private IP).
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise MCPConfigError(f"remote MCP host {host!r} does not resolve: {e}")
    for info in infos:
        ip = info[4][0]
        if _is_blocked_ip(ip):
            raise MCPConfigError(
                f"remote MCP host {host!r} resolves to internal address {ip} — "
                f"blocked as an SSRF risk"
            )


# ── Read-only tool registry (process-wide) ──────────────────────────────────
# MCP tool names the server marked readOnlyHint — permissions skips the ask
# prompt for these (a pure read needs no trust gate).
_readonly: set = set()


def mark_readonly(tool_name: str) -> None:
    _readonly.add(tool_name)


def is_readonly(tool_name: str) -> bool:
    return tool_name in _readonly
