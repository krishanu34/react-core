"use strict";

/**
 * stdio-host.js — run LOCAL MCP servers on the user's machine (Pattern C).
 *
 * A stdio MCP server (e.g. `npx @modelcontextprotocol/server-filesystem .`) is a
 * child process that speaks JSON-RPC 2.0 over stdin/stdout, newline-delimited.
 * The DevSphere BACKEND can't reach it — the daemon is 127.0.0.1 on the user's
 * machine — so the daemon hosts it and the browser proxies calls here (server.js
 * /mcp/* endpoints), exactly how run_terminal/git run via /exec. Files and
 * secrets stay on the user's machine.
 *
 * Hand-rolled (no @modelcontextprotocol/sdk) so the SEA binary stays
 * self-contained. We only need three methods: initialize, tools/list, tools/call.
 */

const { spawn } = require("child_process");

const IS_WIN = process.platform === "win32";
const PROTOCOL_VERSION = "2025-06-18";
const INIT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 120000;

class McpStdioServer {
  constructor(name, { command, args = [], env = {}, cwd }) {
    this.name = name;
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.env = env || {};
    this.cwd = cwd;
    this.proc = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.tools = [];
    this.started = false;
  }

  async start() {
    const env = { ...process.env, ...this.env };
    // npx/npm are .cmd shims on Windows — need a shell to resolve via PATHEXT.
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: IS_WIN,
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => {
      // MCP servers log to stderr — surface briefly, never to the model.
      const s = d.toString("utf8").trim();
      if (s) console.error(`[mcp:${this.name}] ${s.slice(0, 500)}`);
    });
    this.proc.on("exit", (code) =>
      this._failAll(new Error(`MCP '${this.name}' exited (code ${code})`)));
    this.proc.on("error", (e) => this._failAll(e));

    await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "devaccel-daemon", version: "mcp" },
    }, INIT_TIMEOUT_MS);
    this._notify("notifications/initialized", {});

    const listed = await this._request("tools/list", {}, INIT_TIMEOUT_MS);
    this.tools = (listed && listed.tools) || [];
    this.started = true;
    return this.tools;
  }

  async callTool(toolName, args) {
    if (!this.started) throw new Error(`MCP server '${this.name}' is not running`);
    return this._request("tools/call", {
      name: toolName,
      arguments: args || {},
    }, CALL_TIMEOUT_MS);
  }

  _request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.name}' ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  _write(obj) {
    if (!this.proc || this.proc.killed) throw new Error(`MCP '${this.name}' not running`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  _onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // partial/garbled — skip
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Only responses (carry an id we sent) are handled; server-initiated
    // requests/notifications (logging, sampling) are ignored for now.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "MCP error"));
      else resolve(msg.result);
    }
  }

  _failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.started = false;
  }

  stop() {
    try {
      if (this.proc && !this.proc.killed) this.proc.kill();
    } catch { /* already gone */ }
    this._failAll(new Error("stopped"));
  }
}

/* ── Registry of running local servers (per daemon process) ──────────────── */
const servers = new Map(); // name -> McpStdioServer

/**
 * Start (or restart) each server spec and return its tool list or an error.
 * `specs`: [{ name, command, args, env }]. One bad server never fails the batch.
 */
async function startServers(cwd, specs) {
  const out = {};
  for (const spec of specs || []) {
    const name = spec && spec.name;
    if (!name) continue;
    if (servers.has(name)) { servers.get(name).stop(); servers.delete(name); }
    const srv = new McpStdioServer(name, {
      command: spec.command, args: spec.args, env: spec.env, cwd,
    });
    try {
      const tools = await srv.start();
      servers.set(name, srv);
      out[name] = { tools };
    } catch (e) {
      try { srv.stop(); } catch { /* ignore */ }
      out[name] = { error: String((e && e.message) || e) };
    }
  }
  return out;
}

async function callTool(name, tool, args) {
  const srv = servers.get(name);
  if (!srv || !srv.started) throw new Error(`MCP server '${name}' is not running`);
  return srv.callTool(tool, args);
}

function stopServer(name) {
  const srv = servers.get(name);
  if (srv) { srv.stop(); servers.delete(name); }
}

function stopAll() {
  for (const srv of servers.values()) srv.stop();
  servers.clear();
}

function listServers() {
  return Array.from(servers.entries()).map(([name, s]) => ({
    name, started: s.started, toolCount: s.tools.length,
  }));
}

module.exports = { startServers, callTool, stopServer, stopAll, listServers, McpStdioServer };
