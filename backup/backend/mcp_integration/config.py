"""
Load + validate MCP server configuration from `.mcp.json`.

Format is Claude Code's exactly, so a user's existing config just works:

    {
      "mcpServers": {
        "github":   { "url": "https://api.example.com/mcp",
                      "headers": { "Authorization": "Bearer ..." } },
        "fs-local": { "command": "npx",
                      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
      }
    }

Transport is inferred: an entry with `command` is stdio (local, runs on the
user's machine via the daemon); an entry with `url` is remote HTTP (or SSE when
`"type": "sse"`). A server may be turned off with `"enabled": false` (or the
Claude-Code-style `"disabled": true`).

Scopes (low → high precedence — a higher scope overrides a same-named server):
    user     ~/.devaccel/mcp.json          (server-side; every project)
    project  <workspace>/.mcp.json          (checked in, shared with the team)
    local    <workspace>/.mcp.local.json    (gitignored, personal overrides)

Two entry points, because Pattern C means the config may live on EITHER side:
  • load_from_disk(workspace_root) — files on THIS machine's filesystem
    (server-side same-machine case, and remote-HTTP servers).
  • parse_servers(raw, scope)      — a raw dict the browser/daemon sent up from
    the CLIENT's `.mcp.json` (client-side workspace case).
Use merge_configs(...) to combine both with correct precedence.

SECURITY: `env` and `headers` values are secrets (API keys, tokens). They are
never logged (see MCPServerConfig.redacted) and never sent to the model.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional

from utils.logger import get_logger
from .schemas import (
    MCPConfigError,
    MCPServerConfig,
    MCPTransport,
    SCOPE_ORDER,
)

log = get_logger(__name__)

# Server names become the `<server>` segment of an `mcp__<server>__<tool>` tool
# name that the LLM emits and the permission system matches on — so restrict it
# to the same safe charset Claude Code normalizes to. A name with anything else
# (spaces, dots, quotes, shell metacharacters) is rejected, never sanitized:
# silently rewriting it would make the configured name and the live tool name
# disagree.
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_-]+$")


def parse_servers(raw: Optional[dict], scope: str) -> Dict[str, MCPServerConfig]:
    """Parse one `.mcp.json`-shaped dict into {name: MCPServerConfig}.

    Invalid individual entries are skipped with a warning rather than failing
    the whole load — one broken server must not hide the others.
    """
    if not raw:
        return {}
    servers_raw = raw.get("mcpServers")
    if not isinstance(servers_raw, dict):
        log.warning("MCP config (%s): missing/invalid 'mcpServers' object — ignoring", scope)
        return {}

    out: Dict[str, MCPServerConfig] = {}
    for name, entry in servers_raw.items():
        try:
            cfg = _parse_entry(name, entry, scope)
        except MCPConfigError as e:
            log.warning("MCP config (%s): skipping server %r — %s", scope, name, e)
            continue
        out[cfg.name] = cfg
    return out


def _parse_entry(name: str, entry: object, scope: str) -> MCPServerConfig:
    if not isinstance(name, str) or not _SAFE_NAME.match(name):
        raise MCPConfigError(
            f"server name must match {_SAFE_NAME.pattern} (got {name!r})"
        )
    if not isinstance(entry, dict):
        raise MCPConfigError("entry must be an object")

    # enabled / disabled (accept both spellings)
    enabled = bool(entry.get("enabled", True)) and not bool(entry.get("disabled", False))

    command = entry.get("command")
    url = entry.get("url")
    declared_type = str(entry.get("type", "")).strip().lower()

    if command:
        if not isinstance(command, str):
            raise MCPConfigError("'command' must be a string")
        args = entry.get("args", [])
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            raise MCPConfigError("'args' must be a list of strings")
        env = entry.get("env", {}) or {}
        if not isinstance(env, dict):
            raise MCPConfigError("'env' must be an object")
        return MCPServerConfig(
            name=name,
            transport=MCPTransport.STDIO,
            command=command,
            args=list(args),
            env={str(k): str(v) for k, v in env.items()},
            enabled=enabled,
            scope=scope,
        )

    if url:
        if not isinstance(url, str):
            raise MCPConfigError("'url' must be a string")
        if not re.match(r"^https?://", url, re.IGNORECASE):
            raise MCPConfigError("'url' must be http(s)")
        transport = MCPTransport.SSE if declared_type == "sse" else MCPTransport.HTTP
        headers = entry.get("headers", {}) or {}
        if not isinstance(headers, dict):
            raise MCPConfigError("'headers' must be an object")
        return MCPServerConfig(
            name=name,
            transport=transport,
            url=url,
            headers={str(k): str(v) for k, v in headers.items()},
            enabled=enabled,
            scope=scope,
        )

    raise MCPConfigError("entry must have either 'command' (stdio) or 'url' (http/sse)")


def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as e:
        log.warning("MCP config: could not read %s — %s", path, e)
        return None


def _scope_files(workspace_root: Optional[str]) -> List[tuple]:
    """(path, scope) candidates on THIS machine, low → high precedence."""
    files: List[tuple] = []
    user_path = os.getenv("DEVACCEL_MCP_CONFIG") or os.path.join(
        Path.home(), ".devaccel", "mcp.json"
    )
    files.append((Path(user_path), "user"))
    if workspace_root:
        root = Path(workspace_root)
        files.append((root / ".mcp.json", "project"))
        files.append((root / ".mcp.local.json", "local"))
    return files


def load_from_disk(workspace_root: Optional[str] = None) -> Dict[str, MCPServerConfig]:
    """Discover + parse `.mcp.json` files on this machine's filesystem."""
    per_scope: Dict[str, Dict[str, MCPServerConfig]] = {}
    for path, scope in _scope_files(workspace_root):
        raw = _read_json(path)
        if raw is not None:
            per_scope[scope] = parse_servers(raw, scope)
    return _merge_by_scope(per_scope)


def merge_configs(*scoped: Dict[str, MCPServerConfig]) -> Dict[str, MCPServerConfig]:
    """Merge already-parsed configs. Pass them in ANY order; precedence is
    decided by each server's own `scope`, not argument order — so combining
    on-disk (server-side) and client-sent configs is order-independent."""
    per_scope: Dict[str, Dict[str, MCPServerConfig]] = {}
    for group in scoped:
        for cfg in group.values():
            per_scope.setdefault(cfg.scope, {})[cfg.name] = cfg
    return _merge_by_scope(per_scope)


def _merge_by_scope(
    per_scope: Dict[str, Dict[str, MCPServerConfig]],
) -> Dict[str, MCPServerConfig]:
    merged: Dict[str, MCPServerConfig] = {}
    for scope in SCOPE_ORDER:  # low → high; later wins
        for name, cfg in per_scope.get(scope, {}).items():
            merged[name] = cfg
    return merged


def enabled_servers(
    servers: Dict[str, MCPServerConfig],
) -> Dict[str, MCPServerConfig]:
    """Just the servers that are turned on."""
    return {n: c for n, c in servers.items() if c.enabled}
