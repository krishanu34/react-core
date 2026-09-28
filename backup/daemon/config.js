"use strict";

/**
 * config.js — daemon configuration & persistent state paths.
 *
 * The daemon stores its runtime info (port, pid) and the set of registered
 * workspace roots under a per-user directory so the browser/CLI can discover
 * it and so registered roots survive a restart. Nothing here ever leaves the
 * user's machine.
 */

const os = require("os");
const path = require("path");

/** Per-user state directory: ~/.devaccel */
const STATE_DIR = path.join(os.homedir(), ".devaccel");

/** Written on `serve` start; read by clients/CLI to discover the daemon. */
const DAEMON_INFO_FILE = path.join(STATE_DIR, "daemon.json");

/** Registered workspace roots (rootId -> absolute path), survives restarts. */
const ROOTS_FILE = path.join(STATE_DIR, "roots.json");

/**
 * Origins allowed to talk to the daemon (CORS + Origin allowlist).
 * Defaults cover local dev and the current HTTP deployment; override via
 * DEVACCEL_ALLOWED_ORIGINS (comma-separated) without a rebuild.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
  "http://172.191.70.202:3002",
  "http://20.241.202.9:3000",
];

/**
 * Canonical form of an origin for comparison. A browser's Origin header is
 * always `scheme://host[:port]` — lowercase, no path, NO trailing slash. An
 * allowlist entry copied from the address bar ("http://host:3000/") would
 * otherwise never match, silently breaking CORS and /pair for that deployment.
 */
function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function allowedOrigins() {
  const fromEnv = (process.env.DEVACCEL_ALLOWED_ORIGINS || "").split(",");
  return new Set(
    [...DEFAULT_ALLOWED_ORIGINS, ...fromEnv].map(normalizeOrigin).filter(Boolean),
  );
}

/** True if this request Origin is allowlisted (slash/case tolerant). */
function isOriginAllowed(origin) {
  return allowedOrigins().has(normalizeOrigin(origin));
}

/**
 * Canonical port range the daemon binds within and browser clients probe.
 * A fixed, known range is what lets a browser page (which cannot read
 * ~/.devaccel/daemon.json) discover the daemon. Keep in sync with the client's
 * AGENT_PORTS list in ui/src/lib/fileAccess/agentClient.ts.
 */
const PORT_RANGE_START = 17872;
const PORT_RANGE_END = 17879;

function candidatePorts() {
  // Explicit override wins; otherwise walk the canonical range.
  const override = parseInt(process.env.DEVACCEL_PORT || "", 10);
  if (Number.isFinite(override) && override > 0) return [override];
  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) ports.push(p);
  return ports;
}

/**
 * Session-bound auth (Story 4): when enabled, a browser must present a valid
 * DevAccel session token at /pair, which the daemon verifies by calling back
 * to the app (introspection). Default ON; disable for CLI-only/dev with
 * DEVACCEL_REQUIRE_AUTH=false.
 */
function requireAuth() {
  return (process.env.DEVACCEL_REQUIRE_AUTH || "true").toLowerCase() !== "false";
}

/** Timeout (ms) for the session-verify callback to the app. */
const VERIFY_TIMEOUT_MS = 5000;

/**
 * Hostname suffixes the daemon may download its own update binary from
 * (POST /daemon/update). Suffix match, https only — the daemon must never be
 * tricked into fetching an arbitrary URL. Extend via DEVACCEL_UPDATE_HOSTS
 * (comma-separated) without a rebuild.
 */
const DEFAULT_UPDATE_HOST_SUFFIXES = [".blob.core.windows.net"];

function updateHostSuffixes() {
  const fromEnv = (process.env.DEVACCEL_UPDATE_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_UPDATE_HOST_SUFFIXES, ...fromEnv];
}

module.exports = {
  STATE_DIR,
  DAEMON_INFO_FILE,
  ROOTS_FILE,
  DEFAULT_ALLOWED_ORIGINS,
  allowedOrigins,
  normalizeOrigin,
  isOriginAllowed,
  candidatePorts,
  PORT_RANGE_START,
  PORT_RANGE_END,
  requireAuth,
  VERIFY_TIMEOUT_MS,
  updateHostSuffixes,
  VERSION: require("./package.json").version,
  DAEMON_NAME: "devaccel-daemon",
};
