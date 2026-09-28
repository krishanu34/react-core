/**
 * search.js — daemon-side grep and glob.
 *
 * Why these live in the daemon and not the browser: the browser executor used
 * to implement grep_search by pulling EVERY file's content over HTTP, one
 * GET /fs/read per file. On the repos where search matters most — large
 * existing codebases — that is thousands of round trips per search, and the
 * agent issues several searches per question. Runs regularly blew the 120 s
 * client-tool timeout, the model saw a tool error instead of results, and
 * answered from guesswork.
 *
 * Here the walk and the matching happen next to the disk, in one process, and
 * one HTTP round trip returns the finished result. Feature set mirrors the
 * server's grep_search_tool.py (which mirrors Claude Code's Grep): content /
 * files_with_matches / count modes, context lines, per-file and total caps,
 * multiline. The two implementations are kept behaviourally aligned by the
 * shared caps below and by their test suites using the same scenarios.
 */

"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { resolveInRoot } = require("./fs");
const scanPolicy = require("./scanPolicy");

// Which directories to prune is decided per call by scanPolicy.js — from the
// project's own ignore files, overridden when the caller targets a directory
// or passes include_ignored. See that module for why the constant had to go:
// with it, "what does the installed copy of this library actually do?" had no
// answer the agent could reach.

const SKIP_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".exe", ".dll", ".so", ".dylib",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".sqlite", ".db", ".bin", ".class", ".map", ".lock",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
]);

// Same caps as the server tool — the contract must not depend on which side
// executed the search.
const MAX_PER_FILE = 5;
const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 200;
const MAX_CONTEXT = 10;
const MAX_FILE_SIZE = 1_000_000;
const MAX_WALK_FILES = 50_000;   // stop walking pathological trees
const GLOB_MAX_RESULTS = 200;

/* ── shared helpers ──────────────────────────────────────────────────────── */

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** gitignore-style glob → RegExp. A bare "*.py" matches basenames at any
 * depth; a pattern containing "/" or "**" matches the workspace-relative
 * path. Mirrors _glob_match in grep_search_tool.py. */
function globToRegExp(pattern) {
  // Token-wise translation (no chained replaces): '**/' means any directory
  // prefix or none, '**' anything across separators, '*' within a segment.
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
        else { out += ".*"; i += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function matchesGlob(relPath, pattern) {
  if (!pattern) return true;
  if (!pattern.includes("/") && !pattern.includes("**")) {
    return globToRegExp(pattern).test(path.posix.basename(relPath));
  }
  return globToRegExp(pattern).test(relPath);
}

/** Recursively collect candidate files, cheapest checks first. */
async function walkFiles(rootAbs, policy) {
  const pol = policy || scanPolicy.build(rootAbs);
  const out = [];
  const stack = [{ abs: rootAbs, rel: "" }];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const { abs, rel } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      const childRel = rel ? `${rel}/${name}` : name;
      if (ent.isDirectory()) {
        // Pruned by relative PATH, not just name — by name alone the walk
        // could never reach a directory the caller explicitly aimed at.
        if (pol.skipDir(name, childRel)) continue;
        stack.push({ abs: path.join(abs, name), rel: childRel });
      } else if (ent.isFile()) {
        if (SKIP_EXTENSIONS.has(extOf(name))) continue;
        out.push({ abs: path.join(abs, name), rel: childRel });
        if (out.length >= MAX_WALK_FILES) break;
      }
    }
  }
  return out;
}

