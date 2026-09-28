"use strict";

/**
 * install.js — self-install for the packaged daemon binary.
 *
 * Lets a user just download the binary and double-click it: on first run it
 * copies itself into ~/.devaccel (the daemon's state dir — binary + daemon.json
 * + roots.json live in ONE folder), registers OS auto-start at login, registers
 * the devaccel:// URL protocol (one-click Start from the web app), and starts
 * serving in the background — no separate install script needed. Pre-0.3.0
 * installs (%LOCALAPPDATA%\DevAccel / ~/.local/bin) are migrated automatically.
 *
 * Auto-start mechanisms (all user-scope, no admin/sudo):
 *   • Windows — logon Scheduled Task running "<installed> serve" (fires within
 *               seconds of sign-in; the binary is a GUI-subsystem exe, so no
 *               console window). Fallbacks: HKCU Run key, then a hidden
 *               Startup-folder VBS launcher.
 *   • Linux   — systemd --user service
 *   • macOS   — launchd LaunchAgent (RunAtLoad + KeepAlive)
 *
 * In dev (running via `node cli.js`), self-install is skipped — it only makes
 * sense for the packaged single-file binary.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFileSync, spawn } = require("child_process");

const cfg = require("./config");

const SERVICE_NAME = "devaccel-daemon";
const LAUNCH_LABEL = "com.devaccel.daemon";

/** Windows login auto-start: HKCU Run key (PowerShell registry-provider path). */
const WIN_RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WIN_RUN_VALUE = "DevAccelDaemon";
/** Windows login auto-start: logon Scheduled Task (preferred — starts in seconds). */
const WIN_TASK_NAME = "DevAccelDaemon";

/** Run a short PowerShell command (used where reg.exe/schtasks are policy-blocked). */
function runPowershell(command) {
  execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
  ], { stdio: "ignore", windowsHide: true });
}

/** Escape a value for a single-quoted PowerShell string ('' = literal '). */
function psQuote(s) {
  return s.replace(/'/g, "''");
}

/** Windows Startup-folder launcher (runs the daemon hidden at login). */
function winStartupVbsPath() {
  const startup = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  );
  return path.join(startup, "DevAccelDaemon.vbs");
}

/** True when running as a packaged SEA/pkg binary (not `node cli.js`). */
function isPackaged() {
  const exe = path.basename(process.execPath).toLowerCase();
  return exe !== "node" && exe !== "node.exe";
}

/**
 * Where the installed binary lives: inside the ~/.devaccel state dir, so the
 * binary and its state share one folder and uninstall removes a single dir.
 */
function installPaths() {
  const exe = process.platform === "win32" ? "devaccel.exe" : "devaccel";
  return { dir: cfg.STATE_DIR, target: path.join(cfg.STATE_DIR, exe) };
}

/** Pre-0.3.0 install location — cleaned up during install / self-delete. */
function legacyInstallPaths() {
  if (process.platform === "win32") {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DevAccel");
    return { dir, target: path.join(dir, "devaccel.exe"), removeDir: true };
  }
  // ~/.local/bin is shared with other tools — remove only our file, never the dir.
  const dir = path.join(os.homedir(), ".local", "bin");
  return { dir, target: path.join(dir, "devaccel"), removeDir: false };
}

/** Transient installer name used by the web one-liner and /daemon/update. */
function setupFileName() {
  return process.platform === "win32" ? "devaccel-setup.exe" : "devaccel-setup";
}

/**
 * Is a daemon already listening? Verified with an HTTP /health probe, NOT a pid
 * liveness check: after a reboot the info file is stale (never unlinked on a
 * hard shutdown) and its recorded pid can be recycled by an unrelated process,
 * which made `process.kill(pid, 0)` report "running" and install silently skip
 * starting the daemon.
 */
async function isDaemonRunning() {
  try {
    const info = JSON.parse(fs.readFileSync(cfg.DAEMON_INFO_FILE, "utf8"));
    if (!info || !info.port) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: ctrl.signal });
      if (!res.ok) return false;
      const body = await res.json();
      return !!body && body.name === cfg.DAEMON_NAME;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stop EVERY process running the installed binary — not just the one recorded
 * in daemon.json. A stale info file (or a second instance bound to another
 * port) otherwise keeps the exe locked on Windows and the update copy fails
 * with EBUSY, silently leaving the OLD binary installed.
 */
