"""
registry_bridge — map DevSphere's ToolRegistry onto MCP tool definitions.

Reuses ToolRegistry.build_for_workspace (the same tools the agent uses), then
exposes only a CURATED, SAFE allowlist. Each BaseTool already carries a JSON
Schema (`parameters()`) and an `async run(**kwargs)`, which map 1:1 onto MCP's
Tool.inputSchema and tools/call — so this bridge is thin.

SECURITY: the exposed set excludes shell/exec (run_terminal, git), network/keys
(web_*, lsp), and orchestration/memory tools. run_terminal/git are opt-in via
MCP_SERVER_ALLOW_EXEC=true for trusted deployments only — exposing a shell over
MCP is arbitrary code execution on the host.
"""

from __future__ import annotations

import json
import os
from typing import Dict, List

from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
from utils.logger import get_logger

log = get_logger(__name__)

# Safe to expose to an external MCP client: reads, searches, and file writes that
# stay inside the configured workspace root.
DEFAULT_EXPOSED_TOOLS = {
    "read_file",
    "grep_search",
    "file_search",
    "list_directory",
    "workspace_tree",
    "batch_read_files",
    "project_context",
    "file_write",
    "code_edit",
    "create_output",
    "notebook_edit",
}

# Only added when MCP_SERVER_ALLOW_EXEC=true — running a shell on behalf of a
# remote MCP client is dangerous; off by default.
_EXEC_TOOLS = {"run_terminal", "git"}


def exposed_tool_names() -> set:
    names = set(DEFAULT_EXPOSED_TOOLS)
    if os.getenv("MCP_SERVER_ALLOW_EXEC", "").strip().lower() in ("1", "true", "yes"):
        names |= _EXEC_TOOLS
    # Explicit override wins (comma-separated), intersected with what's safe/known.
    override = os.getenv("MCP_SERVER_TOOLS")
    if override:
        wanted = {t.strip() for t in override.split(",") if t.strip()}
        names = wanted
    return names


def build_exposed_tools(workspace: str) -> Dict[str, BaseTool]:
    """The curated tool set, each bound to `workspace`, keyed by name."""
    registry = ToolRegistry.build_for_workspace(workspace, thread_id="mcp-server")
    wanted = exposed_tool_names()
    tools = {t.name: t for t in registry.list_tools() if t.name in wanted}
    missing = wanted - set(tools)
    if missing:
        log.warning("MCP server: requested tools not in registry, skipped: %s", sorted(missing))
    log.info("MCP server exposing %d tools: %s", len(tools), ", ".join(sorted(tools)))
    return tools


def stringify_tool_result(result) -> str:
    """A BaseTool result (dict or str) → the text an MCP client should see."""
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(result)
