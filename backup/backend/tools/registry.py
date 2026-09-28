"""
Tool Registry

Why this exists:
Every agent (ReActAgent today, possibly others later) needs the same
three things from "the tools":
  1. A list of Tool instances, each bound to a specific workspace
     directory (so the SAME tool classes can be reused across many
     different threads/sessions, each with its own isolated folder).
  2. A name -> Tool lookup, so when the LLM says
     `Action: read_file`, we can find the matching object in O(1).
  3. A list of JSON schemas (one per tool) to hand to the LLM so it
     knows what tools exist and what arguments each one takes.

Before this file existed, every agent had to import each tool class
itself and build this wiring by hand (see ReActAgent.__init__, which
just took a `tools` list someone else assembled). That's fine for a
single hardcoded set of tools, but as soon as you have multiple
threads each needing their OWN workspace-scoped set of tool
instances - which is exactly the case once /api/agent/stream is
serving many concurrent threads, each bound to a different
.devaccel/{thread_id}/workspace folder - you need a single place
that knows how to build "the full toolset, scoped to this
workspace" on demand. That's what ToolRegistry.build_for_workspace()
does below.
"""

from typing import Dict, List, Optional

from .base_tool import BaseTool
from .read_file_tool import ReadFileTool
from .write_file_tool import WriteFileTool
from .code_edit_tool import CodeEditTool
from .grep_search_tool import GrepSearchTool
from .file_search_tool import FileSearchTool
from .list_directory_tool import ListDirectoryTool
from .run_terminal_tool import RunTerminalTool
from .remember_tool import RememberTool
from .create_output_tool import CreateOutputTool
from .workspace_tree_tool import WorkspaceTreeTool
from .batch_read_files_tool import BatchReadFilesTool
from .summarize_workspace_tool import SummarizeWorkspaceTool
from .project_context_tool import ProjectContextTool
from .ask_user_tool import AskUserTool
from .update_project_memory_tool import UpdateProjectMemoryTool
from .sub_agent_tool import SubAgentTool
from .task_manager_tool import TaskManagerTool
from .web_fetch_tool import WebFetchTool
from .web_search_tool import WebSearchTool
from .notebook_edit_tool import NotebookEditTool
from .monitor_tool import MonitorTool
from .git_tool import GitTool
from .checkpoint_tool import CheckpointTool
from .lsp_tool import LspTool


