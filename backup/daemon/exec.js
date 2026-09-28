"use strict";

/**
 * exec.js — command execution for the DevAccel daemon (POST /exec).
 *
 * This is what makes run_terminal/git CLIENT tools (the Claude Code /
 * Copilot / Kiro model): commands run on the user's machine, in the
 * registered workspace root, never on the DevSphere server.
 *
 * RUNTIME DETECTION
 *   Before spawning, every command segment's leading binary is checked
 *   against the machine's PATH. If a KNOWN language runtime (node, python,
 *   java, go, …) is missing, the daemon returns a structured
 *   `runtime_missing` result instead of a cryptic "not recognized" stderr —
 *   the agent turns that into setup guidance for the user. Unknown binaries
 *   and shell builtins are not checked; the shell reports those naturally.
 *
 * FRESH PATH (all OSes, no daemon restart needed)
 *   A running process keeps the PATH it started with, so a runtime installed
 *   mid-session is invisible to naive probes:
 *     • Windows — installers write PATH to the REGISTRY; we re-read and merge
 *       HKCU + system PATH (with %VAR% expansion).
 *     • macOS/Linux — a launchd/systemd-started daemon gets a minimal PATH;
 *       we capture the user's LOGIN-SHELL PATH ($SHELL -lc), the same
 *       technique VS Code uses (resolveShellEnv). This also picks up version
 *       managers (nvm, pyenv, asdf) whose paths live in shell profiles.
 *   The merged PATH is cached briefly and used for both probes and spawns,
 *   so "install → retry" just works.
 *
 * SAFETY
 *   • Token-gated + rootId sandbox, same as /fs/* (enforced in server.js).
 *   • cwd is always the registered workspace root.
 *   • Output capped per stream; timeout kills the whole process tree.
 *   • Env passed through with non-interactive flags set so prompts fail
 *     fast instead of hanging (no keyboard here).
 */

const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
const MAX_OUTPUT_CHARS = 10000; // per stream — mirrors the server tool's cap

/** Known language/toolchain binaries → what to tell the user to install.
 *  Anything not listed is left to the shell to resolve (could be a builtin,
 *  a project script, or an uncommon tool). */
const KNOWN_RUNTIMES = {
  node:    { runtime: "Node.js",  install: "https://nodejs.org (LTS) — or `winget install OpenJS.NodeJS.LTS` / `brew install node`" },
  npm:     { runtime: "Node.js",  install: "https://nodejs.org (npm ships with Node.js)" },
  npx:     { runtime: "Node.js",  install: "https://nodejs.org (npx ships with Node.js)" },
  yarn:    { runtime: "Yarn",     install: "`npm install -g yarn` (needs Node.js first)" },
  pnpm:    { runtime: "pnpm",     install: "`npm install -g pnpm` (needs Node.js first)" },
  python:  { runtime: "Python",   install: "https://python.org/downloads — or `winget install Python.Python.3.12` / `brew install python`" },
  python3: { runtime: "Python",   install: "https://python.org/downloads" },
  pip:     { runtime: "Python",   install: "https://python.org/downloads (pip ships with Python)" },
  pip3:    { runtime: "Python",   install: "https://python.org/downloads (pip ships with Python)" },
  java:    { runtime: "Java JDK", install: "https://adoptium.net — or `winget install EclipseAdoptium.Temurin.21.JDK`" },
  javac:   { runtime: "Java JDK", install: "https://adoptium.net" },
  mvn:     { runtime: "Maven",    install: "https://maven.apache.org/install.html (needs a JDK first)" },
  gradle:  { runtime: "Gradle",   install: "https://gradle.org/install (needs a JDK first)" },
  go:      { runtime: "Go",       install: "https://go.dev/dl" },
  cargo:   { runtime: "Rust",     install: "https://rustup.rs" },
  rustc:   { runtime: "Rust",     install: "https://rustup.rs" },
  dotnet:  { runtime: ".NET SDK", install: "https://dotnet.microsoft.com/download" },
  php:     { runtime: "PHP",      install: "https://www.php.net/downloads" },
  composer:{ runtime: "Composer", install: "https://getcomposer.org/download (needs PHP first)" },
  ruby:    { runtime: "Ruby",     install: "https://www.ruby-lang.org/en/downloads" },
  gem:     { runtime: "Ruby",     install: "https://www.ruby-lang.org/en/downloads (gem ships with Ruby)" },
  bundle:  { runtime: "Bundler",  install: "`gem install bundler` (needs Ruby first)" },
  git:     { runtime: "Git",      install: "https://git-scm.com/downloads — or `winget install Git.Git`" },
  docker:  { runtime: "Docker",   install: "https://docs.docker.com/get-docker" },
  kubectl: { runtime: "kubectl",  install: "https://kubernetes.io/docs/tasks/tools" },
  terraform:{ runtime: "Terraform", install: "https://developer.hashicorp.com/terraform/install" },
};

/* ── Fresh PATH resolution ─────────────────────────────────────────────── */

