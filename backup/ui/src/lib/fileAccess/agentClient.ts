/**
 * agentClient — browser-side client for the DevAccel local daemon.
 *
 * The daemon runs on the user's machine and binds a port in a fixed range
 * (see daemon/config.js). A browser page can't read ~/.devaccel/daemon.json,
 * so it DISCOVERS the daemon by probing that range for /health, then PAIRS
 * (POST /pair) to obtain a token used on every /fs/* call.
 *
 * All requests are cross-origin (page → 127.0.0.1); the daemon returns CORS
 * headers only for allowlisted origins. Over a plain-HTTP page this is not
 * mixed content; over HTTPS, loopback is still permitted by browsers.
 */

/** Must stay in sync with daemon/config.js PORT_RANGE_START..END. */
import { getToken } from "@/lib/auth";
import { clearDaemonInstalled } from "@/lib/daemon-install-state";

const AGENT_PORTS = [17872, 17873, 17874, 17875, 17876, 17877, 17878, 17879];
const PROBE_TIMEOUT_MS = 400;
const TOKEN_KEY = "devaccel.agent.token";

interface DaemonInfo { name: string; version: string; platform?: string }

let cachedBase: string | null = null;
let cachedToken: string | null = null;
/** OS the daemon runs on (node process.platform: win32|darwin|linux) —
 *  i.e. the OS delegated /exec commands execute on. Cached from /health. */
let cachedPlatform: string | null = null;

/** The daemon host's OS, if a daemon has been discovered ("win32" |
 *  "darwin" | "linux" | null). Forward this to the backend as client_os so
 *  the model composes commands for the machine that runs them. */
export function getDaemonPlatform(): string | null {
  return cachedPlatform;
}

function readStoredToken(): string | null {
  if (cachedToken) return cachedToken;
  try { cachedToken = sessionStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }
  return cachedToken;
}

function storeToken(token: string): void {
  cachedToken = token;
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = PROBE_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Don't re-scan for this long after a full scan found nothing. */
const MISS_TTL_MS = 10_000;
let lastMissAt = 0;

/**
 * Probe the port range for a running daemon. Caches the base URL.
 * All ports are probed IN PARALLEL (~one timeout total, not one per port), and
 * a negative result is cached for MISS_TTL_MS so multiple callers don't each
 * re-fire a full scan of failing requests.
 */
export async function discover(force = false): Promise<string | null> {
  if (cachedBase && !force) return cachedBase;
  if (!force && Date.now() - lastMissAt < MISS_TTL_MS) return null;

  const probes = AGENT_PORTS.map(async (port): Promise<string | null> => {
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetchWithTimeout(`${base}/health`, { method: "GET" });
      if (!res.ok) return null;
      const info = (await res.json()) as DaemonInfo;
      if (info && info.name === "devaccel-daemon") {
        if (info.platform) cachedPlatform = info.platform;
        return base;
      }
      return null;
    } catch {
      return null; // port not listening / not ours
    }
  });

  const results = await Promise.all(probes);
  cachedBase = results.find((r) => r !== null) ?? null;
  if (!cachedBase) lastMissAt = Date.now();
  return cachedBase;
}

/** True if the daemon is reachable. */
export async function isAgentAvailable(): Promise<boolean> {
  return (await discover()) !== null;
}

/**
 * Fetch the daemon's health/version, forcing a fresh probe. Returns null when
 * the daemon isn't reachable. Used by the Setup Daemon tab to show a live
 * connection status + version.
 */
export async function getHealth(): Promise<{ version: string; name: string } | null> {
  const base = await discover(true).catch(() => null);
  if (!base) return null;
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: "GET" }, 800);
    if (!res.ok) return null;
    const info = (await res.json()) as DaemonInfo;
    return info && info.name === "devaccel-daemon" ? { version: info.version, name: info.name } : null;
  } catch {
    return null;
  }
}

