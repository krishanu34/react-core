/**
 * mcpConfig — read the workspace's local (stdio) MCP servers from .mcp.json.
 *
 * Only `command`-based (stdio) servers are returned here: those run on the
 * user's machine via the daemon (Pattern C). Remote HTTP/SSE servers are handled
 * server-side from the backend's own config, not here. Reads .mcp.json then
 * .mcp.local.json (local overrides project), matching the backend's scope order.
 */

import type { FileAccess } from "@/lib/fileAccess";

export interface LocalMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Mirror the backend's charset guard (mcp_integration/config.py): the name
// becomes the `<server>` segment of mcp__<server>__<tool>.
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function parseInto(raw: string, into: Map<string, LocalMcpServer>): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // malformed file — ignore rather than break the run
  }
  const servers = (data as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!servers || typeof servers !== "object") return;

  for (const [name, entryRaw] of Object.entries(servers)) {
    if (!SAFE_NAME.test(name)) continue;
    const entry = entryRaw as Record<string, unknown>;
    if (!entry || typeof entry !== "object") continue;

    const enabled = entry.enabled !== false && entry.disabled !== true;
    if (!enabled) continue;

    // Only stdio/local servers here (must have a command).
    if (typeof entry.command !== "string") continue;

    into.set(name, {
      name,
      command: entry.command,
      args: Array.isArray(entry.args)
        ? (entry.args.filter((a) => typeof a === "string") as string[])
        : [],
      env:
        entry.env && typeof entry.env === "object"
          ? (entry.env as Record<string, string>)
          : {},
    });
  }
}

/** Local stdio MCP servers declared in the workspace (.mcp.json + .mcp.local.json). */
export async function readLocalMcpServers(access: FileAccess): Promise<LocalMcpServer[]> {
  const merged = new Map<string, LocalMcpServer>();
  for (const file of [".mcp.json", ".mcp.local.json"]) {
    try {
      const raw = await access.read(file);
      parseInto(raw, merged);
    } catch {
      /* file absent — fine */
    }
  }
  return Array.from(merged.values());
}