const PATH_REFRESH_TTL_MS = 60000;
let cachedPathValue = null;
let cachedPathAt = 0;

function windowsRegistryPath() {
  const read = (key) => {
    try {
      const r = spawnSync("reg", ["query", key, "/v", "Path"],
        { timeout: 3000, windowsHide: true, encoding: "utf8" });
      if (r.status !== 0) return "";
      const m = /\bPath\s+REG(?:_EXPAND)?_SZ\s+(.+)/i.exec(r.stdout || "");
      return m ? m[1].trim() : "";
    } catch { return ""; }
  };
  const system = read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
  const user = read("HKCU\\Environment");
  const raw = [system, user].filter(Boolean).join(";");
  // Expand %SystemRoot%-style refs best-effort from the process env.
  return raw.replace(/%([^%;]+)%/g, (whole, name) => process.env[name] ?? whole);
}

function posixLoginShellPath() {
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const r = spawnSync(shell, ["-lc", 'printf %s "$PATH"'], { timeout: 5000, encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : "";
  } catch { return ""; }
}

function freshPath() {
  const now = Date.now();
  if (cachedPathValue && now - cachedPathAt < PATH_REFRESH_TTL_MS) return cachedPathValue;
  const sep = IS_WIN ? ";" : ":";
  const current = process.env.PATH || process.env.Path || "";
  const extra = IS_WIN ? windowsRegistryPath() : posixLoginShellPath();
  const seen = new Set();
  const merged = [...current.split(sep), ...extra.split(sep)]
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const key = IS_WIN ? p.toLowerCase() : p;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(sep);
  cachedPathValue = merged || current;
  cachedPathAt = now;
  return cachedPathValue;
}

/** Probe cache: FOUND is cached for the daemon lifetime; NOT-FOUND expires
 *  after a short TTL so "install the runtime → retry" succeeds without a
 *  daemon restart. */
const PROBE_MISS_TTL_MS = 60000;
const pathCache = new Map(); // name → { found, at }

function binaryOnPath(name) {
  const hit = pathCache.get(name);
  const now = Date.now();
  if (hit && (hit.found || now - hit.at < PROBE_MISS_TTL_MS)) return hit.found;
  let found = false;
  const env = { ...process.env, PATH: freshPath() };
  try {
    const probe = IS_WIN
      ? spawnSync("where", [name], { timeout: 3000, windowsHide: true, env })
      : spawnSync("sh", ["-c", `command -v ${name}`], { timeout: 3000, env });
    found = probe.status === 0;
  } catch {
    found = false;
  }
  pathCache.set(name, { found, at: now });
  return found;
}

/** Leading binary of each command segment ("cd x && npm run build" → cd, npm).
 *  Quotes/env-prefixes are not parsed exhaustively — this is a best-effort
 *  check for KNOWN runtimes only; anything odd falls through to the shell. */
function leadingBinaries(command) {
  return String(command)
    .split(/&&|\|\||[;|]/)
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((b) => b.toLowerCase().replace(/\.(exe|cmd|bat)$/, ""));
}

/** null when all known runtimes in the command are installed, else the
 *  structured runtime_missing result to return to the agent. */
function missingRuntime(command) {
  for (const bin of leadingBinaries(command)) {
    const known = KNOWN_RUNTIMES[bin];
    if (known && !binaryOnPath(bin)) {
      return {
        error: "runtime_missing",
        runtime: known.runtime,
        binary: bin,
        command,
        exit_code: -1,
        suggestion:
          `'${bin}' is not installed on this machine (checked PATH, including ` +
          `freshly installed locations). The user needs ${known.runtime}: ${known.install}. ` +
          `After installing, simply retry — no restart needed. (If installed via a ` +
          `version manager like nvm/pyenv, they may need to activate it first, ` +
          `e.g. 'nvm use' / 'pyenv global'.)`,
      };
    }
  }
  return null;
}

function nonInteractiveEnv() {
  return {
    ...process.env,
    PATH: freshPath(), // runtimes installed mid-session work without restart
    npm_config_yes: "true",
    GIT_TERMINAL_PROMPT: "0",
    PIP_NO_INPUT: "1",
    DEBIAN_FRONTEND: "noninteractive",
  };
}

function killTree(pid) {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 5000, windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL"); // negative pid → whole process group
    }
  } catch { /* already gone */ }
}

/**
 * Run `command` in the workspace `root`. Resolves (never rejects) with the
 * same result shape the server-side run_terminal tool returns, so the LLM
 * sees no difference between server and client execution:
 *   { stdout, stderr, exit_code, truncated, timed_out? } or
 *   { error, ... } for spawn failures / missing runtimes / timeouts.
 *
 * `onLine(stream, line)` — optional live-output callback, invoked once per
 * complete output line ("stdout" | "stderr"). This is what backs the
 * streaming NDJSON mode of POST /exec so the browser can render terminal
 * lines as they happen, like the server-executed tool does over SSE.
 */