/** Forget the cached base URL/token — call after the daemon stops/uninstalls. */
export function resetDiscovery(): void {
  cachedBase = null;
  cachedToken = null;
  cachedPlatform = null;
  lastMissAt = 0;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/**
 * Lightweight LIVENESS check — a single request to the known base URL (or the
 * primary port if not yet discovered). Unlike a bare cache read, this actually
 * probes each call, so polling detects the daemon going DOWN (e.g. after Stop),
 * not just coming up. On failure it clears the stale cache so status flips to
 * "not connected" immediately.
 */
export async function quickDetect(): Promise<boolean> {
  const base = cachedBase || `http://127.0.0.1:${AGENT_PORTS[0]}`;
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: "GET" }, 500);
    if (!res.ok) { if (cachedBase === base) cachedBase = null; return false; }
    const info = (await res.json()) as DaemonInfo;
    if (info && info.name === "devaccel-daemon") {
      cachedBase = base;
      if (info.platform) cachedPlatform = info.platform;
      return true;
    }
  } catch { /* not running / just stopped */ }
  if (cachedBase === base) cachedBase = null;
  return false;
}

/**
 * The app-relative endpoint the daemon calls back to verify a DevAccel session.
 * Proxied to the backend by ui/src/app/workspace-api/[...path]/route.ts → :8003.
 */
function verifyUrl(): string {
  return `${window.location.origin}/workspace-api/daemon/verify`;
}

