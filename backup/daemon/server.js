"use strict";

/**
 * server.js — the DevAccel local daemon HTTP API.
 *
 * SECURITY POSTURE
 *   • Binds 127.0.0.1 ONLY — never reachable from another machine.
 *   • CORS + Origin allowlist — only the DevAccel web app origin(s) may call it,
 *     so a random website open in the same browser cannot reach 127.0.0.1.
 *   • Token pairing — an allowlisted origin calls POST /pair to obtain a token;
 *     every /fs/* request must present it. Blocks unauthenticated local callers.
 *   • Path sandbox — all file I/O confined to a registered workspace root
 *     (see fs.js resolveInRoot).
 *
 * Endpoints
 *   GET  /health                      → { ok, name, version }         (discovery, no auth)
 *   POST /pair                        → { token }                     (origin-gated)
 *   POST /fs/open   {root}            → { rootId, root }              (register a folder)
 *   POST /fs/exists {paths:[...]}     → { exists: {path: bool} }      (read-only, no root registration)
 *   GET  /fs/scan?rootId=             → { nodes: [...] }
 *   GET  /fs/read?rootId=&path=       → { content }
 *   GET  /fs/read-bytes?rootId=&path= → { base64, size }   (raw bytes, for
 *                                       document extraction — /fs/read decodes
 *                                       as UTF-8 and destroys binary formats)
 *   POST /fs/grep   {rootId,query,...} → grep results      (search runs HERE,
 *                                       beside the disk — the browser doing it
 *                                       meant one /fs/read round trip per file)
 *   GET  /fs/glob?rootId=&pattern=&path= → { files } sorted newest-modified first
 *   PUT  /fs/write  {rootId,path,content}
 *   PUT  /fs/write-bytes {rootId,path,base64} → { ok, size }   (raw bytes, for
 *                                       saving an attachment unmodified)
 *   POST /fs/create {rootId,path,type}
 *   DELETE /fs/entry {rootId,path}
 *   POST /fs/rename {rootId,oldPath,newPath}
 *   POST /exec      {rootId,command,timeoutSeconds[,stream]}
 *                                     → { stdout, stderr, exit_code, ... }  (token-gated)
 *                                       runs the command in the registered root — this is
 *                                       what lets run_terminal/git execute on the USER's
 *                                       machine (Claude Code model) instead of the server.
 *                                       stream:true → NDJSON live output lines.
 *   POST /runtimes/check {binaries:[...]}
 *                                     → { runtimes: {node:{available,version},...} }
 *                                       proactive language-runtime availability report
 *   GET  /state?path=projects/…       → { content }                   (token-gated)
 *   PUT  /state    {path,content}     → { ok }
 *                                       per-user agent state under ~/.devaccel
 *                                       (sessions, thread memory, DEVACCEL.md) —
 *                                       the Claude Code ~/.claude equivalent
 *   POST /daemon/stop                 → { ok }  then exits            (token-gated)
 *   POST /daemon/uninstall            → { ok }  remove auto-start + self-delete, then exits
 *   POST /daemon/update {url}         → { ok }  download new binary (allowlisted
 *                                       host only) + relaunch via install, then exits
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const url = require("url");

const cfg = require("./config");
const execx = require("./exec");
const fsx = require("./fs");
const searchx = require("./search");
const pick = require("./pick");
const statex = require("./state");
const mcpx = require("./mcp/stdio-host");

/* ── In-memory session tokens + persistent root registry ─────────────────── */
const tokens = new Set(); // issued pairing tokens (per daemon lifetime)
/** rootId -> absolute path */
const roots = new Map();

function rootIdFor(absPath) {
  return crypto.createHash("sha256").update(path.resolve(absPath)).digest("hex").slice(0, 16);
}

async function loadRoots() {
  try {
    const raw = await fsp.readFile(cfg.ROOTS_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [id, p] of Object.entries(obj)) roots.set(id, p);
  } catch { /* no roots yet */ }
}

async function persistRoots() {
  const obj = Object.fromEntries(roots.entries());
  await fsp.mkdir(cfg.STATE_DIR, { recursive: true });
  await fsp.writeFile(cfg.ROOTS_FILE, JSON.stringify(obj, null, 2), "utf8");
}