class ToolRegistry:
    """
    Holds tool instances for ONE workspace and provides the lookups
    every agent needs (by name, and as LLM-facing schemas).

    Usage:
        # Without memory (remember tool disabled):
        registry = ToolRegistry.build_for_workspace(workspace_path)

        # With memory (remember tool enabled):
        registry = ToolRegistry.build_for_workspace(
            workspace_path, long_term_memory=some_memory_instance
        )

        registry.get("read_file")          # -> ReadFileTool instance
        registry.list_tools()              # -> [Tool, Tool, ...]
        registry.schemas()                 # -> [{"name": ..., ...}, ...]
    """

    # ── Pattern C: the authoritative client/server split ──────────────────
    # Tools in this set CAN be executed by a client (browser / VS Code) against
    # the user's real files. Only these are ever delegated to a client — any
    # tool a client advertises outside this set is ignored and runs on the
    # server. This constant is the single source of truth for "which tool runs
    # where"; keep it in sync with ui/src/lib/agent/clientTools.ts (CLIENT_TOOLS).
    #
    # run_terminal and git are CONDITIONALLY client-executable: the browser
    # itself has no shell/git binary, but the DevAccel daemon on the user's
    # machine does (POST /exec) — the client advertises them only when the
    # daemon transport is connected. This is how Claude Code / Copilot / Kiro
    # work: commands run where the files live, never on the product's server.
    #
    # Everything NOT listed here is server-only by definition: web_fetch/
    # web_search/lsp (network/keys/language servers), and the orchestration/
    # memory tools (sub_agent, ask_user, task_manager, remember,
    # update_project_memory, monitor, summarize_workspace, project_context)
    # which have no disk side-effect to move.
    CLIENT_EXECUTABLE_TOOLS = {
        "read_file",
        "file_write",
        "code_edit",
        "list_directory",
        "workspace_tree",
        "file_search",
        "grep_search",
        "batch_read_files",
        "create_output",
        "notebook_edit",
        "run_terminal",
        "git",
        # Project memory (devaccel.md) lives IN the user's workspace, like
        # Claude Code's CLAUDE.md — the write must land on the client machine.
        "update_project_memory",
    }

    # The subset of CLIENT_EXECUTABLE_TOOLS that MUTATES the filesystem. For a
    # client-owned workspace these must run on the client or not at all: the
    # server cannot see the user's files, so a server-side "success" here is a
    # write to the wrong machine that nothing reports as wrong. See
    # tools/client_write_guard.py.
    CLIENT_FS_WRITE_TOOLS = {
        "file_write",
        "code_edit",
        "create_output",
        "notebook_edit",
        "update_project_memory",
    }

    # Server-only tools that READ/WRITE the workspace filesystem but can't be
    # delegated (they do LLM/multi-step work internally). When the workspace is
    # client-side (the client advertised client_tools), the server has NO access
    # to the user's files — these would silently operate on the SERVER's disk
    # (e.g. /home/azureuser/devaccelv2) and write generated files there. So we
    # DROP them for client workspaces and let the agent achieve the same result
    # with the delegated primitives (workspace_tree + read_file to understand the
    # project, write_file/create_output to produce files) — all of which run on
    # the client via the daemon.
    SERVER_FS_TOOLS_DISABLED_FOR_CLIENT = {
        "project_context",
        "summarize_workspace",
    }

    # Every tool class that should be available to agents by default.
    # Adding a new tool to the system means adding its class here.
    # RememberTool is NOT in this list because it needs special
    # construction (a memory reference, not just workspace) - it's
    # added conditionally in build_for_workspace() below.
    _DEFAULT_TOOL_CLASSES = [
        ProjectContextTool,
        ReadFileTool,
        WriteFileTool,
        CodeEditTool,
        GrepSearchTool,
        FileSearchTool,
        ListDirectoryTool,
        WorkspaceTreeTool,
        BatchReadFilesTool,
        RunTerminalTool,
        UpdateProjectMemoryTool,
        WebFetchTool,
        WebSearchTool,
        NotebookEditTool,
        GitTool,
        CheckpointTool,
        LspTool,
    ]

    def __init__(self, tools: List[BaseTool]):
        self._tools = tools
        self._by_name: Dict[str, BaseTool] = {tool.name: tool for tool in tools}

    @classmethod
    def build_for_workspace(
        cls,
        workspace: str,
        tool_classes: Optional[List[type]] = None,
        long_term_memory=None,
        output_dir: str = None,
        llm=None,
        thread_id: str = "default",
        token_tracker=None,
        context_window: int = 8192,
        client_tools: Optional[set] = None,
        client_os: Optional[str] = None,
        skill_catalog=None,
        session_scope: Optional[dict] = None,
    ) -> "ToolRegistry":
        """
        Instantiate every tool class, each bound to `workspace`, and
        wrap them in a registry.

        workspace:         absolute path the tools should operate on
                           (the actual project directory).
        tool_classes:      override which tool classes to include.
        long_term_memory:  if provided, adds a RememberTool.
        output_dir:        if provided, adds a CreateOutputTool and
                           SummarizeWorkspaceTool that write generated
                           files to this directory.
        llm:               if provided, SummarizeWorkspaceTool and
                           SubAgentTool use it for LLM calls.
        thread_id:         thread ID for per-thread tools (task_manager, monitor).
        token_tracker:     token tracker for SubAgentTool.
        context_window:    model context window size for SubAgentTool.
        client_tools:      names of tools the connected client will execute
                           locally (Pattern C). Matching tools are swapped for
                           a ClientDelegatingTool that emits `client_tool_use`
                           and awaits the client's result instead of touching
                           the server disk. Empty/None → all tools run on the
                           server, exactly as before (fully backward-compatible).
        skill_catalog:     list[SkillEntry] from skills/catalog.py. Adds the
                           `skill` tool, which loads one entry's full text on
                           demand. Empty/None → no such tool, so a workspace
                           with nothing to load doesn't advertise a way to
                           load it.
        session_scope:     {project-root, user_name, …} used to resolve the
                           placeholders inside a loaded entry.
        client_os:         OS of the CLIENT machine ("windows" | "macos" |
                           "linux" | raw platform strings). Only used when
                           run_terminal is client-delegated: the tool's
                           description is rebuilt for that OS so the LLM
                           composes cmd.exe vs POSIX-sh commands for the
                           machine that actually executes them — not for
                           this server's OS.
        """
        classes = tool_classes if tool_classes is not None else cls._DEFAULT_TOOL_CLASSES
        tools = [tool_class(workspace) for tool_class in classes]
        # Scope every tool's read-tracking (context/read_tracker.py — Claude
        # Code's "read this file before you overwrite it" invariant) to the
        # thread actually running. A registry is rebuilt every /stream request
        # (one call per turn), so this must key on thread_id, not the instance.
        for _t in tools:
            _t.thread_id = thread_id

        # AskUserTool always added; long_term_memory may be None (tool handles it).
        # llm enables question-set completion — one call that turns a lone
        # "which backend?" into the complete clarification card for the task.
        tools.append(AskUserTool(workspace, long_term_memory=long_term_memory, llm=llm))

        if long_term_memory is not None:
            tools.append(RememberTool(workspace, long_term_memory=long_term_memory))

        if output_dir is not None:
            tools.append(CreateOutputTool(workspace, output_dir=output_dir))
            tools.append(SummarizeWorkspaceTool(workspace, output_dir=output_dir, llm=llm))

        # Loads one catalog entry's full instructions (agent persona, skill,
        # template, or any kind the workspace defines). Constructed here
        # rather than listed in _DEFAULT_TOOL_CLASSES because it needs the
        # catalog, and it is omitted entirely when there is nothing to load.
        if skill_catalog:
            from .skill_tool import SkillTool
            tools.append(SkillTool(
                workspace, catalog=skill_catalog, session_scope=session_scope,
                # When the client owns the files, the tool borrows its
                # read_file rather than looking on the server's disk.
                client_reads="read_file" in (client_tools or ()),
            ))

        # Per-thread tools
        tools.append(TaskManagerTool(workspace, thread_id=thread_id))
        tools.append(MonitorTool(workspace, thread_id=thread_id))

        # Build registry first (sub_agent needs it for child agent creation)
        registry = cls(tools)

        # SubAgentTool needs LLM + the registry itself
        if llm is not None:
            sub_agent = SubAgentTool(
                workspace,
                llm=llm,
                tool_registry=registry,
                token_tracker=token_tracker,
                context_window=context_window,
            )
            registry._tools.append(sub_agent)
            registry._by_name[sub_agent.name] = sub_agent

        # Client-side workspace: drop server-only filesystem tools that would
        # otherwise touch the WRONG (server) disk — the agent uses the delegated
        # primitives instead (see SERVER_FS_TOOLS_DISABLED_FOR_CLIENT).
        if client_tools:
            drop = cls.SERVER_FS_TOOLS_DISABLED_FOR_CLIENT
            if any(t.name in drop for t in registry._tools):
                registry._tools = [t for t in registry._tools if t.name not in drop]
                registry._by_name = {t.name: t for t in registry._tools}

            # The workspace lives on the client, so the server shell is the
            # WRONG machine for run_terminal/git — running there builds/leaks
            # the server's own files. Any execution tool the client didn't
            # advertise (no daemon connected) is swapped for a stub that tells
            # the agent to guide the user through runtime setup instead.
            from .git_tool import GitUnavailableTool
            from .run_terminal_tool import RunTerminalUnavailableTool
            stubs = {"run_terminal": RunTerminalUnavailableTool, "git": GitUnavailableTool}
            missing = {name: cls_ for name, cls_ in stubs.items() if name not in client_tools}
            if missing:
                registry._tools = [
                    missing[t.name](workspace) if t.name in missing else t
                    for t in registry._tools
                ]
                registry._by_name = {t.name: t for t in registry._tools}

            # Same rule for WRITES, and for a worse reason. run_terminal on the
            # server at least fails visibly; a write succeeds. A write tool the
            # client didn't advertise stays the SERVER's copy, writes to the
            # SERVER's disk, and returns success — the agent reports the edit,
            # the chat renders the diff, and the user's file never changes.
            # Refuse it instead; there is no correct fallback for bytes that
            # cannot reach a disk this process can't see.
            unadvertised = cls.CLIENT_FS_WRITE_TOOLS - set(client_tools)
            if any(t.name in unadvertised for t in registry._tools):
                from .client_write_guard import ClientWriteUnavailableTool
                registry._tools = [
                    ClientWriteUnavailableTool(
                        name=t.name,
                        description=t.description,
                        parameters_schema=t.parameters(),
                        workspace=workspace,
                    ) if t.name in unadvertised else t
                    for t in registry._tools
                ]
                registry._by_name = {t.name: t for t in registry._tools}

        # Client-delegated run_terminal executes on the CLIENT's OS — rebuild
        # its description for that OS (before the delegating wrapper below
        # copies it), so the LLM writes `mkdir -p` for a macOS/Linux client
        # and `mkdir` + `&&` for a Windows client, regardless of the SERVER's
        # platform. Unknown/omitted client_os keeps the server-OS default.
        if client_os and "run_terminal" in (client_tools or ()):
            _os = client_os.strip().lower()
            if _os in ("windows", "win32", "win"):
                _client_is_windows = True
            elif _os in ("macos", "darwin", "mac", "linux", "posix", "freebsd"):
                _client_is_windows = False
            else:
                _client_is_windows = None
            if _client_is_windows is not None:
                for tool in registry._tools:
                    if tool.name == "run_terminal":
                        tool.description = RunTerminalTool.build_description(
                            _client_is_windows
                        )

        # Pattern C: swap client-executed tools for delegating wrappers. Only
        # tools in BOTH the client's advertised set AND the server's authoritative
        # CLIENT_EXECUTABLE_TOOLS are delegated — so a client can never make the
        # server delegate something only the server can do (e.g. run_terminal).
        # The wrapper keeps the same name/description/schema, so the LLM is
        # unaffected; only the execution location changes.
        delegatable = set(client_tools or ()) & cls.CLIENT_EXECUTABLE_TOOLS
        if delegatable:
            from .client_delegating_tool import ClientDelegatingTool
            wrapped: List[BaseTool] = []
            for tool in registry._tools:
                if tool.name in delegatable:
                    wrapped.append(ClientDelegatingTool(
                        name=tool.name,
                        description=tool.description,
                        parameters_schema=tool.parameters(),
                        thread_id=thread_id,
                        workspace=workspace,
                    ))
                else:
                    wrapped.append(tool)
            registry._tools = wrapped
            registry._by_name = {t.name: t for t in wrapped}

        return registry

    def get(self, name: str) -> Optional[BaseTool]:
        """Look up a tool by name. Returns None if it doesn't exist."""
        return self._by_name.get(name)

    def list_tools(self) -> List[BaseTool]:
        """Every tool instance in this registry, in registration order."""
        return list(self._tools)

    def names(self) -> List[str]:
        """Just the names, e.g. for error messages listing what's available."""
        return list(self._by_name.keys())

    def schemas(self) -> List[Dict]:
        """
        JSON schema for every tool, exactly the shape an LLM call
        (or a prompt's tool-description block) needs. Each entry is
        {"name": ..., "description": ..., "parameters": {...}}.
        """
        return [tool.schema() for tool in self._tools]

    def descriptions_text(self) -> str:
        """
        Tool descriptions with parameter signatures, injected into the
        ReAct prompt. Shows exact parameter names so the LLM doesn't
        guess wrong names like 'file_name' instead of 'filename'.
        """
        if not self._tools:
            return "(no tools available)"
        lines = []
        for tool in self._tools:
            sig = _build_signature(tool)
            lines.append(f"- {tool.name}({sig}): {tool.description.strip()}")
        return "\n".join(lines)


def _build_signature(tool: BaseTool) -> str:
    """Build a function-like signature from a tool's JSON schema parameters."""
    params = tool.parameters()
    props = params.get("properties", {})
    required = set(params.get("required", []))
    if not props:
        return ""
    parts = []
    for name, schema in props.items():
        if name in required:
            parts.append(name)
        else:
            parts.append(f'[{name}]')
    return ", ".join(parts)