function stopInstalledInstances(target) {
  try {
    if (process.platform === "win32") {
      runPowershell(
        `Get-Process | Where-Object { $_.Path -eq '${psQuote(target)}' -and $_.Id -ne ${process.pid} } | ` +
        `Stop-Process -Force -ErrorAction SilentlyContinue`,
      );
    } else {
      execFileSync("pkill", ["-f", `${target} serve`], { stdio: "ignore" });
    }
  } catch { /* nothing running / tool unavailable — best-effort */ }
}

/** Register OS auto-start pointing at the installed binary. */
function registerAutoStart(target) {
  if (process.platform === "win32") {
    // Preferred: a logon Scheduled Task — fired by the Task Scheduler service
    // within seconds of sign-in, unlike Run-key/Startup items which Explorer
    // staggers by minutes on managed machines ("daemon not connected right
    // after reboot"). Registered via the PowerShell cmdlets (Task Scheduler
    // API): on managed machines schtasks.exe is commonly denied by policy
    // while the API path is allowed. ExecutionTimeLimit zero is essential —
    // the default 72h limit would kill the daemon mid-session.
    try {
      runPowershell(
        `$a = New-ScheduledTaskAction -Execute '${psQuote(target)}' -Argument 'serve'; ` +
        `$t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"; ` +
        `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ` +
        `-ExecutionTimeLimit ([TimeSpan]::Zero); ` +
        `Register-ScheduledTask -TaskName '${WIN_TASK_NAME}' -Action $a -Trigger $t -Settings $s ` +
        `-RunLevel Limited -Force -ErrorAction Stop | Out-Null`,
      );
      // The task supersedes the older Run-key / Startup-folder mechanisms —
      // remove them so the daemon isn't started twice at logon.
      try {
        runPowershell(
          `Remove-ItemProperty -Path '${WIN_RUN_KEY}' -Name '${WIN_RUN_VALUE}' -ErrorAction SilentlyContinue`,
        );
      } catch { /* best-effort */ }
      try { fs.rmSync(winStartupVbsPath(), { force: true }); } catch { /* best-effort */ }
      return "logon Scheduled Task";
    } catch { /* task registration blocked — fall through to the Run key */ }

    // Fallback 1: HKCU Run key launching the binary directly — the packaged exe
    // is patched to the GUI subsystem (see build-sea.mjs), so no console window.
    try {
      runPowershell(
        `Set-ItemProperty -Path '${WIN_RUN_KEY}' -Name '${WIN_RUN_VALUE}' ` +
        `-Value '"${psQuote(target)}" serve' -ErrorAction Stop`,
      );
      // The Run key supersedes the legacy Startup-folder VBS launcher.
      try { fs.rmSync(winStartupVbsPath(), { force: true }); } catch { /* best-effort */ }
      return "registry Run key (login)";
    } catch {
      // Fallback 2: PowerShell unavailable/blocked — hidden VBS launcher.
      // (EDR may delay wscript+VBS at logon by minutes; last resort only.)
      const vbs = winStartupVbsPath();
      fs.mkdirSync(path.dirname(vbs), { recursive: true });
      // In VBS, a literal double-quote is written as "". WScript.Shell.Run with
      // window-style 0 launches hidden.
      fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${target}"" serve", 0, False\r\n`);
      return "Startup folder launcher (hidden)";
    }
  }

  if (process.platform === "linux") {
    const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, `${SERVICE_NAME}.service`),
      `[Unit]\nDescription=DevAccel Local Daemon\nAfter=network.target\n\n` +
      `[Service]\nExecStart=${target} serve\nRestart=on-failure\n\n` +
      `[Install]\nWantedBy=default.target\n`,
    );
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", `${SERVICE_NAME}.service`], { stdio: "ignore" });
    } catch { /* systemd --user may be unavailable in some environments */ }
    return "systemd --user service";
  }

  // macOS
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plist = path.join(agentsDir, `${LAUNCH_LABEL}.plist`);
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `  <key>Label</key><string>${LAUNCH_LABEL}</string>\n` +
    `  <key>ProgramArguments</key><array><string>${target}</string><string>serve</string></array>\n` +
    `  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n` +
    `</dict></plist>\n`,
  );
  try {
    execFileSync("launchctl", ["unload", plist], { stdio: "ignore" });
  } catch { /* not loaded yet */ }
  execFileSync("launchctl", ["load", "-w", plist], { stdio: "ignore" }); // RunAtLoad starts it now
  return "launchd LaunchAgent";
}

