"use strict";

/**
 * state.js — per-user agent state under ~/.devaccel (the Claude Code
 * ~/.claude equivalent).
 *
 * Layout (mirrors how Claude Code keys ~/.claude/projects by project path):
 *   ~/.devaccel/DEVACCEL.md                          user-level memory
 *   ~/.devaccel/projects/<rootId>/sessions/…         chat transcripts
 *   ~/.devaccel/projects/<rootId>/memory/…           per-thread long-term memory
 *
 * The user's machine holds the CANONICAL copy; the app server only caches.
 * That's what makes history survive a server DB wipe and keeps user data
 * user-owned.
 *
 * JAIL: only DEVACCEL.md and projects/** are reachable — a valid token never
 * grants arbitrary home-directory access (same posture as fs.js roots).
 */

const path = require("path");
const fsp = require("fs/promises");

const cfg = require("./config");

// One transcript/memory file cap — state is summaries and message text,
// never build artifacts; anything bigger indicates a bug on the caller side.
const MAX_STATE_BYTES = 5 * 1024 * 1024;

/** Resolve a state-relative path, enforcing the allowlist + traversal guard. */
function resolveStatePath(rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean !== "DEVACCEL.md" && !clean.startsWith("projects/")) {
    throw Object.assign(
      new Error("State path must be DEVACCEL.md or under projects/"),
      { code: "EPATH_ESCAPE" },
    );
  }
  const rootAbs = path.resolve(cfg.STATE_DIR);
  const abs = path.resolve(rootAbs, clean);
  const relCheck = path.relative(rootAbs, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw Object.assign(new Error("Path escapes the state directory"), { code: "EPATH_ESCAPE" });
  }
  return abs;
}

async function readState(rel) {
  return fsp.readFile(resolveStatePath(rel), "utf8");
}

async function writeState(rel, content) {
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    throw Object.assign(new Error("State file too large"), { code: "E2BIG" });
  }
  const abs = resolveStatePath(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, "utf8");
}

module.exports = { readState, writeState, resolveStatePath, MAX_STATE_BYTES };