/* ── HTTP helpers ─────────────────────────────────────────────────────────── */
function send(res, status, body, extraHeaders = {}) {
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && cfg.isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-DevAccel-Token");
    res.setHeader("Access-Control-Max-Age", "600");
    return true;
  }
  return !origin; // requests with no Origin (curl/CLI) are allowed; browser cross-origin without allow is blocked
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser callers (CLI/curl)
  return cfg.isOriginAllowed(origin);
}

function getToken(req) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return req.headers["x-devaccel-token"] || null;
}

function requireToken(req, res) {
  const t = getToken(req);
  if (!t || !tokens.has(t)) {
    send(res, 401, { error: "unauthorized", message: "Pair with the daemon first (POST /pair)." });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) { // 50MB guard
        reject(Object.assign(new Error("Body too large"), { code: "E2BIG" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** True if verifyUrl's origin matches the (already-allowlisted) pairing origin. */
function verifyUrlMatchesOrigin(verifyUrl, origin) {
  try {
    return cfg.normalizeOrigin(new URL(verifyUrl).origin) === cfg.normalizeOrigin(origin);
  } catch {
    return false;
  }
}

/**
 * Introspect a DevAccel session token by calling the app's verify endpoint
 * (proxied to the backend). Returns true only on a 2xx response. Uses Node 18+
 * global fetch with a timeout.
 */
async function verifySession(verifyUrl, sessionToken) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(verifyUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function requireRoot(rootId, res) {
  const root = roots.get(rootId);
  if (!root) {
    send(res, 404, { error: "unknown_root", message: "rootId not registered — call /fs/open first." });
    return null;
  }
  return root;
}

/* ── Request router ──────────────────────────────────────────────────────── */
async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q = parsed.query;

  // CORS preflight
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.writeHead(204);
    return res.end();
  }

  applyCors(req, res);

  // Health/discovery — no auth, no origin gate (clients probe this first).
  // `platform` (node process.platform: win32|darwin|linux) tells the browser
  // which OS delegated commands (POST /exec) will run on — it forwards this
  // to the backend as client_os so the LLM composes cmd.exe vs POSIX-sh
  // commands for THIS machine, not for the server's OS.
  if (pathname === "/health" && req.method === "GET") {
    return send(res, 200, {
      ok: true,
      name: cfg.DAEMON_NAME,
      version: cfg.VERSION,
      platform: process.platform,
    });
  }

  // Everything else requires an allowlisted origin (or no origin = CLI).
  if (!originAllowed(req)) {
    return send(res, 403, { error: "forbidden_origin", message: "Origin not allowed." });
  }

  // Pairing — hand an allowlisted origin a token. When session auth is enabled,
  // the browser must present a DevAccel session token + a verify URL; the daemon
  // confirms the login by calling back to the app (introspection) before issuing
  // a token. This binds the daemon token to a real DevAccel session (Story 4).
  if (pathname === "/pair" && req.method === "POST") {
    const origin = req.headers.origin;
    // Browser callers must pass session auth; CLI/local callers (no Origin) are
    // trusted as local processes and skip introspection.
    if (cfg.requireAuth() && origin) {
      const body = await readBody(req).catch(() => ({}));
      const sessionToken = body.sessionToken;
      const verifyUrl = body.verifyUrl;
      if (!sessionToken || !verifyUrl) {
        return send(res, 400, { error: "auth_required", message: "sessionToken and verifyUrl are required to pair." });
      }
      // SSRF guard: the verify URL must live on the SAME (allowlisted) origin
      // that is pairing — the daemon must never be tricked into calling an
      // arbitrary host with the user's token.
      if (!verifyUrlMatchesOrigin(verifyUrl, origin)) {
        return send(res, 400, { error: "bad_verify_url", message: "verifyUrl must match the app origin." });
      }
      const ok = await verifySession(verifyUrl, sessionToken);
      if (!ok) {
        return send(res, 401, { error: "unauthorized", message: "DevAccel session verification failed." });
      }
    }
    const token = crypto.randomBytes(32).toString("hex");
    tokens.add(token);
    return send(res, 200, { token, name: cfg.DAEMON_NAME, version: cfg.VERSION });
  }

  // All /fs/* endpoints require a valid token.
  if (pathname.startsWith("/fs/")) {
    if (!requireToken(req, res)) return;

    try {
      if (pathname === "/fs/open" && req.method === "POST") {
        const body = await readBody(req);
        const rootPath = String(body.root || "").trim();
        if (!rootPath) return send(res, 400, { error: "bad_request", message: "root is required" });
        const abs = path.resolve(rootPath);
        // When the client is saving uploaded files it may target a folder that
        // doesn't exist yet — create it on request instead of failing.
        if (body.create === true) await fsp.mkdir(abs, { recursive: true });
        await fsx.assertDirectory(abs);
        const rootId = rootIdFor(abs);
        roots.set(rootId, abs);
        await persistRoots();
        return send(res, 200, { rootId, root: abs });
      }

      // Read-only batch existence probe — used by the Workspaces list to hide
      // workspaces whose folder lives on another machine. Unlike /fs/open this
      // NEVER registers a root (no roots.set / persistRoots): probing a list
      // must not widen the daemon's file-access sandbox.
      if (pathname === "/fs/exists" && req.method === "POST") {
        const body = await readBody(req);
        const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500) : [];
        const exists = {};
        for (const p of paths) {
          if (typeof p !== "string" || !p.trim()) continue;
          try {
            const st = await fsp.stat(path.resolve(p.trim()));
            exists[p] = st.isDirectory();
          } catch {
            exists[p] = false; // missing / unreadable → not on this machine
          }
        }
        return send(res, 200, { exists });
      }

      if (pathname === "/fs/scan" && req.method === "GET") {
        const root = requireRoot(q.rootId, res); if (!root) return;
        const nodes = await fsx.scan(root);
        return send(res, 200, { nodes });
      }

      if (pathname === "/fs/read" && req.method === "GET") {
        const root = requireRoot(q.rootId, res); if (!root) return;
        const content = await fsx.readFile(root, q.path);
        return send(res, 200, { content });
      }

      // Search executes HERE, beside the disk. The browser previously ran
      // grep by fetching every file over HTTP — thousands of round trips on
      // the legacy repos where search matters most, routinely blowing the
      // 120s client-tool timeout. One request, one finished result.
      if (pathname === "/fs/grep" && req.method === "POST") {
        const body = await readBody(req);
        const root = requireRoot(body.rootId, res); if (!root) return;
        const result = await searchx.grep(root, body);
        return send(res, 200, result);
      }

      if (pathname === "/fs/glob" && req.method === "GET") {
        const root = requireRoot(q.rootId, res); if (!root) return;
        // include_ignored arrives as a query string, so "false" is truthy —
        // compare explicitly or every glob would search node_modules.
        const result = await searchx.glob(
          root, q.pattern || "*", q.path || "", q.include_ignored === "true",
        );
        return send(res, 200, result);
      }

      // Raw bytes for a file the browser needs to PARSE rather than display
      // (.docx, .pdf, .xlsx, images). Base64 because this transport is JSON.
      // The cap is generous but present: without one, a read of a large
      // artefact would hold the file, its Buffer and its base64 string in the
      // daemon's heap at once — roughly 2.4x the file size.
      if (pathname === "/fs/read-bytes" && req.method === "GET") {
        const root = requireRoot(q.rootId, res); if (!root) return;
        // Same env var the server reads, so one deployment cannot end up with
        // a daemon refusing files the server would have accepted.
        const maxBytes =
          Number(q.maxBytes) ||
          Number(process.env.INGEST_MAX_FILE_BYTES) ||
          26214400; // 25 MB
        try {
          const out = await fsx.readFileBytes(root, q.path, maxBytes);
          return send(res, 200, out);
        } catch (e) {
          if (e && e.code === "EFBIG") return send(res, 413, { error: e.message });
          throw e;
        }
      }

      if (pathname === "/fs/write" && req.method === "PUT") {
        const body = await readBody(req);
        const root = requireRoot(body.rootId, res); if (!root) return;
        await fsx.writeFile(root, body.path, body.content);
        return send(res, 200, { ok: true });
      }

      // Raw bytes in (base64) — the browser saving an attachment into the
      // user's own workspace. /fs/write UTF-8-encodes its string and would
      // corrupt every non-text format on the way to disk.
      if (pathname === "/fs/write-bytes" && req.method === "PUT") {
        const body = await readBody(req);
        const root = requireRoot(body.rootId, res); if (!root) return;
        const out = await fsx.writeFileBytes(root, body.path, body.base64);
        return send(res, 200, { ok: true, ...out });
      }

      if (pathname === "/fs/create" && req.method === "POST") {
        const body = await readBody(req);
        const root = requireRoot(body.rootId, res); if (!root) return;
        await fsx.createEntry(root, body.path, body.type === "folder" ? "folder" : "file");
        return send(res, 200, { ok: true });
      }

      if (pathname === "/fs/entry" && req.method === "DELETE") {
        const body = await readBody(req);
        const root = requireRoot(body.rootId, res); if (!root) return;
        await fsx.removeEntry(root, body.path);
        return send(res, 200, { ok: true });
      }

      if (pathname === "/fs/rename" && req.method === "POST") {
        const body = await readBody(req);
        const root = requireRoot(body.rootId, res); if (!root) return;
        await fsx.rename(root, body.oldPath, body.newPath);
        return send(res, 200, { ok: true });
      }

      // Open the native OS folder dialog on the user's machine so the browser
      // client can obtain a full absolute path without the user typing it.
      if (pathname === "/fs/pick-folder" && req.method === "POST") {
        const result = await pick.pickFolder();
        return send(res, 200, result);
      }

      return send(res, 404, { error: "not_found" });
    } catch (e) {
      const code = e && e.code;
      if (code === "EPATH_ESCAPE") return send(res, 400, { error: "path_escape", message: e.message });
      if (code === "ENOENT") return send(res, 404, { error: "not_found", message: "No such file or directory" });
      if (code === "ENOTDIR") return send(res, 400, { error: "not_a_directory", message: e.message });
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }

  /* ── Command execution (token-gated, rootId-sandboxed cwd) ───────────────
     The agent's run_terminal/git delegated to this machine. The command runs
     with cwd = the registered workspace root; a missing language runtime
     comes back as a structured `runtime_missing` result so the agent can
     tell the user exactly what to install. */
  if (pathname === "/exec" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    try {
      const body = await readBody(req);
      const root = requireRoot(body.rootId, res); if (!root) return;

      // stream:true → NDJSON: one {type:"line"} per output line as it
      // happens, then a final {type:"done", result}. This is how the browser
      // renders live terminal output for client-executed commands.
      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
        });
        const writeLine = (obj) => {
          try { res.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ }
        };
        const result = await execx.execInRoot(root, body.command, body.timeoutSeconds,
          (stream, line) => writeLine({ type: "line", stream, line }));
        writeLine({ type: "done", result });
        return res.end();
      }

      const result = await execx.execInRoot(root, body.command, body.timeoutSeconds);
      return send(res, 200, result);
    } catch (e) {
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }

  /* ── Local MCP servers (token-gated, rootId-sandboxed cwd) ───────────────
     Runs stdio MCP servers on THIS machine so their tools execute where the
     user's files/secrets live (Pattern C) — the DevSphere backend can't reach
     127.0.0.1 here, so the browser proxies start/call/stop through these. Same
     trust model as /exec: the server commands come from the user's own
     .mcp.json. */
  if (pathname === "/mcp/start" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    try {
      const body = await readBody(req);
      const root = requireRoot(body.rootId, res); if (!root) return;
      const specs = Array.isArray(body.servers) ? body.servers : [];
      const results = await mcpx.startServers(root, specs);
      return send(res, 200, { results });
    } catch (e) {
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }
  if (pathname === "/mcp/call" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    try {
      const body = await readBody(req);
      const result = await mcpx.callTool(body.name, body.tool, body.arguments);
      return send(res, 200, { result });
    } catch (e) {
      // A tool/protocol failure is a normal result the agent should see, not a
      // transport error — return 200 with an error envelope.
      return send(res, 200, { error: String((e && e.message) || e) });
    }
  }
  if (pathname === "/mcp/stop" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    try {
      const body = await readBody(req).catch(() => ({}));
      if (body && body.name) mcpx.stopServer(body.name);
      else mcpx.stopAll();
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }

  /* ── Per-user agent state (~/.devaccel — Claude Code's ~/.claude) ────────
     Session transcripts + per-thread memory live CANONICALLY on this
     machine; the app server only caches. Jailed to DEVACCEL.md and
     projects/** by state.js. */
  if (pathname === "/state" && req.method === "GET") {
    if (!requireToken(req, res)) return;
    try {
      const content = await statex.readState(q.path);
      return send(res, 200, { content });
    } catch (e) {
      if (e.code === "ENOENT") return send(res, 404, { error: "not_found" });
      if (e.code === "EPATH_ESCAPE") return send(res, 400, { error: "path_escape", message: e.message });
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }
  if (pathname === "/state" && req.method === "PUT") {
    if (!requireToken(req, res)) return;
    try {
      const body = await readBody(req);
      await statex.writeState(body.path, body.content);
      return send(res, 200, { ok: true });
    } catch (e) {
      if (e.code === "EPATH_ESCAPE") return send(res, 400, { error: "path_escape", message: e.message });
      if (e.code === "E2BIG") return send(res, 413, { error: "too_large", message: e.message });
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }

  /* ── Runtime availability report (token-gated, machine-level) ────────────
     Which language runtimes exist on this machine, with versions — lets the
     browser tell the agent up front that e.g. Python is missing, before any
     command fails. */
  if (pathname === "/runtimes/check" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    try {
      const body = await readBody(req).catch(() => ({}));
      return send(res, 200, { runtimes: execx.checkRuntimes(body.binaries) });
    } catch (e) {
      return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
    }
  }

  /* ── Daemon lifecycle control (token-gated) ──────────────────────────────
     Let the web app Stop / Uninstall the daemon from the "Setup Daemon" tab.
     Install/Start can't be done from a browser (no process launch), but Stop
     and Uninstall are safe: the caller is an allowlisted origin holding a valid
     paired token. We respond FIRST, then exit, so the client sees success even
     though the connection then drops. */
  if (pathname === "/daemon/stop" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    send(res, 200, { ok: true, stopping: true });
    setTimeout(() => {
      // Kill any OTHER instance of the installed binary too: a stray second
      // daemon (double install, leftover auto-start entry) would be
      // rediscovered by the app seconds after we exit, making Stop a no-op.
      try {
        const install = require("./install");
        install.stopInstalledInstances(install.installPaths().target);
      } catch { /* best-effort */ }
      try { fs.unlinkSync(cfg.DAEMON_INFO_FILE); } catch { /* ignore */ }
      process.exit(0);
    }, 100).unref();
    return;
  }

  /* Self-update: download a new binary into the state dir under a SETUP name
     (never the live binary name — no lock contention), launch it with
     `install` (which stops this process, swaps the binary with EBUSY retry and
     restarts the daemon), then exit. SSRF guard: https-only + hostname suffix
     allowlist (config.updateHostSuffixes) — the daemon must never fetch an
     arbitrary URL on a client's say-so. */
  if (pathname === "/daemon/update" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    const body = await readBody(req).catch(() => ({}));
    let parsedUrl = null;
    try { parsedUrl = new URL(String(body.url || "")); } catch { /* rejected below */ }
    const hostOk = parsedUrl && parsedUrl.protocol === "https:" &&
      cfg.updateHostSuffixes().some((s) => parsedUrl.hostname.toLowerCase().endsWith(s));
    if (!hostOk) {
      return send(res, 400, { error: "bad_update_url", message: "Update URL must be https on an allowed host." });
    }
    const setupPath = path.join(cfg.STATE_DIR, require("./install").setupFileName());
    try {
      const dl = await fetch(parsedUrl.href);
      if (!dl.ok) return send(res, 502, { error: "download_failed", message: `Download failed (${dl.status}).` });
      const buf = Buffer.from(await dl.arrayBuffer());
      // The SEA binary is ~80 MB; anything tiny is an error page, not an update.
      if (buf.length < 10 * 1024 * 1024) {
        return send(res, 502, { error: "download_failed", message: "Downloaded file is too small to be the daemon binary." });
      }
      await fsp.mkdir(cfg.STATE_DIR, { recursive: true });
      await fsp.writeFile(setupPath, buf);
      if (process.platform !== "win32") await fsp.chmod(setupPath, 0o755);
    } catch (e) {
      return send(res, 502, { error: "download_failed", message: String((e && e.message) || e) });
    }
    send(res, 200, { ok: true, updating: true });
    setTimeout(() => {
      // Launch the setup binary (its install() stops us, swaps the exe and
      // restarts the daemon, then deletes the setup file), and exit so our
      // exe isn't locked during the swap.
      try {
        const { spawn } = require("child_process");
        const child = spawn(setupPath, ["install"], { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
      } catch { /* best-effort */ }
      try { fs.unlinkSync(cfg.DAEMON_INFO_FILE); } catch { /* ignore */ }
      process.exit(0);
    }, 100).unref();
    return;
  }

  if (pathname === "/daemon/uninstall" && req.method === "POST") {
    if (!requireToken(req, res)) return;
    // Respond FIRST: removing auto-start shells out to PowerShell, which can
    // take many seconds on managed/EDR machines — doing it before the response
    // made the client time out while the daemon still looked "connected".
    send(res, 200, { ok: true, uninstalling: true });
    setTimeout(() => {
      const install = require("./install");
      try { install.uninstall(); } catch { /* best-effort */ }
      // Kill stray instances of the installed binary: a second daemon would
      // keep serving after we exit AND hold the exe locked, so the scheduled
      // folder deletion below would silently fail.
      try { install.stopInstalledInstances(install.installPaths().target); } catch { /* best-effort */ }
      // Schedule binary + state deletion (detached helper) and exit so the
      // files aren't locked by this process.
      try { install.selfDelete(); } catch { /* ignore */ }
      try { fs.unlinkSync(cfg.DAEMON_INFO_FILE); } catch { /* ignore */ }
      process.exit(0);
    }, 100).unref();
    return;
  }

  return send(res, 404, { error: "not_found" });
}

/* ── Server factory (no lifecycle side effects — used by start() and tests) ── */
function buildServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { send(res, 500, { error: "internal", message: String((e && e.message) || e) }); } catch { /* ignore */ }
    });
  });
}

/**
 * Reset in-memory state (tokens + root registry). Test helper so each test
 * starts from a clean daemon without a process restart.
 */
function _resetState() {
  tokens.clear();
  roots.clear();
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */
async function start() {
  await loadRoots();
  const server = buildServer();

  // Bind the first free port in the canonical range (127.0.0.1 ONLY — never
  // 0.0.0.0). Browser clients probe this same range to discover the daemon.
  const ports = cfg.candidatePorts();
  let bound = false;
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener("error", onErr); reject(e); };
        server.once("error", onErr);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", onErr); resolve(); });
      });
      bound = true;
      break;
    } catch (e) {
      if (e && e.code === "EADDRINUSE") continue; // try next port
      throw e;
    }
  }
  if (!bound) {
    throw new Error(`No free port in range ${cfg.PORT_RANGE_START}-${cfg.PORT_RANGE_END}`);
  }

  const addr = server.address();
  const info = {
    name: cfg.DAEMON_NAME,
    version: cfg.VERSION,
    host: "127.0.0.1",
    port: addr.port,
    pid: process.pid,
    url: `http://127.0.0.1:${addr.port}`,
    startedAt: new Date().toISOString(),
  };
  await fsp.mkdir(cfg.STATE_DIR, { recursive: true });
  await fsp.writeFile(cfg.DAEMON_INFO_FILE, JSON.stringify(info, null, 2), "utf8");

  console.log(`[devaccel-daemon] listening on ${info.url} (pid ${info.pid})`);
  console.log(`[devaccel-daemon] info: ${cfg.DAEMON_INFO_FILE}`);

  const shutdown = () => {
    try { mcpx.stopAll(); } catch { /* kill child MCP servers — best-effort */ }
    try { fs.unlinkSync(cfg.DAEMON_INFO_FILE); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, info };
}

module.exports = { start, rootIdFor, buildServer, _resetState };
