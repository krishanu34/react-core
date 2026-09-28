"use strict";

/**
 * scanPolicy.js — which directories a daemon-side search walks, per call.
 *
 * Client-side twin of backend/context/scan_policy.py, and it has to exist for
 * the same reason venv.js does: grep and glob are CLIENT tools, so for anyone
 * running the daemon the server's policy never executes. A frozen SKIP_DIRS
 * here would keep dependency questions unanswerable for exactly the users
 * whose machine holds the dependencies.
 *
 * Three layers, most specific first:
 *   1. the caller aimed at a directory (`path`, or the literal prefix of a
 *      glob) — that IS the decision, so scan it;
 *   2. `include_ignored` — a survey across dependencies;
 *   3. the project's own .gitignore, else a built-in noise set — because a
 *      brownfield tree handed over as a zip has no .git and no .gitignore,
 *      and defaulting to "search node_modules" buries every result.
 *
 * `.git` and `.devaccel` are never scanned in any mode.
 *
 * Kept deliberately in step with the Python module: same defaults, same
 * precedence, same targeting rule. When one changes, change both.
 */

const fs = require("node:fs");
const path = require("node:path");

const HARD_SKIP_DIRS = new Set([".git", ".devaccel"]);

const DEFAULT_NOISE_DIRS = new Set([
  // dependencies
  "node_modules", "bower_components", "vendor", "site-packages",
  "jspm_packages", "packages",
  // python envs / caches
  ".venv", "venv", ".virtualenv", "__pycache__", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", ".tox", ".nox", ".eggs",
  // build output
  "dist", "build", "out", "target", "bin", "obj", ".next", ".nuxt",
  ".output", ".svelte-kit", ".turbo", ".parcel-cache", ".gradle",
  // test/coverage artefacts
  "coverage", ".nyc_output", "htmlcov",
  // editor / OS
  ".idea", ".vs", ".vscode-test", ".cache", ".terraform",
]);

// Dotted directories that hold real project content rather than tool state.
const VISIBLE_DOT_DIRS = new Set([
  ".github", ".gitlab", ".well-known", ".config", ".circleci", ".azure",
  ".husky", ".changeset",
]);

const IGNORE_FILES = [".gitignore", ".rgignore", ".ignore"];
const MAX_IGNORE_BYTES = 200000;

// A .gitignore line naming a DIRECTORY: one plain segment, optionally rooted
// or trailing-slashed. Wildcards and multi-segment patterns are left alone —
// a half-implementation of gitignore semantics that hides the wrong folder is
// worse than not reading the file.
const GITIGNORE_DIR = /^\/?([A-Za-z0-9._+-]+)\/?$/;

/** The fixed-text directory part of a glob.
 *  `node_modules/express/**\/*.js` → `node_modules/express`
 *  `*.py` → `` (aims at nothing) */
function literalPrefix(pattern) {
  if (!pattern) return "";
  const parts = [];
  for (const seg of String(pattern).replace(/\\/g, "/").split("/")) {
    if (/[*?[]/.test(seg)) break;
    if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function readProjectNoise(root) {
  const found = new Set();
  for (const name of IGNORE_FILES) {
    const p = path.join(root, name);
    let text;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_IGNORE_BYTES) continue;
      text = fs.readFileSync(p, "utf8");
    } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      const m = GITIGNORE_DIR.exec(line);
      if (m) found.add(m[1]);
    }
  }
  return found.size > 0 ? found : null;
}

class ScanPolicy {
  constructor({ includeIgnored, targets, noiseDirs, fromProject }) {
    this.includeIgnored = !!includeIgnored;
    this.targets = targets || [];
    this.noiseDirs = noiseDirs || DEFAULT_NOISE_DIRS;
    this.fromProject = !!fromProject;
  }

  onTargetPath(relPath) {
    const rel = String(relPath || "").replace(/^\/+|\/+$/g, "");
    for (const t of this.targets) {
      // Under a target, or on the way down to one — pruning `node_modules`
      // when the target is `node_modules/express` would make targeting a
      // no-op, because the walk could never reach it.
      if (rel === t || rel.startsWith(`${t}/`) || t.startsWith(`${rel}/`)) return true;
    }
    return false;
  }

  /** Prune this directory? `relPath` is workspace-relative POSIX. */
  skipDir(name, relPath) {
    if (HARD_SKIP_DIRS.has(name)) return true;
    if (this.includeIgnored) return false;
    if (relPath && this.onTargetPath(relPath)) return false;
    if (this.noiseDirs.has(name)) return true;
    if (name.startsWith(".") && !VISIBLE_DOT_DIRS.has(name)) return true;
    return false;
  }

  describe() {
    if (this.includeIgnored) {
      return "searched everything, including dependencies and build output";
    }
    if (this.targets.length > 0) {
      return `targeted ${this.targets.join(", ")} (ignore rules bypassed there)`;
    }
    return "skipped dependencies, build output and caches per " +
      (this.fromProject ? "the project's ignore files" : "default noise rules");
  }
}

/**
 * Build the policy for one call.
 * `path` and `filePattern` are the caller's own arguments — passing them is
 * what makes targeting work.
 */
function build(root, { includeIgnored = false, path: searchPath = "", filePattern = "" } = {}) {
  const targets = [];
  for (const candidate of [searchPath, literalPrefix(filePattern)]) {
    if (!candidate) continue;
    const norm = String(candidate).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!norm || norm === "." || path.isAbsolute(candidate)) continue;
    if (!targets.includes(norm)) targets.push(norm);
  }

  const projectNoise = readProjectNoise(root);
  // The project's list SUPPLEMENTS the default: a .gitignore that happens not
  // to mention __pycache__ should not make __pycache__ searchable.
  const noise = new Set(DEFAULT_NOISE_DIRS);
  if (projectNoise) for (const d of projectNoise) noise.add(d);

  return new ScanPolicy({
    includeIgnored,
    targets,
    noiseDirs: noise,
    fromProject: projectNoise !== null,
  });
}

module.exports = {
  build,
  literalPrefix,
  ScanPolicy,
  HARD_SKIP_DIRS,
  DEFAULT_NOISE_DIRS,
};
