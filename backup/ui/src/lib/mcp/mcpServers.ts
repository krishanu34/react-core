/**
 * mcpServers — CRUD over the workspace's .mcp.json for the MCP Servers panel.
 *
 * The UI is an EDITOR over .mcp.json, never a separate store: .mcp.json stays
 * the single source of truth (Claude Code's format), so a CLI/IDE client reading
 * the same file behaves identically. Reads/writes go through the transport-
 * agnostic FileAccess (daemon or FS-API), like any other workspace file.
 *
 * Default scope is the project file (.mcp.json); user scope (~/.devaccel via the
 * daemon /state) can come later — this module keeps the file shape identical so
 * that's a drop-in.
 */

import type { FileAccess } from "@/lib/fileAccess";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

const CONFIG_FILE = ".mcp.json";
export const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

/* ── Typed add presets (all reduce to the two real transports) ────────────────
   The UI offers Command / HTTP / NPM / Pip / Docker like other MCP clients, but
   NPM/Pip/Docker are just stdio commands under the hood. buildServerEntry turns
   a form into a McpServerEntry; the stored .mcp.json entry is always plain
   stdio (command/args) or http/sse (url). */
export type AddType = "command" | "http" | "npm" | "pip" | "docker";

export interface AddForm {
  type: AddType;
  name: string;
  // command
  command?: string;
  args?: string;      // space-separated
  // http/sse
  url?: string;
  sse?: boolean;
  // npm / pip / docker
  pkg?: string;       // package name (npm/pip) or image (docker)
  extraArgs?: string; // appended after the package/image
  // secrets / config
  env?: Record<string, string>;     // stdio
  headers?: Record<string, string>; // http/sse
}