/**
 * Register the devaccel:// URL protocol so the web app's "Start daemon" button
 * can launch the installed binary via the browser's native "Open DevAccel?"
 * prompt — one click, no terminal. User-scope only, no admin. The handler runs
 * `<target> protocol "%1"`, and cli.js accepts ONLY devaccel://start: any web
 * page can fire these URLs, so starting the daemon must be the sole possible
 * effect (file access still requires origin allowlist + token pairing).
 *
 * macOS is skipped: URL schemes there require an app bundle Info.plist, which
 * a bare SEA binary doesn't have — the Setup page shows the copy-paste start
 * command instead.
 */
function registerProtocolHandler(target) {
  if (process.platform === "win32") {
    const key = "HKCU:\\Software\\Classes\\devaccel";
    runPowershell(
      `New-Item -Path '${key}\\shell\\open\\command' -Force | Out-Null; ` +
      `Set-ItemProperty -Path '${key}' -Name '(Default)' -Value 'URL:DevAccel Protocol'; ` +
      `Set-ItemProperty -Path '${key}' -Name 'URL Protocol' -Value ''; ` +
      `Set-ItemProperty -Path '${key}\\shell\\open\\command' -Name '(Default)' ` +
      `-Value '"${psQuote(target)}" protocol "%1"'`,
    );
    return true;
  }
  if (process.platform === "linux") {
    const appsDir = path.join(os.homedir(), ".local", "share", "applications");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(
      path.join(appsDir, "devaccel-daemon.desktop"),
      `[Desktop Entry]\nType=Application\nName=DevAccel Daemon\nNoDisplay=true\n` +
      `Exec=${target} protocol %u\nMimeType=x-scheme-handler/devaccel;\n`,
    );
    try {
      execFileSync("xdg-mime", ["default", "devaccel-daemon.desktop", "x-scheme-handler/devaccel"], { stdio: "ignore" });
    } catch { /* xdg-utils missing — the desktop entry alone often suffices */ }
    return true;
  }
  return false; // macOS
}

/** Remove the devaccel:// protocol registration (mirror of register). */
function unregisterProtocolHandler() {
  try {
    if (process.platform === "win32") {
      runPowershell("Remove-Item -Path 'HKCU:\\Software\\Classes\\devaccel' -Recurse -Force -ErrorAction SilentlyContinue");
    } else if (process.platform === "linux") {
      fs.rmSync(path.join(os.homedir(), ".local", "share", "applications", "devaccel-daemon.desktop"), { force: true });
    }
  } catch { /* best-effort */ }
}

/**
 * Start the installed daemon now, detached + hidden (skips if already running).
 * Robust: any spawn failure is swallowed (never crashes install).
 */
