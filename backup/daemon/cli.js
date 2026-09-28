#!/usr/bin/env node
"use strict";

/**
 * cli.js — `devaccel` entry point. Same binary is the daemon AND a client.
 *
 *   devaccel install   Copy binary + register login auto-start + start it in the
 *                      background (detached, hidden). This is the DEFAULT with no
 *                      arguments, so double-clicking the download installs + runs
 *                      it in the background — no lingering console window.
 *   devaccel serve     Run the daemon in the FOREGROUND (127.0.0.1) — for dev/CLI.
 *   devaccel status    Print discovered daemon info (from ~/.devaccel/daemon.json).
 *   devaccel stop      Stop a running daemon (by pid in daemon.json).
 *   devaccel uninstall Remove the login auto-start.
 *   devaccel protocol <url>  OS-invoked handler for devaccel:// links (only
 *                      devaccel://start is honored — starts the installed daemon).
 *
 * Delivery: shipped as a single binary (Node SEA) — no Node install required.
 */

const fs = require("fs");
const cfg = require("./config");

function readInfo() {
  try {
    return JSON.parse(fs.readFileSync(cfg.DAEMON_INFO_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  // No args (e.g. double-click) → install: copy to a stable location, register
  // login auto-start, and start the daemon DETACHED + HIDDEN in the background
  // (so no console window lingers and closing terminals doesn't disconnect it).
  // `serve` remains available as an explicit foreground command for dev/CLI.
  const cmd = process.argv[2] || "install";

  switch (cmd) {
    case "install": {
      await require("./install").install();
      return;
    }
    case "uninstall": {
      require("./install").uninstall();
      return;
    }
    case "serve": {
      const { start } = require("./server");
      await start();
      // keep process alive
      return;
    }
    case "status": {
      const info = readInfo();
      if (!info) { console.log("devaccel daemon: not running (no daemon.json)"); process.exit(1); }
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    case "stop": {
      const info = readInfo();
      if (!info || !info.pid) { console.log("devaccel daemon: not running"); process.exit(0); }
      try {
        process.kill(info.pid, "SIGTERM");
        console.log(`devaccel daemon: sent SIGTERM to pid ${info.pid}`);
      } catch (e) {
        console.log(`devaccel daemon: could not stop pid ${info.pid} (${e.message})`);
      }
      return;
    }
    case "protocol": {
      // Invoked by the OS when the browser opens a devaccel:// link. ANY web
      // page can fire these URLs, so accept exactly devaccel://start and
      // ignore everything else — starting the daemon is the only permitted
      // effect (file access still requires origin allowlist + token pairing,
      // see server.js). Nothing from the URL is ever shell-interpolated.
      const raw = process.argv[3] || "";
      let action = null;
      try {
        const u = new URL(raw);
        if (u.protocol === "devaccel:") {
          action = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
        }
      } catch { /* malformed URL — ignored below */ }
      if (action !== "start") {
        console.log(`[devaccel] Ignoring unsupported protocol request: ${raw}`);
        return;
      }
      const { installPaths, startBackground } = require("./install");
      const { target } = installPaths();
      if (!fs.existsSync(target)) {
        console.log("[devaccel] Not installed — run the installer first.");
        return;
      }
      if (await startBackground(target)) console.log("[devaccel] Daemon started.");
      else console.log("[devaccel] Daemon already running.");
      return;
    }
    case "-h":
    case "--help":
    case "help": {
      console.log("Usage: devaccel <install|serve|status|stop|uninstall>");
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Usage: devaccel <install|serve|status|stop|uninstall>");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("[devaccel] fatal:", e && e.message ? e.message : e);
  process.exit(1);
});