function compileQuery(query, caseSensitive, multiline) {
  let flags = caseSensitive ? "" : "i";
  if (multiline) flags += "ms";
  try {
    return new RegExp(query, flags);
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

function looksBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

/* ── grep ────────────────────────────────────────────────────────────────── */

/**
 * options: { query, file_pattern, output_mode, context, case_sensitive,
 *            multiline, head_limit, offset }
 * Result shape matches grep_search_tool.py so the model (and the UI) see one
 * contract regardless of which side executed the search.
 */
async function grep(root, options) {
  const query = String(options.query ?? "");
  if (!query) return { error: "grep requires a query." };

  const mode = ["content", "files_with_matches", "count"]
    .includes(options.output_mode) ? options.output_mode : "content";
  const context = Math.max(0, Math.min(Number(options.context) || 0, MAX_CONTEXT));
  const limit = Math.max(1, Math.min(Number(options.head_limit) || DEFAULT_LIMIT, HARD_LIMIT));
  const offset = Math.max(0, Number(options.offset) || 0);
  const caseSensitive = options.case_sensitive !== false;
  const multiline = options.multiline === true;
  const re = compileQuery(query, caseSensitive, multiline);

  const policy = scanPolicy.build(root, {
    includeIgnored: options.include_ignored === true,
    filePattern: options.file_pattern || "",
  });
  const files = await walkFiles(root, policy);
  const perFileCounts = [];   // [rel, count]
  const matches = [];
  let filesSearched = 0;

  for (const f of files) {
    if (!matchesGlob(f.rel, options.file_pattern)) continue;
    let buf;
    try {
      const stat = await fsp.stat(f.abs);
      if (stat.size > MAX_FILE_SIZE) continue;
      buf = await fsp.readFile(f.abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    filesSearched++;

    const text = buf.toString("utf8");
    const lines = text.split("\n");
    let count = 0;
    const fileMatches = [];

    if (multiline) {
      // Global flag added per-iteration to avoid stateful lastIndex surprises.
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      for (const m of text.matchAll(g)) {
        count++;
        if (fileMatches.length >= MAX_PER_FILE) continue;
        const lineNum = text.slice(0, m.index).split("\n").length;
        fileMatches.push({ line: lineNum, text: (lines[lineNum - 1] ?? "").trimEnd() });
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        count++;
        if (fileMatches.length >= MAX_PER_FILE) continue;
        fileMatches.push({ line: i + 1, text: lines[i].trimEnd() });
      }
    }

    if (count === 0) continue;
    perFileCounts.push([f.rel, count]);

    if (mode === "content") {
      for (const fm of fileMatches) {
        const entry = { file: f.rel, line: fm.line, content: fm.text.slice(0, 300) };
        if (context) {
          const i = fm.line - 1;
          const lo = Math.max(0, i - context);
          const hi = Math.min(lines.length, i + context + 1);
          const rows = [];
          for (let j = lo; j < hi; j++) {
            const mark = j === i ? ":" : "-";
            rows.push(`${String(j + 1).padStart(5)}${mark} ${lines[j].trimEnd().slice(0, 200)}`);
          }
          entry.snippet = rows.join("\n");
        }
        matches.push(entry);
      }
      // Content mode can stop once the requested window is provably full;
      // survey modes must finish the walk — the distribution IS the answer.
      if (matches.length >= offset + limit + 1) break;
    }
  }

  if (mode === "files_with_matches" || mode === "count") {
    if (mode === "count") {
      perFileCounts.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    } else {
      perFileCounts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    const total = perFileCounts.length;
    const window = perFileCounts.slice(offset, offset + limit);
    const result = {
      query,
      output_mode: mode,
      total_files: total,
      files_searched: filesSearched,
      engine: "daemon",
    };
    if (mode === "count") {
      result.counts = window.map(([file, n]) => ({ file, matches: n }));
      result.total_matches = perFileCounts.reduce((s, [, n]) => s + n, 0);
    } else {
      result.files = window.map(([file]) => file);
    }
    if (total === 0) result.message = `No matches found for '${query}'`;
    else if (total > offset + window.length) {
      result.truncated = true;
      result.message = `Showing ${window.length} of ${total} files. ` +
        `Page with offset=${offset + window.length} or narrow with file_pattern.`;
    }
    return result;
  }

  // Deterministic (file, line) order makes `offset` paging stable across
  // calls and keeps this engine aligned with the server tool.
  matches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const total = matches.length;
  const window = matches.slice(offset, offset + limit);
  if (window.length === 0) {
    return {
      query, matches: [], total_matches: total,
      files_searched: filesSearched, engine: "daemon",
      message: total === 0
        ? `No matches found for '${query}'`
        : `Offset ${offset} is past the end (${total} matches).`,
    };
  }
  const result = {
    query,
    matches: window,
    total_matches: total,
    files_with_matches: new Set(window.map((m) => m.file)).size,
    files_searched: filesSearched,
    engine: "daemon",
  };
  if (offset) result.offset = offset;
  if (total > offset + window.length) {
    result.truncated = true;
    result.message = `Showing ${window.length} of ${total} matches ` +
      `(each file capped at ${MAX_PER_FILE}). Narrow with file_pattern, ` +
      `page with offset=${offset + window.length}, or survey with ` +
      `output_mode='files_with_matches'.`;
  }
  return result;
}

/* ── glob ────────────────────────────────────────────────────────────────── */

/**
 * Find files by name pattern, newest-modified first — Claude Code's Glob
 * ordering. On an old codebase, "touched recently" is the strongest signal of
 * which of 40 same-named files the question is actually about.
 */
async function glob(root, pattern, searchPath, includeIgnored) {
  const base = searchPath ? resolveInRoot(root, searchPath) : root;
  const prefix = searchPath ? `${searchPath.replace(/\\/g, "/").replace(/\/+$/, "")}/` : "";
  // Targets are workspace-relative but the walk starts at `base`, so the
  // policy is re-based by the same prefix that makes child paths
  // workspace-relative again — otherwise a target could never match once
  // searchPath narrowed the walk, which is exactly when it matters.
  const policy = scanPolicy.build(root, {
    includeIgnored: includeIgnored === true,
    path: searchPath || "",
    filePattern: pattern || "",
  });
  const files = await walkFiles(base, prefix ? wrapWithPrefix(policy, prefix) : policy);

  const collected = [];
  for (const f of files) {
    const rel = prefix + f.rel;
    if (!matchesGlob(f.rel, pattern) && !matchesGlob(rel, pattern)) continue;
    try {
      const stat = await fsp.stat(f.abs);
      collected.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* raced deletion — skip */
    }
  }

  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const window = collected.slice(0, GLOB_MAX_RESULTS);
  const result = {
    pattern,
    search_path: searchPath || ".",
    total_found: collected.length,
    sorted_by: "modification time, newest first",
    scope: policy.describe(),
    files: window.map(({ path: p, size, mtimeMs }) => ({
      path: p,
      size,
      modified: new Date(mtimeMs).toISOString().slice(0, 16).replace("T", " "),
    })),
    truncated: collected.length > GLOB_MAX_RESULTS,
  };
  if (result.truncated) {
    result.message = `Showing the ${GLOB_MAX_RESULTS} most recently modified ` +
      `of ${collected.length} matches. Narrow the pattern or path.`;
  }
  return result;
}

/** A policy whose paths are re-based onto the workspace, for walks that do
 *  not start at the workspace root. */
function wrapWithPrefix(policy, prefix) {
  return {
    skipDir: (name, relPath) => policy.skipDir(name, prefix + relPath),
    describe: () => policy.describe(),
  };
}

module.exports = { grep, glob, globToRegExp, matchesGlob, walkFiles };