function execInRoot(root, command, timeoutSeconds, onLine) {
  const cmd = String(command || "").trim();
  if (!cmd) return Promise.resolve({ error: "command is required", exit_code: -1 });

  const missing = missingRuntime(cmd);
  if (missing) return Promise.resolve(missing);

  const timeoutS = Math.min(Math.max(1, Number(timeoutSeconds) || DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S);

  // NOTE: no environment rewriting here. Project-local isolation (venv,
  // node_modules, Maven's local repo, GOPATH, vendor/bundle, …) is the
  // AGENT's decision, made per ecosystem — the right answer differs
  // completely across languages and a hardcoded rule can encode only one.
  // See backend/prompts/skills/project_environment.md.
  const childEnv = nonInteractiveEnv();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd: root,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: !IS_WIN, // own process group on POSIX → killable as a tree
      });
    } catch (e) {
      return resolve({ error: `Failed to start command: ${e.message}`, command: cmd, exit_code: -1 });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutS * 1000);

    // Per-stream line splitter for the live callback; capped accumulation
    // for the final result (same cap either way).
    const lineBuf = { stdout: "", stderr: "" };
    const onData = (label) => (d) => {
      const text = String(d);
      if (label === "stdout") { if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += text; }
      else { if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += text; }
      if (!onLine) return;
      lineBuf[label] += text;
      const parts = lineBuf[label].split(/\r?\n/);
      lineBuf[label] = parts.pop(); // trailing partial line stays buffered
      for (const line of parts) {
        try { onLine(label, line); } catch { /* listener errors never kill the run */ }
      }
    };
    child.stdout.on("data", onData("stdout"));
    child.stderr.on("data", onData("stderr"));

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onLine) {
        // Flush trailing partial lines so the last output isn't lost.
        for (const label of ["stdout", "stderr"]) {
          if (lineBuf[label]) {
            try { onLine(label, lineBuf[label]); } catch { /* ignore */ }
            lineBuf[label] = "";
          }
        }
      }
      const cap = (s) =>
        s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated)` : s;
      if (timedOut) {
        return resolve({
          error:
            `Command timed out after ${timeoutS}s. If the output ends at a question ` +
            `or (y/n) prompt, re-run with non-interactive flags (--yes, -y, --no-input); ` +
            `otherwise pass a higher timeout.`,
          stdout: cap(stdout),
          stderr: cap(stderr),
          command: cmd,
          exit_code: -1,
          timed_out: true,
        });
      }
      resolve({
        stdout: cap(stdout),
        stderr: cap(stderr),
        exit_code: exitCode == null ? -1 : exitCode,
        truncated: stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS,
      });
    };

    child.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ error: `Failed to start command: ${e.message}`, command: cmd, exit_code: -1 });
      }
    });
    child.on("close", finish);
  });
}

/* ── Proactive runtime report (POST /runtimes/check) ─────────────────────────
   The browser detects the project's language(s) from manifest files and asks
   which runtimes exist on this machine BEFORE the agent plans any commands —
   so "Python is missing" surfaces up front, not as a failed build later. */

// Tools whose version flag isn't `--version`.
const VERSION_ARGS = { java: ["-version"], go: ["version"] };
// Binary names must be plain words — never shell-interpretable input.
const SAFE_BINARY_RE = /^[a-z0-9._-]{1,32}$/;
const MAX_RUNTIME_CHECKS = 16;

function runtimeVersion(bin) {
  try {
    const env = { ...process.env, PATH: freshPath() };
    const r = spawnSync(bin, VERSION_ARGS[bin] || ["--version"], {
      timeout: 3000,
      windowsHide: true,
      encoding: "utf8",
      env,
      shell: IS_WIN, // resolves npm.cmd-style shims on Windows
    });
    const out = `${r.stdout || ""} ${r.stderr || ""}`.trim(); // java prints to stderr
    const m = /\d+(\.\d+)+/.exec(out);
    return m ? m[0] : (out.split(/\r?\n/)[0].slice(0, 40) || null);
  } catch {
    return null;
  }
}

/** { node: {available:true, version:"20.11.0"}, python: {available:false,
 *    runtime:"Python", install:"https://…"}, … } */
function checkRuntimes(binaries) {
  const names = [...new Set(
    (Array.isArray(binaries) ? binaries : [])
      .map((b) => String(b).toLowerCase().trim())
      .filter((b) => SAFE_BINARY_RE.test(b)),
  )].slice(0, MAX_RUNTIME_CHECKS);
  const result = {};
  for (const bin of names) {
    if (binaryOnPath(bin)) {
      result[bin] = { available: true, version: runtimeVersion(bin) };
    } else {
      const known = KNOWN_RUNTIMES[bin];
      result[bin] = {
        available: false,
        ...(known ? { runtime: known.runtime, install: known.install } : {}),
      };
    }
  }
  return result;
}

module.exports = {
  execInRoot,
  checkRuntimes,
  missingRuntime,
  leadingBinaries,
  freshPath,
  KNOWN_RUNTIMES,
  MAX_TIMEOUT_S,
  _pathCache: pathCache,
};
