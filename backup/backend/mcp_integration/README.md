# `mcp_integration/` — Model Context Protocol for DevSphere

This folder makes DevSphere speak **MCP** (the open standard Claude Code uses to
plug in external tools). Two directions:

1. **Client** — DevSphere *consumes* external MCP servers (GitHub, Postgres,
   Playwright, a local filesystem server…). Their tools show up to the agent as
   `mcp__<server>__<tool>`, right next to the native tools.
2. **Server** — DevSphere *exposes* a safe subset of its own tools as an MCP
   server, so Claude Desktop / Cursor / VS Code can drive them.

> **Why the folder is `mcp_integration`, not `mcp`:** the app runs with
> `devsphere_ai/` on `sys.path`, so a package named `mcp` here would shadow the
> installed `mcp` PyPI SDK. Distinct name → both import cleanly.

## Layout

```
mcp_integration/
  schemas.py        # our config model (MCPServerConfig, transports, scopes)
  config.py         # load + validate .mcp.json across user/project/local scopes
  client/           # DevSphere AS CLIENT (consume external servers)   [Phase 1–2]
    manager.py        # connect/list/call/close every configured server
    connection.py     # one live SDK session (initialize → list → call)
    tool_adapter.py   # MCPTool(BaseTool): one remote tool as a native tool
    transports/
      http.py             # remote Streamable HTTP / SSE
      stdio_via_daemon.py # local stdio, proxied through the daemon (Pattern C)
  server/           # DevSphere AS SERVER (expose our tools)           [Phase 3]
    app.py            # FastMCP app serving a curated tool subset
    registry_bridge.py# ToolRegistry tools → MCP tool defs
```

## How it plugs in (no agent changes)

Each external MCP tool is wrapped as a `BaseTool` (`tool_adapter.MCPTool`), so it
flows through the SAME path as every native tool:

`ToolRegistry.build_for_workspace` → `_build_tool_schemas()` →
`check_tool_permission()` → `_call_tool()`

The agent loop can't tell an MCP tool from a native one.

## Where servers run (Pattern C)

- **stdio** servers run on the **user's machine via the daemon** — their files
  and secrets never touch the DevSphere backend.
- **http/sse** servers are reached **from the backend** — good for network APIs
  whose credentials the backend holds.

## `.mcp.json`

Claude Code's exact format — see `../config/mcp.example.json`. Scopes, low → high
precedence: user `~/.devaccel/mcp.json` → project `.mcp.json` → local
`.mcp.local.json`.

## Running DevSphere AS an MCP server (expose our tools)

Serves a curated, safe subset of DevSphere's tools (see
`server/registry_bridge.py::DEFAULT_EXPOSED_TOOLS`) to any MCP client. Run from
the `devsphere_ai/` directory so imports resolve:

```bash
# stdio — how Claude Desktop / Cursor launch it
python -m mcp_integration.server.app --workspace /path/to/project

# streamable HTTP — reachable by remote MCP clients at /mcp
python -m mcp_integration.server.app --transport http --port 3335 --workspace .
```

Point a client at it (Claude Desktop / another DevSphere, `.mcp.json`):

```json
{ "mcpServers": { "devsphere": {
  "command": "python",
  "args": ["-m", "mcp_integration.server.app", "--workspace", "."]
} } }
```

Env knobs: `MCP_SERVER_WORKSPACE`, `MCP_SERVER_TRANSPORT`, `MCP_SERVER_HOST`,
`MCP_SERVER_PORT`, `MCP_SERVER_TOOLS` (override the exposed set),
`MCP_SERVER_ALLOW_EXEC=true` (also expose run_terminal/git — a shell over MCP is
arbitrary code execution; trusted deployments only). Inspect it with
`npx @modelcontextprotocol/inspector`.

## Security

`env` / `headers` values are secrets — never logged (`MCPServerConfig.redacted`),
never sent to the model. Server names are charset-restricted. Remote URLs must be
http(s). Mutating MCP tools go through the normal `ask`-mode approval. As a
SERVER, exec tools are off by default and every exposed write still honours the
read-before-overwrite guard.