function splitArgs(s?: string): string[] {
  const t = (s ?? "").trim();
  if (!t) return [];
  // Users often paste a JSON array, e.g. ["-m", "mcp_atlassian"] — parse it as
  // one rather than space-splitting it into broken tokens.
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((x) => String(x));
    } catch { /* not valid JSON — fall through to token split */ }
  }
  // Otherwise split on whitespace, honouring simple quotes so paths with
  // spaces (e.g. "C:/Program Files/x") stay a single argument.
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Translate the typed add form into a stored server entry. Throws on bad input. */
export function buildServerEntry(f: AddForm): McpServerEntry {
  const name = (f.name ?? "").trim();
  if (!SAFE_NAME.test(name)) throw new Error(`Name must match ${SAFE_NAME.source}`);
  const env = f.env && Object.keys(f.env).length ? f.env : undefined;

  switch (f.type) {
    case "http": {
      const url = (f.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("URL must be http(s).");
      return { name, transport: f.sse ? "sse" : "http", url, enabled: true,
               headers: f.headers && Object.keys(f.headers).length ? f.headers : undefined };
    }
    case "command": {
      const command = (f.command ?? "").trim();
      if (!command) throw new Error("Command is required.");
      return { name, transport: "stdio", command, args: splitArgs(f.args), env, enabled: true };
    }
    case "npm": {
      const pkg = (f.pkg ?? "").trim();
      if (!pkg) throw new Error("NPM package name is required.");
      return { name, transport: "stdio", command: "npx",
               args: ["-y", pkg, ...splitArgs(f.extraArgs)], env, enabled: true };
    }
    case "pip": {
      const pkg = (f.pkg ?? "").trim();
      if (!pkg) throw new Error("Pip package name is required.");
      // uvx runs a pip package in an isolated env without a manual install.
      return { name, transport: "stdio", command: "uvx",
               args: [pkg, ...splitArgs(f.extraArgs)], env, enabled: true };
    }
    case "docker": {
      const image = (f.pkg ?? "").trim();
      if (!image) throw new Error("Docker image is required.");
      // Forward each env key into the container with -e KEY (value comes from env).
      const eFlags = env ? Object.keys(env).flatMap((k) => ["-e", k]) : [];
      return { name, transport: "stdio", command: "docker",
               args: ["run", "-i", "--rm", ...eFlags, image, ...splitArgs(f.extraArgs)],
               env, enabled: true };
    }
    default:
      throw new Error(`Unknown type: ${f.type}`);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawConfig = { mcpServers?: Record<string, any> } & Record<string, any>;

async function readRaw(access: FileAccess): Promise<RawConfig> {
  try {
    const parsed = JSON.parse(await access.read(CONFIG_FILE));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // missing or malformed — start fresh
  }
}

async function writeRaw(access: FileAccess, obj: RawConfig): Promise<void> {
  await access.write(CONFIG_FILE, JSON.stringify(obj, null, 2) + "\n");
}

function inferTransport(entry: any): McpTransport {
  if (typeof entry?.command === "string") return "stdio";
  if (String(entry?.type ?? "").toLowerCase() === "sse") return "sse";
  return "http";
}

/** All servers declared in .mcp.json, mapped to the panel's shape. */
export async function readMcpServers(access: FileAccess): Promise<McpServerEntry[]> {
  const raw = await readRaw(access);
  const servers = raw.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const out: McpServerEntry[] = [];
  for (const [name, e] of Object.entries<any>(servers)) {
    if (name === "//") continue; // comment key
    const transport = inferTransport(e);
    out.push({
      name,
      transport,
      command: e.command,
      args: Array.isArray(e.args) ? e.args : [],
      env: e.env && typeof e.env === "object" ? e.env : {},
      url: e.url,
      headers: e.headers && typeof e.headers === "object" ? e.headers : {},
      enabled: e.enabled !== false && e.disabled !== true,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Serialize a panel entry back into a .mcp.json entry (omit empties). */
function toRawEntry(entry: McpServerEntry): any {
  const e: any = {};
  if (entry.transport === "stdio") {
    e.command = entry.command ?? "";
    if (entry.args && entry.args.length) e.args = entry.args;
    if (entry.env && Object.keys(entry.env).length) e.env = entry.env;
  } else {
    e.url = entry.url ?? "";
    if (entry.transport === "sse") e.type = "sse";
    if (entry.headers && Object.keys(entry.headers).length) e.headers = entry.headers;
  }
  // Only persist the flag when disabled — enabled is the default.
  if (!entry.enabled) e.enabled = false;
  return e;
}

/** Add or replace a server. Throws on an invalid name. */
export async function upsertMcpServer(access: FileAccess, entry: McpServerEntry): Promise<void> {
  if (!SAFE_NAME.test(entry.name)) {
    throw new Error(`Server name must match ${SAFE_NAME.source}`);
  }
  const raw = await readRaw(access);
  raw.mcpServers = raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {};
  raw.mcpServers[entry.name] = toRawEntry(entry);
  await writeRaw(access, raw);
}

export async function removeMcpServer(access: FileAccess, name: string): Promise<void> {
  const raw = await readRaw(access);
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    delete raw.mcpServers[name];
    await writeRaw(access, raw);
  }
}

/**
 * Import raw JSON — paste a full `.mcp.json` ({ "mcpServers": {...} }) or a bare
 * map of { name: entry }. Entries are written VERBATIM (command/args/env exactly
 * as given), so nothing gets mangled by the form fields. Merges into the current
 * config (keeps existing servers). Returns the server names imported.
 */
export async function importServersJson(access: FileAccess, jsonText: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const root = parsed as { mcpServers?: unknown } | Record<string, unknown>;
  const servers = (root && typeof (root as { mcpServers?: unknown }).mcpServers === "object"
    ? (root as { mcpServers: Record<string, unknown> }).mcpServers
    : root) as Record<string, unknown>;
  if (!servers || typeof servers !== "object") {
    throw new Error('Expected { "mcpServers": { … } } or a { name: {…} } object.');
  }

  const raw = await readRaw(access);
  raw.mcpServers = raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {};
  const added: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (name === "//") continue;
    if (!SAFE_NAME.test(name)) throw new Error(`Invalid server name '${name}' (letters, digits, _ and - only).`);
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== "string" && typeof e.url !== "string") {
      throw new Error(`Server '${name}' needs a "command" (local) or "url" (remote).`);
    }
    raw.mcpServers[name] = entry; // verbatim — no field mangling
    added.push(name);
  }
  if (added.length === 0) throw new Error("No servers found in the JSON.");
  await writeRaw(access, raw);
  return added;
}

export async function setMcpServerEnabled(
  access: FileAccess,
  name: string,
  enabled: boolean,
): Promise<void> {
  const raw = await readRaw(access);
  const e = raw.mcpServers?.[name];
  if (!e || typeof e !== "object") return;
  if (enabled) {
    delete e.enabled;
    delete e.disabled;
  } else {
    e.enabled = false;
  }
  await writeRaw(access, raw);
}