async function startBackground(target) {
  if (await isDaemonRunning()) return false;
  try {
    const child = spawn(target, ["serve"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    // Without this handler an async spawn error (e.g. transient file lock)
    // becomes an unhandled 'error' event and crashes the process.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Install: copy self → install dir, register auto-start, start in background.
 * Idempotent — safe to run repeatedly.
 */
async function install() {
  if (!isPackaged()) {
    console.log("[devaccel] Dev mode (node) — self-install applies only to the packaged binary.");
    console.log("[devaccel] Starting the daemon in the foreground instead. Use `serve` explicitly in dev.");
    require("./server").start();
    return;
  }

  const { dir, target } = installPaths();
  fs.mkdirSync(dir, { recursive: true });

  const current = path.resolve(process.execPath);

  // Migrate a pre-0.3.0 install: stop anything running from the old path and
  // remove the old binary so two copies never fight over the port range. Runs
  // even when the current exe IS the new installed copy (re-run/upgrade).
  const legacy = legacyInstallPaths();
  if (path.resolve(legacy.target) !== current && fs.existsSync(legacy.target)) {
    stopInstalledInstances(legacy.target);
    for (let i = 0; i < 25 && (await isDaemonRunning()); i++) await sleep(200);
    try {
      if (legacy.removeDir) fs.rmSync(legacy.dir, { recursive: true, force: true });
      else fs.rmSync(legacy.target, { force: true });
      console.log(`[devaccel] Removed old install at ${legacy.target}`);
    } catch { /* still locked — auto-start below re-points to the new path anyway */ }
  }

  if (current !== path.resolve(target)) {
    // Stop previously-installed instances so the target file isn't locked,
    // then WAIT for them to actually exit — on Windows the exe stays locked
    // until the process is gone, and copying immediately after kill fails
    // with EBUSY (leaving the OLD binary installed on update).
    if (await isDaemonRunning()) {
      try {
        const info = JSON.parse(fs.readFileSync(cfg.DAEMON_INFO_FILE, "utf8"));
        if (info && info.pid) process.kill(info.pid);
      } catch { /* best-effort */ }
    }
    stopInstalledInstances(target);
    for (let i = 0; i < 25 && (await isDaemonRunning()); i++) await sleep(200);
    let copyErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        fs.copyFileSync(current, target);
        copyErr = null;
        break;
      } catch (e) {
        copyErr = e; // exe lock can linger briefly after the process exits
        await sleep(300);
      }
    }
    if (copyErr) {
      console.log(`[devaccel] Warning: could not copy binary (${copyErr.message}). Using existing copy if present.`);
    } else {
      if (process.platform !== "win32") fs.chmodSync(target, 0o755);
      console.log(`[devaccel] Installed to ${target}`);
    }
  }

  // 1) Start the daemon NOW — before writing any login-persistence entry.
  //    On locked-down/corporate machines a security agent may terminate an
  //    unsigned process the moment it creates a Startup/auto-run entry; starting
  //    first means the daemon is already running (detached) even if that happens.
  //    (macOS starts via launchd RunAtLoad in step 2 instead.)
  if (process.platform !== "darwin") {
    if (await startBackground(target)) console.log("[devaccel] Daemon started in the background.");
    else console.log("[devaccel] Daemon already running.");
  }

  // 2) Register login auto-start (best-effort; may be blocked by policy).
  try {
    const mechanism = registerAutoStart(target);
    console.log(`[devaccel] Auto-start registered (${mechanism}).`);
  } catch (e) {
    console.log(`[devaccel] Note: could not register login auto-start (${e.message}). ` +
                "The daemon is running now; re-run it after a reboot if it doesn't come back.");
  }

  // 3) Register the devaccel:// protocol handler (best-effort) so the web app
  //    can offer one-click Start; the copy-paste command remains the fallback.
  try {
    if (registerProtocolHandler(target)) console.log("[devaccel] devaccel:// protocol handler registered.");
  } catch { /* policy-blocked — copy-paste start still works */ }

  console.log("[devaccel] Done — DevAccel daemon is running.");
  console.log(`[devaccel] Verify: open http://127.0.0.1:${cfg.PORT_RANGE_START}/health`);
  // If we were launched from the transient setup binary (one-liner install or
  // /daemon/update download), schedule its deletion — nothing lingers.
  cleanupSetupFile();
  // The daemon runs as a detached, unref'd child; exit the installer cleanly so
  // any caller sees success (avoids a spurious non-zero teardown exit code).
  process.exit(0);
}

/**
 * When install() was launched FROM ~/.devaccel/devaccel-setup(.exe), schedule
 * that file's deletion: a Windows process can't delete its own running exe, so
 * a detached helper (windowless wscript VBS / sh) waits for us to exit first.
 */
function cleanupSetupFile() {
  const current = path.resolve(process.execPath);
  if (path.basename(current).toLowerCase() !== setupFileName()) return;
  try {
    if (process.platform === "win32") {
      const esc = (p) => p.replace(/"/g, '""'); // VBS escapes " as ""
      const vbs = [
        "On Error Resume Next",
        "WScript.Sleep 2000", // let the setup process exit + release its .exe
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        `If fso.FileExists("${esc(current)}") Then fso.DeleteFile "${esc(current)}", True`,
        "fso.DeleteFile WScript.ScriptFullName, True",
        "",
      ].join("\r\n");
      const vbsPath = path.join(os.tmpdir(), `devaccel-setup-cleanup-${Date.now()}.vbs`);
      fs.writeFileSync(vbsPath, vbs);
      const child = spawn("wscript.exe", ["//B", "//Nologo", vbsPath], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
    } else {
      const child = spawn("sh", ["-c", `sleep 1; rm -f "${current}"`], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    }
  } catch { /* best-effort */ }
}

/**
 * Best-effort self-deletion of the installed binary + per-user state, used by
 * the HTTP /daemon/uninstall endpoint so the user can fully remove the daemon
 * from the app. A running process can't delete its own on-disk binary on
 * Windows, so we spawn a DETACHED helper that waits for us to exit, then removes
 * the install dir and the ~/.devaccel state dir. No-op in dev (node cli.js).
 */
function selfDelete() {
  if (!isPackaged()) return; // dev copy — never touch the repo
  // Install dir and state dir are the same (~/.devaccel) since 0.3.0 — dedupe,
  // and sweep any pre-0.3.0 leftovers while we're at it.
  const legacy = legacyInstallPaths();
  const folders = [...new Set([installPaths().dir, cfg.STATE_DIR, ...(legacy.removeDir ? [legacy.dir] : [])]
    .map((p) => path.resolve(p)))];
  const legacyFile = legacy.removeDir ? null : legacy.target;
  try {
    if (process.platform === "win32") {
      // A detached `cmd.exe` (a CONSOLE program) pops a console window even with
      // windowsHide. Use `wscript.exe` instead — a GUI-subsystem host that NEVER
      // shows a window — to run a tiny VBS that waits for us to exit, deletes the
      // install/state dirs, then deletes itself. Fully silent.
      const esc = (p) => p.replace(/"/g, '""'); // VBS escapes " as ""
      const vbs = [
        "On Error Resume Next",
        "WScript.Sleep 2000", // let this daemon process exit + release its .exe
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        ...folders.map((f) => `If fso.FolderExists("${esc(f)}") Then fso.DeleteFolder "${esc(f)}", True`),
        "fso.DeleteFile WScript.ScriptFullName, True", // remove this cleanup script
        "",
      ].join("\r\n");
      const vbsPath = path.join(os.tmpdir(), `devaccel-cleanup-${Date.now()}.vbs`);
      fs.writeFileSync(vbsPath, vbs);
      // //B = batch mode (no error dialogs); wscript is windowless by nature.
      const child = spawn("wscript.exe", ["//B", "//Nologo", vbsPath], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
    } else {
      const rmDirs = folders.map((f) => `"${f}"`).join(" ");
      const rmFile = legacyFile ? `; rm -f "${legacyFile}"` : "";
      const child = spawn("sh", ["-c", `sleep 1; rm -rf ${rmDirs}${rmFile}`], {
        detached: true, stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
    }
  } catch { /* best-effort */ }
}

/** Remove auto-start registration (leaves the binary in place). */
function uninstall() {
  try {
    if (process.platform === "win32") {
      try {
        runPowershell(
          `Unregister-ScheduledTask -TaskName '${WIN_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue; ` +
          `Remove-ItemProperty -Path '${WIN_RUN_KEY}' -Name '${WIN_RUN_VALUE}' -ErrorAction SilentlyContinue`,
        );
      } catch { /* PowerShell blocked — entries may not exist anyway */ }
      fs.rmSync(winStartupVbsPath(), { force: true });
    } else if (process.platform === "linux") {
      execFileSync("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`], { stdio: "ignore" });
      fs.rmSync(path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`), { force: true });
    } else {
      const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
      execFileSync("launchctl", ["unload", plist], { stdio: "ignore" });
      fs.rmSync(plist, { force: true });
    }
    unregisterProtocolHandler();
    console.log("[devaccel] Auto-start removed.");
  } catch (e) {
    console.log(`[devaccel] Uninstall note: ${e.message}`);
  }
}

module.exports = {
  install, uninstall, selfDelete, isPackaged, isDaemonRunning,
  installPaths, legacyInstallPaths, setupFileName, startBackground,
  stopInstalledInstances,
};
