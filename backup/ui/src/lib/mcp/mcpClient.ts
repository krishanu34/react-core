/**
 * mcpClient — browser side of local MCP (Pattern C).
 *
 * Starts the workspace's local stdio MCP servers via the daemon and produces the
 * manifest the backend needs (mcp_local_tools), then executes mcp__server__tool
 * calls by proxying to the daemon. The DevSphere backend delegates these tools
 * (ClientDelegatingTool) exactly like run_terminal, so this file is where the
 * `client_tool_use` for an mcp__ name is actually run.
 */

import * as agent from "@/lib/fileAccess/agentClient";
import type { FileAccess } from "@/lib/fileAccess";
import { readLocalMcpServers } from "./mcpConfig";

const NAME_SEP = "__";
const PREFIX = "mcp" + NAME_SEP;

export function isMcpToolName(name: string): boolean {
  return name.startsWith(PREFIX);
}

/** Split mcp__<server>__<tool> back into its parts (tool may itself contain __). */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(PREFIX.length);
  const i = rest.indexOf(NAME_SEP);
  if (i <= 0) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + NAME_SEP.length) };
}

/** True when this workspace can host local MCP servers (daemon transport only —
 *  the browser File System Access API has no shell to spawn processes). */
function daemonRootId(access: FileAccess): string | null {
  const a = access as unknown as { kind?: string; stateId?: string; exec?: unknown };
  if (a.kind === "agent" && typeof a.exec === "function" && a.stateId) return a.stateId;
  return null;
}

// Manifest cache keyed by daemon rootId — the daemon keeps servers running
// across messages, so we start them once per workspace and reuse the manifest
// instead of restarting stdio processes on every turn. `force` re-reads config
// (e.g. after the user edits .mcp.json).
const manifestCache = new Map<string, string | undefined>();

export function invalidateLocalMcpCache(): void {
  manifestCache.clear();
}

/**
 * Start the workspace's local stdio MCP servers via the daemon and return the
 * manifest JSON to send to the backend as `mcp_local_tools` — or undefined when
 * there are none / no daemon. Shape: {"<server>": {"tools": [...] | "error": ...}}.
 */
export async function startLocalMcpServers(
  access: FileAccess,
  force = false,
): Promise<string | undefined> {
  const rootId = daemonRootId(access);
  if (!rootId) return undefined;
  if (!force && manifestCache.has(rootId)) return manifestCache.get(rootId);
  const servers = await readLocalMcpServers(access);
  if (servers.length === 0) {
    manifestCache.set(rootId, undefined);
    return undefined;
  }
  try {
    const results = await agent.mcpStart(rootId, servers);
    const manifest = JSON.stringify(results);
    manifestCache.set(rootId, manifest);
    return manifest;
  } catch {
    return undefined; // daemon down / start failed — proceed with native tools
  }
}

/** Execute an mcp__server__tool call on the daemon; flatten to the agent's result shape. */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = parseMcpToolName(name);
  if (!parsed) return { error: `Malformed MCP tool name: ${name}` };
  try {
    const r = await agent.mcpCall(parsed.server, parsed.tool, args || {});
    if (r.error) return { error: `MCP tool error: ${r.error}` };
    return { output: flattenMcpResult(r.result) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** MCP CallToolResult → plain text (mirrors the Python _stringify_result). */
function flattenMcpResult(result: unknown): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  } | null;
  if (r == null) return "(no content)";
  const parts: string[] = [];
  for (const block of r.content ?? []) {
    if (typeof block?.text === "string") parts.push(block.text);
    else parts.push(`[${block?.type ?? "content"} block]`);
  }
  if (parts.length === 0 && r.structuredContent != null) {
    parts.push(JSON.stringify(r.structuredContent));
  }
  const text = parts.length ? parts.join("\n") : "(no content)";
  return r.isError ? `MCP tool error: ${text}` : text;
}