/** Ensure we have a base URL and a valid token; returns them or throws. */
async function ensureReady(): Promise<{ base: string; token: string }> {
  const base = await discover();
  if (!base) throw new Error("DevAccel daemon is not running.");
  let token = readStoredToken();
  if (!token) {
    // Session-bound pairing (Story 4): hand the daemon our DevAccel session
    // token + the verify URL so it can confirm we're a logged-in user before
    // issuing a daemon token.
    const sessionToken = getToken();
    const res = await fetchWithTimeout(
      `${base}/pair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, verifyUrl: verifyUrl() }),
      },
      6000,
    );
    if (!res.ok) {
      let msg = `Daemon pairing failed (${res.status}).`;
      try { const e = await res.json(); if (e?.message) msg = e.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const body = await res.json();
    token = body.token as string;
    storeToken(token);
  }
  return { base, token };
}

/** Low-level authed request to a daemon endpoint. Re-pairs once on 401. */
async function call<T>(method: string, endpoint: string, body?: unknown, retry = true, timeoutMs = 30000): Promise<T> {
  const { base, token } = await ensureReady();
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetchWithTimeout(`${base}${endpoint}`, init, timeoutMs);
  if (res.status === 401 && retry) {
    // Token invalidated (e.g. daemon restarted) — clear and pair again.
    cachedToken = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    return call<T>(method, endpoint, body, false, timeoutMs);
  }
  if (!res.ok) {
    let msg = `Daemon request failed (${res.status})`;
    try { const e = await res.json(); if (e?.message) msg = e.message; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/* ── Typed endpoint wrappers ─────────────────────────────────────────────── */

export interface WsNodeDTO { path: string; type: "file" | "folder"; parentPath: string }

/**
 * Register an absolute folder path as a workspace root; returns its rootId.
 * Pass `create: true` when saving uploaded files to a folder that may not
 * exist yet (the daemon will `mkdir -p` it).
 */
export async function openRoot(absPath: string, create = false): Promise<{ rootId: string; root: string }> {
  return call("POST", "/fs/open", { root: absPath, create });
}

/**
 * Batch-check which absolute paths exist AS DIRECTORIES on this machine —
 * read-only, never registers roots (daemon /fs/exists). Returns null when the
 * check can't run (daemon down, or an older daemon build without the
 * endpoint) so callers can FAIL OPEN instead of hiding workspaces silently.
 */
export async function pathsExist(paths: string[]): Promise<Record<string, boolean> | null> {
  if (paths.length === 0) return {};
  try {
    const r = await call<{ exists: Record<string, boolean> }>("POST", "/fs/exists", { paths });
    return r.exists ?? {};
  } catch {
    return null; // unknown — caller shows everything
  }
}

/**
 * Open the native OS folder dialog on the user's machine and return the chosen
 * absolute path — or null if the user canceled or no picker is available.
 * Long timeout (5 min) since the user is interacting with a dialog.
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const r = await call<{ path?: string; canceled?: boolean; error?: string }>(
      "POST", "/fs/pick-folder", {}, true, 5 * 60 * 1000,
    );
    return r.path ?? null;
  } catch {
    return null;
  }
}
export async function scan(rootId: string): Promise<WsNodeDTO[]> {
  const r = await call<{ nodes: WsNodeDTO[] }>("GET", `/fs/scan?rootId=${encodeURIComponent(rootId)}`);
  return r.nodes;
}
export async function readFile(rootId: string, path: string): Promise<string> {
  const r = await call<{ content: string }>(
    "GET",
    `/fs/read?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
  );
  return r.content;
}
/**
 * Raw bytes for a file the caller needs to PARSE rather than display.
 *
 * Base64 over the daemon's JSON transport — the wire cost is 4/3 of the file,
 * which is why `maxBytes` is passed through and enforced daemon-side before
 * the read happens rather than after.
 */
/**
 * Grep executed BY THE DAEMON, beside the disk. One round trip returns the
 * finished result — the previous client grep pulled every file's content over
 * HTTP (one /fs/read per file), which on real legacy repos meant thousands of
 * round trips and regular 120s client-tool timeouts.
 *
 * `options` passes through to daemon search.js: file_pattern, output_mode
 * (content | files_with_matches | count), context, case_sensitive, multiline,
 * head_limit, offset. Result shape matches the server's grep_search_tool.py.
 */
export async function grepSearch(
  rootId: string,
  query: string,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>("POST", "/fs/grep", {
    rootId,
    query,
    ...options,
  });
}

/** Glob executed by the daemon — results sorted newest-modified first (the
 * Claude Code Glob ordering; recency is the strongest relevance signal on an
 * existing codebase). */
export async function globSearch(
  rootId: string,
  pattern: string,
  searchPath?: string,
  includeIgnored?: boolean,
): Promise<Record<string, unknown>> {
  const p = searchPath ? `&path=${encodeURIComponent(searchPath)}` : "";
  // Sent only when true. The daemon compares against the string "true", so an
  // absent parameter and an explicit false behave identically.
  const inc = includeIgnored ? "&include_ignored=true" : "";
  return call<Record<string, unknown>>(
    "GET",
    `/fs/glob?rootId=${encodeURIComponent(rootId)}&pattern=${encodeURIComponent(pattern)}${p}${inc}`,
  );
}

export async function readFileBytes(
  rootId: string,
  path: string,
  maxBytes?: number,
): Promise<Uint8Array> {
  const cap = maxBytes ? `&maxBytes=${maxBytes}` : "";
  const r = await call<{ base64: string }>(
    "GET",
    `/fs/read-bytes?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}${cap}`,
  );
  const binary = atob(r.base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
export async function writeFile(rootId: string, path: string, content: string): Promise<void> {
  await call("PUT", "/fs/write", { rootId, path, content });
}
/** Write raw bytes (base64 over the JSON transport) — see readFileBytes. */
export async function writeFileBytes(
  rootId: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  let binary = "";
  const CHUNK = 0x8000; // fromCharCode(...) blows the argument limit past ~100 KB
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  await call("PUT", "/fs/write-bytes", { rootId, path, base64: btoa(binary) });
}
export async function createEntry(rootId: string, path: string, type: "file" | "folder"): Promise<void> {
  await call("POST", "/fs/create", { rootId, path, type });
}
export async function removeEntry(rootId: string, path: string): Promise<void> {
  await call("DELETE", "/fs/entry", { rootId, path });
}
export async function renameEntry(rootId: string, oldPath: string, newPath: string): Promise<void> {
  await call("POST", "/fs/rename", { rootId, oldPath, newPath });
}

/* ── Per-user agent state (~/.devaccel) — Claude Code's ~/.claude parity ──
   Session transcripts + thread memory live canonically on the user's machine
   (projects/<rootId>/…); the app server only caches. */

export async function readStateFile(relPath: string): Promise<string | null> {
  try {
    const r = await call<{ content: string }>("GET", `/state?path=${encodeURIComponent(relPath)}`);
    return r.content ?? null;
  } catch {
    return null; // not found / old daemon / not paired — caller falls back
  }
}

export async function writeStateFile(relPath: string, content: string): Promise<void> {
  await call("PUT", "/state", { path: relPath, content });
}

/** One runtime's availability on the user's machine (POST /runtimes/check). */
export interface RuntimeStatus {
  available: boolean;
  version?: string | null;
  runtime?: string; // human name, e.g. "Python" (present when missing + known)
  install?: string; // install source hint (present when missing + known)
}

/** Which of the given binaries exist on the user's machine, with versions. */
export async function checkRuntimes(binaries: string[]): Promise<Record<string, RuntimeStatus>> {
  const r = await call<{ runtimes: Record<string, RuntimeStatus> }>(
    "POST", "/runtimes/check", { binaries }, true, 20000,
  );
  return r.runtimes ?? {};
}

/* ── Local MCP servers (Pattern C) ───────────────────────────────────────────
 * The daemon spawns stdio MCP servers on the user's machine and proxies to
 * them, so their tools run where the user's files/secrets live — the DevSphere
 * backend can't reach 127.0.0.1 here. Same token-gated transport as /exec. */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
/** Per-server result of /mcp/start: its tool list, or an error if it failed. */
export type McpStartResult = Record<string, { tools?: McpToolDef[]; error?: string }>;

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Start (or restart) local stdio MCP servers; returns each server's tools. */
export async function mcpStart(rootId: string, servers: McpServerSpec[]): Promise<McpStartResult> {
  const r = await call<{ results: McpStartResult }>(
    "POST", "/mcp/start", { rootId, servers }, true, 60000,
  );
  return r.results ?? {};
}

/** Call one tool on a running local MCP server. Returns the raw MCP result or an error. */
export async function mcpCall(
  name: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ result?: unknown; error?: string }> {
  return call("POST", "/mcp/call", { name, tool, arguments: args }, true, 130000);
}

/** Stop one local MCP server (or all when name is omitted). Best-effort. */
export async function mcpStop(name?: string): Promise<void> {
  await call("POST", "/mcp/stop", name ? { name } : {}, true, 10000).catch(() => {});
}

/** Result of a delegated run_terminal/git — mirrors the server tool's shape. */
export interface ExecResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  truncated?: boolean;
  timed_out?: boolean;
  error?: string;
  // runtime_missing extras — the agent turns these into setup guidance
  runtime?: string;
  binary?: string;
  suggestion?: string;
  command?: string;
}

/**
 * Execute a shell command in the registered workspace root on the user's
 * machine (POST /exec). Network timeout = command timeout + slack so the
 * daemon (which enforces the real timeout and kills the process tree) always
 * answers first.
 *
 * With `onLine`, the daemon streams NDJSON ({type:"line"} per output line,
 * then {type:"done", result}) so the caller can render live terminal output;
 * the final result is identical either way. A daemon that ignores the stream
 * flag (older build) returns one plain JSON object — parsed the same.
 */
export async function exec(
  rootId: string,
  command: string,
  timeoutSeconds = 60,
  onLine?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<ExecResult> {
  if (!onLine) {
    return call("POST", "/exec", { rootId, command, timeoutSeconds }, true, (timeoutSeconds + 30) * 1000);
  }
  return execStreaming(rootId, command, timeoutSeconds, onLine, true);
}

async function execStreaming(
  rootId: string,
  command: string,
  timeoutSeconds: number,
  onLine: (stream: "stdout" | "stderr", line: string) => void,
  retryOn401: boolean,
): Promise<ExecResult> {
  const { base, token } = await ensureReady();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (timeoutSeconds + 30) * 1000);
  try {
    const res = await fetch(`${base}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rootId, command, timeoutSeconds, stream: true }),
      signal: ctrl.signal,
    });
    if (res.status === 401 && retryOn401) {
      // Token invalidated (daemon restarted) — clear, re-pair, retry once.
      cachedToken = null;
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      clearTimeout(t);
      return execStreaming(rootId, command, timeoutSeconds, onLine, false);
    }
    if (!res.ok) {
      let msg = `Daemon request failed (${res.status})`;
      try { const e = await res.json(); if (e?.message) msg = e.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    if (!res.body) return (await res.json()) as ExecResult;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ExecResult | null = null;
    const consume = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line) as { type?: string; stream?: string; line?: string; result?: ExecResult } & ExecResult;
        if (msg.type === "line") onLine(msg.stream === "stderr" ? "stderr" : "stdout", msg.line ?? "");
        else if (msg.type === "done") result = msg.result ?? null;
        else result = msg; // non-streaming daemon: the whole body is the result
      } catch { /* partial/garbled frame — ignore */ }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      parts.forEach(consume);
    }
    consume(buffer);
    return result ?? { error: "Daemon stream ended without a result.", command };
  } finally {
    clearTimeout(t);
  }
}

/* ── Daemon lifecycle control (Setup Daemon tab) ─────────────────────────────
 * The daemon responds 200 then exits, so the socket may drop around the
 * response — ONLY that network drop (TypeError) or a timeout (AbortError) is
 * the alternate success signal. HTTP errors are REAL failures and must
 * surface: swallowing them showed "Daemon stopped/uninstalled" while the
 * daemon kept running (e.g. a stale pairing token after a daemon restart
 * answered 401). `retry=true` lets `call` re-pair transparently on that 401.
 * A 404 means an OLD daemon build without these endpoints — surfaced so the
 * UI can tell the user to re-download or uninstall manually. */
async function daemonControl(endpoint: "/daemon/stop" | "/daemon/uninstall"): Promise<void> {
  try {
    await call("POST", endpoint, {}, true, 10_000);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TypeError" || name === "AbortError") {
      // Connection dropped / timed out — the daemon exited mid-response,
      // which is the expected shutdown on success.
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      resetDiscovery();
      if (/\(404\)/.test(msg)) {
        throw new Error(
          "This daemon build doesn't support remote control. Re-download the latest daemon, or uninstall it manually.",
        );
      }
      throw e instanceof Error ? e : new Error(msg);
    }
  } finally {
    resetDiscovery();
  }
}

/**
 * Poll until NO daemon answers on any port (or the deadline passes). Stop and
 * Uninstall reply 200 ~100ms BEFORE the process exits — and uninstall's
 * auto-start removal can take seconds on managed machines — so callers must
 * wait for the daemon to actually disappear, or the UI re-detects the dying
 * process and shows "connected" right next to a success notice. Also catches
 * a stray second instance the daemon-side cleanup failed to kill.
 */
async function waitForDaemonExit(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if ((await discover(true).catch(() => null)) === null) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function stopDaemon(): Promise<void> {
  await daemonControl("/daemon/stop");
  if (!(await waitForDaemonExit(8000))) {
    throw new Error(
      "Stop was acknowledged but a daemon is still responding — another instance may be running. Try again.",
    );
  }
}
export async function uninstallDaemon(): Promise<void> {
  await daemonControl("/daemon/uninstall");
  // Uninstall removes auto-start via PowerShell before exiting — allow extra time.
  if (!(await waitForDaemonExit(20_000))) {
    throw new Error(
      "Uninstall was acknowledged but a daemon is still responding — another instance may be running. Try again.",
    );
  }
  // The daemon is gone from this machine — forget the installed heuristic so
  // the Setup page offers Install (not Start) next time.
  clearDaemonInstalled();
}
/**
 * Ask the running daemon to self-update: it downloads the binary from `url`
 * (must be https on a host the daemon allowlists), swaps itself and restarts.
 * Unlike stop/uninstall, HTTP-level errors here are REAL failures (bad URL,
 * download failed, old daemon build) and must surface — only a dropped
 * connection/timeout (the old process exiting) counts as success. Long
 * timeout: the daemon downloads ~80 MB before responding.
 */
export async function updateDaemon(url: string): Promise<void> {
  try {
    await call("POST", "/daemon/update", { url }, false, 120_000);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    // fetch network failure (TypeError) or timeout (AbortError) = the daemon
    // exited mid-response, which is the expected shutdown on success.
    if (name !== "TypeError" && name !== "AbortError") throw e;
  } finally {
    resetDiscovery();
  }
}
