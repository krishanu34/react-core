/**
 * clientTools — browser-side executor for workspace-manipulation tools.
 *
 * This is the client half of the Pattern C split (see
 * devsphere_ai/ARCHITECTURE_PLAN.md). Every tool here touches the user's files
 * through the transport-agnostic FileAccess (the local daemon over plain HTTP,
 * or the browser File System Access API on HTTPS/localhost) — so the agent
 * operates on the SAME bytes the Explorer shows, on the user's real local
 * folder, instead of a server-side copy. This is what makes agent file writes
 * land on the client machine (not the server) on a plain-HTTP deployment.
 *
 * Each executor returns a plain JSON-serializable object shaped like the
 * backend tool results (so the SSE timeline renders them identically). The
 * server's orchestrator emits `tool_use{name,input}`; ChatDock routes
 * client-side tools here, then POSTs the result back (`tool_result`).
 *
 * Tools implemented here (CLIENT):
 *   read_file · file_write · code_edit · list_directory · workspace_tree
 *   file_search · grep_search · batch_read_files · create_output · notebook_edit
 *   run_terminal · git (daemon transport only — executed via POST /exec)
 *
 * IMPORTANT: each executor reads the SAME argument names the server tool
 * advertises to the LLM (see devsphere_ai/tools/*_tool.py parameters()), because
 * the LLM fills in the server schema. Mismatched names → the arg arrives
 * undefined (e.g. create_output uses `filename`, not `path`; code_edit uses
 * `old_code`/`new_code`; the write tool is `file_write`). Keep these in sync.
 *
 * Everything else (web_fetch, sub_agent, memory, …) stays on the server —
 * see CLIENT_TOOLS below and toolManifest.ts.
 */

import { resolveWorkspaceFileAccess, type FileAccess } from "@/lib/fileAccess";
import { getDaemonPlatform } from "@/lib/fileAccess/agentClient";
import { callMcpTool, isMcpToolName } from "@/lib/mcp/mcpClient";
import type { WsNode } from "@/lib/db/workspaceStore";

/* ── The set of tools this browser executor can run ──────────────────────── */
export const CLIENT_TOOLS = new Set<string>([
  "read_file",
  "file_write",
  "code_edit",
  "list_directory",
  "workspace_tree",
  "file_search",
  "grep_search",
  "batch_read_files",
  "create_output",
  "notebook_edit",
  // Project memory (devaccel.md) lives IN the workspace, like Claude Code's
  // CLAUDE.md — the write must land on the user's machine, not the server.
  "update_project_memory",
]);

/**
 * run_terminal and git are advertised SEPARATELY from CLIENT_TOOLS: the
 * browser has no shell/git binary, but the daemon transport does (POST
 * /exec). Callers building the client_tools manifest add these only when
 * hasRuntimeHost() is true — that's what routes command execution to the
 * user's machine (Claude Code model) instead of the DevSphere server.
 */
export const RUNTIME_TOOLS = ["run_terminal", "git"] as const;

export function hasRuntimeHost(wsId: number): boolean {
  return typeof resolveWorkspaceFileAccess(wsId)?.exec === "function";
}

/**
 * OS the delegated commands will execute on, sent to the backend as
 * `client_os` so the model composes cmd.exe vs POSIX-sh commands for the
 * machine that actually runs them (NOT the server's OS).
 * Source of truth is the daemon's /health `platform` (the exec host);
 * falls back to the browser's own platform hints — daemon and browser run
 * on the same machine in this product. Returns "win32" | "darwin" |
 * "linux" | undefined (unknown → backend keeps its server-OS default).
 */
export function detectClientOs(): string | undefined {
  const daemonPlatform = getDaemonPlatform();
  if (daemonPlatform) return daemonPlatform;
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const hint = (nav.userAgentData?.platform || nav.platform || navigator.userAgent || "").toLowerCase();
    if (hint.includes("win")) return "win32";
    if (hint.includes("mac")) return "darwin";
    if (hint.includes("linux") || hint.includes("x11")) return "linux";
  } catch { /* SSR / restricted context */ }
  return undefined;
}

export function isClientTool(name: string): boolean {
  return CLIENT_TOOLS.has(name) || (RUNTIME_TOOLS as readonly string[]).includes(name);
}

/* ── Result envelope — mirrors the backend tool result shape ─────────────── */
export type ToolResult = Record<string, unknown> & { error?: string };

/* Guardrails matching the backend (read_file_tool.py). */
const MAX_FILE_SIZE = 500_000; // bytes — larger files are truncated
const MAX_GREP_FILE = 2_000_000; // don't regex-scan files bigger than this

/* Extensions that are NOT plain text. Two callers, two meanings:
     read_file    → parse these through documentExtract instead of reading
                    them as text (a .docx read as UTF-8 is replacement chars)
     grep_search  → skip them; a regex over compressed OOXML matches nothing
                    meaningful and costs a full read per file
   This used to be BINARY_EXT, and read_file REFUSED anything in it outright
   ("Binary file. Cannot display content.") — returned before the file was even
   opened, so a .docx spec sitting in the user's repo was unreadable. */
const NON_TEXT_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf",
  ".pyc", ".pyo", ".class", ".o", ".obj",
  ".woff", ".woff2", ".ttf", ".eot", ".sqlite", ".db",
]);

/* How much extracted text ONE file contributes inside a batch_read_files call.
   A batch is a survey — up to 50 files at a glance — so a 40-page PDF in it
   must not crowd out the other 49. read_file on that path returns all of it. */
const BATCH_EXTRACT_CHARS = 4_000;

/* ── Path safety: block traversal, keep everything workspace-relative ────── */
function safePath(path: string): string {
  const clean = String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.split("/").some((p) => p === "..")) {
    throw new Error(`Path escapes the workspace: ${path}`);
  }
  return clean;
}

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function numberLines(text: string, offset = 1, limit?: number): string {
  const all = text.split("\n");
  const start = Math.max(0, offset - 1);
  const slice = limit != null ? all.slice(start, start + limit) : all.slice(start);
  return slice
    .map((ln, i) => `${String(Math.max(1, offset) + i).padStart(4)} | ${ln}`)
    .join("\n");
}

/* Resolve the transport-agnostic file access (daemon OR FS-API) for the
   workspace. Works over the local daemon on plain HTTP AND the browser File
   System Access API on HTTPS/localhost — so the agent writes to the user's
   real local folder, never a server-side copy. */
function fa(wsId: number): FileAccess {
  const access = resolveWorkspaceFileAccess(wsId);
  if (!access) {
    throw new Error(
      "No local folder access. Start the DevAccel daemon (or open a local folder over HTTPS/localhost) and reopen the workspace.",
    );
  }
  return access;
}

/* Cache the scanned tree per call-batch so multi-file tools don't rescan. */
async function tree(wsId: number): Promise<WsNode[]> {
  return fa(wsId).scan();
}

/* ── Read-before-overwrite (Claude Code parity) ──────────────────────────────
   Claude Code refuses to overwrite a file you haven't Read this session
   ("File has not been read yet — read it first"). The model must have SEEN the
   current bytes before it can replace them, so a blind full-file overwrite —
   the classic way an agent nukes real code — is structurally impossible.

   We track, per workspace, which paths the agent has seen: read via read_file /
   batch_read_files, or created/written by the agent itself this session.
   file_write over an EXISTING, unseen file is rejected. code_edit is exempt —
   it reads the file itself to locate old_code, so it can't overwrite blindly. */
const seenFiles = new Map<number, Set<string>>();
function markSeen(wsId: number, path: string): void {
  let s = seenFiles.get(wsId);
  if (!s) { s = new Set<string>(); seenFiles.set(wsId, s); }
  s.add(path);
}
function hasSeen(wsId: number, path: string): boolean {
  return seenFiles.get(wsId)?.has(path) ?? false;
}

/* ── Individual tool executors ───────────────────────────────────────────── */

async function readFile(
  wsId: number,
  input: { path: string; offset?: number; limit?: number; previewChars?: number },
): Promise<ToolResult> {
  const path = safePath(input.path);
  const e = ext(path);

  // Documents, images, archives and media are PARSED, not refused. Text and
  // code keep the line-numbered path below: line numbers are what code_edit
  // and the model's own references anchor to, and no extractor improves on
  // reading a source file directly.
  if (NON_TEXT_EXT.has(e)) {
    return readExtracted(wsId, path, input);
  }

  let text: string;
  try {
    text = await fa(wsId).read(path);
  } catch {
    return { error: `File not found: ${path}` };
  }
  markSeen(wsId, path); // read-before-overwrite: this path is now safe to file_write
  const size = text.length;
  if (size > MAX_FILE_SIZE && input.offset == null) {
    return {
      path,
      size,
      truncated: true,
      message: `File is large (${size} bytes). Showing first 200 lines. Use offset/limit for specific sections.`,
      content: numberLines(text, 1, 200),
      total_lines: text.split("\n").length,
    };
  }
  const start = input.offset ?? 1;
  return {
    path,
    content: numberLines(text, start, input.limit),
    size,
    total_lines: text.split("\n").length,
    ...(input.offset || input.limit
      ? { showing: `lines ${start}-${start + (input.limit ?? text.split("\n").length) - 1}` }
      : {}),
  };
}

/**
 * Parse a non-text file into something the model can reason about.
 *
 * The bytes never leave the user's machine: they go from the daemon (or the
 * File System Access API) into the browser, are parsed here, and only the
 * extracted TEXT is returned to the server as the tool result. That is the
 * whole reason this runs client-side rather than uploading the file.
 *
 * For a PDF, offset/limit select PAGES — the unit the document actually has.
 */
async function readExtracted(
  wsId: number,
  path: string,
  input: { offset?: number; limit?: number; previewChars?: number },
): Promise<ToolResult> {
  const access = fa(wsId);
  let bytes: Uint8Array;
  try {
    bytes = await access.readBytes(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A size refusal from the daemon is not a missing file, and saying "not
    // found" would send the model hunting for a path that exists.
    if (/over the .*-byte read limit/.test(message)) return { path, error: message };
    return { error: `File not found: ${path}` };
  }

  const { extractDocument } = await import("./documentExtract");
  const doc = await extractDocument(bytes, path);
  markSeen(wsId, path);

  let text = doc.text;
  let showing: string | undefined;
  if (text && (input.offset != null || input.limit != null)) {
    const windowed = windowExtracted(text, doc.kind, input.offset, input.limit);
    text = windowed.text;
    showing = windowed.showing;
  }
  if (input.previewChars != null && text.length > input.previewChars) {
    text = text.slice(0, input.previewChars);
    showing = `preview — call read_file('${path}') for the full text`;
  }

  const result: ToolResult = {
    path,
    type: doc.kind,
    format: doc.label,
    size: doc.sizeBytes,
    extracted_by: doc.extractor || "none",
    ...doc.metadata,
    ...(text ? { content: text } : {}),
    ...(doc.truncated ? { truncated: true } : {}),
    ...(doc.notes.length ? { notes: doc.notes } : {}),
    ...(showing ? { showing } : {}),
  };

  // Images ride back to the server, which forwards them into the run's vision
  // buffer (agents/vision_buffer.py) so they reach the model as real image
  // content on its next turn. A tool result cannot carry an image itself.
  if (doc.images.length) {
    result.images = doc.images;
    result.message =
      `${doc.images.length} image(s) from this file are attached to this ` +
      `message — look at them directly.`;
  }
  if (!text && !doc.images.length && !doc.notes.length) {
    result.message = `No readable content could be extracted from ${path}.`;
  }
  return result;
}

/** Apply offset/limit to extracted text — by PAGE for PDFs, by line otherwise. */
function windowExtracted(
  text: string,
  kind: string,
  offset?: number,
  limit?: number,
): { text: string; showing: string } {
  if (kind === "pdf" && text.includes("--- Page ")) {
    const parts = text.split("\n\n--- Page ");
    // split() strips the marker from every element but the first; putting it
    // back keeps the page headers in what the model reads.
    const pages = [parts[0], ...parts.slice(1).map((p) => `--- Page ${p}`)];
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit != null ? start + limit : pages.length;
    const picked = pages.slice(start, end);
    if (picked.length === 0) {
      return { text: "", showing: `no pages in range (document has ${pages.length})` };
    }
    return {
      text: picked.join("\n\n"),
      showing: `pages ${start + 1}-${Math.min(end, pages.length)} of ${pages.length}`,
    };
  }
  const lines = text.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return {
    text: lines.slice(start, end).join("\n"),
    showing: `lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}`,
  };
}

/* Read-back verification: a write that silently didn't reach the disk
   (stale daemon root, transport hiccup) must surface as an ERROR the agent
   and user can see — not as a false success while the file stays stale. */
async function verifyWrite(wsId: number, path: string, expected: string): Promise<string | null> {
  try {
    const onDisk = await fa(wsId).read(path);
    if (onDisk !== expected) {
      return `Write verification failed for ${path}: the file on disk does not match what was written. The workspace connection may be stale — reopen the folder / restart the daemon and retry.`;
    }
    return null;
  } catch (e) {
    return `Write verification failed for ${path}: could not read the file back (${e instanceof Error ? e.message : String(e)}).`;
  }
}

async function writeFile(
  wsId: number,
  input: { path: string; content?: string },
): Promise<ToolResult> {
  const path = safePath(input.path);
  // `content` is a REQUIRED field (write_file_tool.py schema). If it's absent
  // the model's tool call was malformed / its arguments were dropped upstream
  // (e.g. a truncated tool-call JSON) — writing "" here would silently blank
  // the file and report success. Surface it so the agent re-issues the call.
  if (input.content == null) {
    return {
      error:
        `file_write for ${path} received no 'content'. The tool arguments were ` +
        `incomplete — re-issue the call with the full file content. To create ` +
        `an intentionally empty file, pass content: "".`,
    };
  }
  const content = input.content;

  // Claude Code parity: refuse to overwrite an EXISTING file the agent hasn't
  // read this session. This is the general form of the empty-content guard
  // below — it also blocks a non-empty but wrong/stale rewrite, not just a
  // blank one. New files (no existing content) are always allowed.
  let existing: string | null = null;
  try { existing = await fa(wsId).read(path); } catch { existing = null; }
  if (existing !== null && !hasSeen(wsId, path)) {
    return {
      error:
        `File '${path}' has not been read yet in this session. Read it first ` +
        `with read_file, then file_write — this prevents blindly overwriting ` +
        `content the agent hasn't actually seen.`,
    };
  }

  // Never silently blank an existing NON-EMPTY file. This is the exact
  // "edit made my file empty" failure: a transient/truncated content must
  // not overwrite real code. Creating a new (or already-empty) file with ""
  // stays allowed.
  if (content === "" && existing != null && existing.trim() !== "") {
    return {
      error:
        `Refusing to overwrite ${path} with empty content — it currently has ` +
        `${existing.length} bytes. Provide the full new content, or use ` +
        `code_edit for a targeted change.`,
    };
  }
  await fa(wsId).write(path, content);
  const problem = await verifyWrite(wsId, path, content);
  if (problem) return { error: problem };
  markSeen(wsId, path); // the agent now knows this file's true (just-written) content
  return { path, written: true, verified: true, bytes: content.length };
}

/* Exact-match str_replace edit — fails on 0 or >1 matches, like the backend.
   Server schema (code_edit_tool.py) uses old_code/new_code; accept the older
   old_string/new_string names too so either shape works. */
async function codeEdit(
  wsId: number,
  input: {
    path: string;
    old_code?: string; new_code?: string;
    old_string?: string; new_string?: string;
    replace_all?: boolean;
  },
): Promise<ToolResult> {
  const path = safePath(input.path);
  const oldStr = input.old_code ?? input.old_string ?? "";
  const newStr = input.new_code ?? input.new_string ?? "";
  let text: string;
  try {
    text = await fa(wsId).read(path);
  } catch {
    return { error: `File not found: ${path}` };
  }
  if (oldStr === "") return { error: "old_string must not be empty." };
  const count = text.split(oldStr).length - 1;
  if (count === 0) return { error: `old_string not found in ${path}. Read the file first.` };
  if (count > 1 && !input.replace_all) {
    return { error: `old_string is ambiguous (${count} matches). Add context or set replace_all.` };
  }
  // Use a function replacement so `$` sequences in newStr ($&, $1, $`, …) are
  // written literally, not interpreted as regex replacement patterns — code
  // containing `$` (template literals, shell vars) would otherwise be mangled.
  const updated = input.replace_all
    ? text.split(oldStr).join(newStr)
    : text.replace(oldStr, () => newStr);
  await fa(wsId).write(path, updated);
  const problem = await verifyWrite(wsId, path, updated);
  if (problem) return { error: problem };
  markSeen(wsId, path); // code_edit reads the file itself — safe for file_write next
  return {
    path,
    edited: true,
    verified: true,
    replacements: input.replace_all ? count : 1,
    diff: makeEditDiff(path, oldStr, newStr),
  };
}

/* A minimal unified-diff for a str_replace edit — shows the exact replaced
   text as removed lines and the new text as added lines. Rendered inline by the
   chat UI (DiffViewer), the way Claude Code shows edits. */
function makeEditDiff(path: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const header = `--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join("\n");
  return `${header}\n${body}`;
}

async function listDirectory(
  wsId: number,
  input: { path?: string },
): Promise<ToolResult> {
  const dir = input.path ? safePath(input.path) : "";
  const nodes = await tree(wsId);
  const prefix = dir ? `${dir}/` : "";
  // Direct children only.
  const children = nodes
    .filter((n) => n.path.startsWith(prefix) && !n.path.slice(prefix.length).includes("/"))
    .map((n) => ({ name: n.path.slice(prefix.length), type: n.type, path: n.path }));
  return { path: dir || ".", entries: children, count: children.length };
}

async function workspaceTree(wsId: number): Promise<ToolResult> {
  const nodes = await tree(wsId);
  return {
    tree: nodes.map((n) => (n.type === "folder" ? `${n.path}/` : n.path)).join("\n"),
    total: nodes.length,
  };
}

function globToRegExp(pattern: string): RegExp {
  // Minimal glob: ** → any depth, * → within a segment, ? → one char.
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

async function fileSearch(
  wsId: number,
  input: { pattern: string; path?: string; include_ignored?: boolean },
): Promise<ToolResult> {
  const access = fa(wsId);

  // Daemon transport: results come back newest-modified first (Claude Code's
  // Glob ordering). On an existing codebase the recently-touched files are
  // nearly always the ones the question is about, and the browser tree scan
  // carries no timestamps at all — this ordering only exists daemon-side.
  if (access.glob) {
    try {
      return (await access.glob(
        input.pattern,
        input.path ? safePath(input.path) : undefined,
        input.include_ignored === true,
      )) as ToolResult;
    } catch {
      /* daemon hiccup — fall through to the tree scan */
    }
  }

  const re = globToRegExp(input.pattern);
  const nodes = await tree(wsId);
  const matches = nodes
    .filter((n) => n.type === "file" && (re.test(n.path) || re.test(n.path.split("/").pop() ?? "")))
    .map((n) => n.path)
    .slice(0, 200);
  return { pattern: input.pattern, matches, count: matches.length };
}

interface GrepInput {
  query: string;
  // Full server schema (grep_search_tool.py) — passed through to whichever
  // engine executes the search so the model sees ONE contract everywhere.
  file_pattern?: string;
  case_sensitive?: boolean;
  output_mode?: "content" | "files_with_matches" | "count";
  context?: number;
  multiline?: boolean;
  head_limit?: number;
  offset?: number;
  // Reach into dependencies / build output. Forwarded to whichever engine
  // runs the search so the daemon path answers the same questions the server
  // path does — a fix applied only server-side is invisible to daemon users,
  // who are the ones with the dependencies on disk.
  include_ignored?: boolean;
  // Older/alternate names accepted for safety.
  include?: string;
  regex?: boolean;
  max_results?: number;
}

async function grepSearch(wsId: number, input: GrepInput): Promise<ToolResult> {
  const access = fa(wsId);

  // Daemon transport: search runs beside the disk, one round trip. This is
  // the path that makes brownfield repos workable — the in-browser loop below
  // fetches every file over HTTP and overruns the 120s tool timeout on any
  // sizeable existing codebase.
  if (access.grep) {
    try {
      return (await access.grep(input.query, {
        file_pattern: input.file_pattern ?? input.include,
        case_sensitive: input.case_sensitive,
        output_mode: input.output_mode,
        context: input.context,
        multiline: input.multiline,
        head_limit: input.head_limit ?? input.max_results,
        offset: input.offset,
        include_ignored: input.include_ignored,
      })) as ToolResult;
    } catch {
      /* daemon hiccup — fall through to the in-browser loop */
    }
  }

  // FS-API fallback (browser-only workspaces, no daemon). Slower by nature,
  // but honours the same parameters so behaviour differs only in speed.
  const nodes = await tree(wsId);
  const glob = input.file_pattern ?? input.include;
  const includeRe = glob ? globToRegExp(glob) : null;
  const mode = input.output_mode ?? "content";
  const contextN = Math.max(0, Math.min(input.context ?? 0, 10));
  const cap = Math.max(1, Math.min(input.head_limit ?? input.max_results ?? 50, 200));
  const offset = Math.max(0, input.offset ?? 0);
  const flags =
    (input.case_sensitive === false ? "i" : "") + (input.multiline ? "ms" : "");
  let re: RegExp;
  // The server treats the query as a regex (ripgrep). Try regex first, then
  // fall back to a literal match so a plain string never errors out.
  try {
    re = new RegExp(input.query, flags);
  } catch {
    re = new RegExp(escapeRegExp(input.query), flags);
  }

  const PER_FILE = 5; // one noisy generated file must not fill the result set
  const hits: { file: string; line: number; content: string; snippet?: string }[] = [];
  const perFile: Array<[string, number]> = [];

  for (const n of nodes) {
    if (n.type !== "file") continue;
    if (NON_TEXT_EXT.has(ext(n.path))) continue;
    if (includeRe && !includeRe.test(n.path)) continue;
    let text: string;
    try {
      text = await access.read(n.path);
    } catch {
      continue;
    }
    if (text.length > MAX_GREP_FILE) continue;
    const lines = text.split("\n");
    let count = 0;
    const fileHits: number[] = [];
    if (input.multiline) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      for (const m of text.matchAll(g)) {
        count++;
        if (fileHits.length < PER_FILE) {
          fileHits.push(text.slice(0, m.index).split("\n").length - 1);
        }
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        count++;
        if (fileHits.length < PER_FILE) fileHits.push(i);
      }
    }
    if (count === 0) continue;
    perFile.push([n.path, count]);
    if (mode === "content") {
      for (const i of fileHits) {
        const entry: { file: string; line: number; content: string; snippet?: string } = {
          file: n.path, line: i + 1, content: (lines[i] ?? "").slice(0, 300),
        };
        if (contextN) {
          const lo = Math.max(0, i - contextN);
          const hi = Math.min(lines.length, i + contextN + 1);
          entry.snippet = Array.from({ length: hi - lo }, (_, k) => {
            const j = lo + k;
            return `${String(j + 1).padStart(5)}${j === i ? ":" : "-"} ${lines[j].slice(0, 200)}`;
          }).join("\n");
        }
        hits.push(entry);
      }
      if (hits.length >= offset + cap + 1) break;
    }
  }

  if (mode === "files_with_matches" || mode === "count") {
    // Deterministic order, aligned with the daemon and server engines.
    if (mode === "count") perFile.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    else perFile.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const window = perFile.slice(offset, offset + cap);
    const base: ToolResult = {
      query: input.query, output_mode: mode,
      total_files: perFile.length, engine: "browser",
    };
    if (mode === "count") {
      base.counts = window.map(([file, matches]) => ({ file, matches }));
      base.total_matches = perFile.reduce((s, [, c]) => s + c, 0);
    } else {
      base.files = window.map(([file]) => file);
    }
    if (perFile.length === 0) base.message = `No matches found for '${input.query}'`;
    return base;
  }

  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const window = hits.slice(offset, offset + cap);
  const out: ToolResult = {
    query: input.query,
    matches: window,
    total_matches: hits.length,
    files_with_matches: new Set(window.map((h) => h.file)).size,
    engine: "browser",
  };
  if (hits.length === 0) out.message = `No matches found for '${input.query}'`;
  else if (hits.length > offset + window.length) {
    out.truncated = true;
    out.message =
      `Showing ${window.length} of ${hits.length} matches (each file capped ` +
      `at ${PER_FILE}). Narrow with file_pattern, page with ` +
      `offset=${offset + window.length}, or survey with ` +
      `output_mode='files_with_matches'.`;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function batchReadFiles(
  wsId: number,
  input: { paths: string[] },
): Promise<ToolResult> {
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const files: Record<string, unknown> = {};
  for (const p of paths.slice(0, 50)) {
    // previewChars bounds each document's contribution; images are dropped
    // from a batch entirely (below) because 50 files would blow the turn's
    // whole image budget in one call.
    const entry = await readFile(wsId, { path: p, previewChars: BATCH_EXTRACT_CHARS });
    if (Array.isArray(entry.images) && entry.images.length) {
      const count = entry.images.length;
      delete entry.images;
      entry.message = `Contains ${count} viewable image(s) — call read_file('${p}') to see them.`;
    }
    files[p] = entry;
  }
  return { files, count: Object.keys(files).length };
}

async function createOutput(
  wsId: number,
  // Server schema (create_output_tool.py) uses `filename` (+ optional mode),
  // NOT `path`. Reading `input.path` here left the name undefined → the daemon
  // resolved to the workspace ROOT dir → EISDIR. Accept both, prefer filename.
  input: { filename?: string; path?: string; content?: string; mode?: string },
): Promise<ToolResult> {
  const name = input.filename ?? input.path ?? "";
  if (!name) return { error: "create_output requires a filename." };
  const path = safePath(name);
  const access = fa(wsId);
  if (input.mode === "append") {
    let existing = "";
    try {
      existing = await access.read(path);
    } catch {
      existing = "";
    }
    const combined = existing ? `${existing}\n${input.content ?? ""}` : (input.content ?? "");
    await access.write(path, combined);
    return { status: "appended", filename: path, path, created: false };
  }
  // write() creates the file (and parent dirs) if missing — no separate create.
  await access.write(path, input.content ?? "");
  return { status: "created", filename: path, path, created: true };
}

/* Server schema (notebook_edit_tool.py): operation (replace|insert|delete|list),
   cell_index/cell_id, cell_type, source. Mirror those names here. */
async function notebookEdit(
  wsId: number,
  input: {
    path: string;
    operation?: string;
    cell_index?: number;
    cell_id?: string;
    cell_type?: string;
    source?: string;
    new_source?: string; // older name accepted
  },
): Promise<ToolResult> {
  const path = safePath(input.path);
  const access = fa(wsId);
  let raw: string;
  try {
    raw = await access.read(path);
  } catch {
    return { error: `Notebook not found: ${path}` };
  }
  let nb: { cells?: { cell_type?: string; source?: string[] | string; id?: string }[] };
  try {
    nb = JSON.parse(raw);
  } catch {
    return { error: `Not a valid .ipynb JSON: ${path}` };
  }
  const cells = nb.cells ?? (nb.cells = []);
  const op = input.operation ?? "replace";
  const src = input.source ?? input.new_source ?? "";
  const splitSource = (s: string) => s.split(/(?<=\n)/);

  // Resolve target index from cell_index or cell_id.
  const idxFromId =
    input.cell_id != null ? cells.findIndex((c) => c.id === input.cell_id) : -1;
  const idx = input.cell_index ?? (idxFromId >= 0 ? idxFromId : undefined);

  if (op === "list") {
    return {
      path,
      cells: cells.map((c, i) => ({
        index: i,
        type: c.cell_type,
        id: c.id,
        preview: (Array.isArray(c.source) ? c.source.join("") : c.source ?? "").slice(0, 80),
      })),
      count: cells.length,
    };
  }
  if (op === "insert") {
    const at = idx != null ? idx : cells.length;
    cells.splice(at, 0, { cell_type: input.cell_type ?? "code", source: splitSource(src) });
    await access.write(path, JSON.stringify(nb, null, 1));
    return { path, operation: "insert", cell_index: at, edited: true };
  }
  if (op === "delete") {
    if (idx == null || idx < 0 || idx >= cells.length) {
      return { error: `cell_index ${idx} out of range (0-${cells.length - 1}).` };
    }
    cells.splice(idx, 1);
    await access.write(path, JSON.stringify(nb, null, 1));
    return { path, operation: "delete", cell_index: idx, edited: true };
  }
  // replace (default)
  if (idx == null || idx < 0 || idx >= cells.length) {
    return { error: `cell_index ${idx} out of range (0-${cells.length - 1}).` };
  }
  cells[idx].source = splitSource(src);
  await access.write(path, JSON.stringify(nb, null, 1));
  return { path, operation: "replace", cell_index: idx, edited: true };
}

/* Project memory — mirrors update_project_memory_tool.py exactly: parse
   devaccel.md into ## sections, append/replace one, re-render in canonical
   order. Written to the USER's workspace root, like Claude Code's CLAUDE.md. */
const MEMORY_FILE = "devaccel.md";
const MEMORY_HEADER = "# DevAccel Project Memory\n> Auto-maintained by the DevSphere agent. Edit freely.\n\n";
const MEMORY_SECTIONS = ["Stack", "Architecture", "Commands", "Decisions", "Notes"];

async function updateProjectMemory(
  wsId: number,
  input: { section: string; content: string; mode?: string },
): Promise<ToolResult> {
  const section = String(input.section ?? "");
  if (!MEMORY_SECTIONS.includes(section)) {
    return { error: `Unknown section '${section}'. Valid: ${MEMORY_SECTIONS.join(", ")}` };
  }
  const access = fa(wsId);

  let existing = "";
  try {
    existing = await access.read(MEMORY_FILE);
  } catch {
    existing = ""; // first write — no file yet
  }
  if (existing.startsWith("# DevAccel")) {
    // Strip title + subtitle + blank line; re-added on render.
    existing = existing.split("\n").slice(3).join("\n");
  }

  // Parse into section → body (keep line endings, like the backend parser).
  const sections = new Map<string, string>();
  const preamble: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of existing.split(/(?<=\n)/)) {
    if (line.startsWith("## ")) {
      if (current !== null) sections.set(current, buf.join(""));
      else preamble.push(...buf);
      current = line.slice(3).trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (current !== null) sections.set(current, buf.join(""));
  else preamble.push(...buf);

  const content = String(input.content ?? "").trim();
  const existingBody = (sections.get(section) ?? "").trim();
  const mode = input.mode === "replace" ? "replace" : "append";
  sections.set(
    section,
    mode === "replace" || !existingBody ? `${content}\n` : `${existingBody}\n${content}\n`,
  );

  let out = preamble.join("");
  for (const name of MEMORY_SECTIONS) {
    const body = sections.get(name);
    if (body == null) continue;
    out += `## ${name}\n${body.replace(/\n+$/, "")}\n\n`;
  }
  const text = MEMORY_HEADER + out.replace(/\n+$/, "") + "\n";
  await access.write(MEMORY_FILE, text);

  const savedBody = (sections.get(section) ?? "").trim();
  return {
    status: "updated",
    file: MEMORY_FILE,
    section,
    mode,
    preview: savedBody.length > 120 ? `${savedBody.slice(0, 120)}…` : savedBody,
  };
}

/** devaccel.md content from the user's workspace, for context injection —
 *  null when the file doesn't exist. Sent with each message (project_memory
 *  form field) because the server cannot read a client-side workspace. */
export async function readProjectMemory(wsId: number): Promise<string | null> {
  try {
    const access = resolveWorkspaceFileAccess(wsId);
    if (!access) return null;
    const text = await access.read(MEMORY_FILE);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/* ── Execution tools (daemon transport only) ─────────────────────────────── */

const NO_RUNTIME_HOST: ToolResult = {
  error: "no_runtime_host",
  instruction:
    "This workspace is accessed via the browser only — no shell is " +
    "available. Tell the user to install and start the DevAccel daemon " +
    "(Setup Daemon tab) to enable command execution on their machine.",
};

/* Destructive-command gate — mirrors run_terminal_tool.py's _DANGEROUS list.
   When run_terminal executes on the client, the server tool (and its gate) is
   bypassed, so the same check must live here. */
const DANGEROUS_COMMANDS: [RegExp, string][] = [
  [/\brm\b.*\s-[^\s]*[rR]/i, "recursive file deletion (rm -r*)"],
  [/\brd\b.*\s\/s/i, "recursive directory delete (rd /s)"],
  [/\brmdir\b.*\s\/s/i, "recursive directory delete (rmdir /s)"],
  [/\bdrop\s+(table|database|schema)\b/i, "database drop"],
  [/\btruncate\s+table\b/i, "table truncation"],
  [/\bformat\s+\w+:/i, "disk format (Windows)"],
  [/\bmkfs\b/i, "filesystem format (mkfs)"],
  [/\bdd\s+if=/i, "raw disk write (dd)"],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, "system shutdown / reboot"],
  [/>\s*\/dev\/(sd|hd|nvme)/i, "direct disk write"],
];

/** Execute a shell command on the user's machine via the daemon (POST /exec).
    Result shape mirrors run_terminal_tool.py so the LLM sees no difference.
    `onLine` streams live output lines to the caller's terminal rendering. */
async function runTerminal(
  wsId: number,
  input: { command: string; timeout?: number; force?: boolean },
  onLine?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<ToolResult> {
  const command = String(input.command ?? "").trim();
  if (!command) return { error: "command is required" };

  if (!input.force) {
    const danger = DANGEROUS_COMMANDS.find(([re]) => re.test(command));
    if (danger) {
      return {
        status: "permission_required",
        command,
        reason: danger[1],
        instruction:
          "This command requires user approval before running. Call ask_user " +
          "with the command and reason, then if the user approves call " +
          "run_terminal again with force=true.",
      };
    }
  }

  const access = fa(wsId);
  if (typeof access.exec !== "function") {
    return { ...NO_RUNTIME_HOST, command };
  }
  try {
    return (await access.exec(command, input.timeout, onLine)) as ToolResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 404 = an old daemon build without /exec — tell the user to update it.
    if (/\(404\)/.test(msg)) {
      return {
        error:
          "The installed DevAccel daemon is an older build without command " +
          "execution. Ask the user to re-download the daemon from the Setup " +
          "Daemon tab, then retry.",
        command,
      };
    }
    return { error: msg, command };
  }
}

/* Client-side git — mirrors git_tool.py exactly (same operations, same
   safety blocks, same result shape) but executes on the user's machine via
   the daemon, where their real repo and git binary live. */
const GIT_SAFE_OPERATIONS = new Set(["status", "diff", "log", "branch", "stash", "blame"]);
const GIT_BLOCKED_ARGS = ["--force", "-f", "--hard", "push", "reset --hard", "clean -fd"];

async function gitTool(
  wsId: number,
  input: { operation: string; args?: string; files?: string[] },
): Promise<ToolResult> {
  const access = fa(wsId);
  if (typeof access.exec !== "function") return { ...NO_RUNTIME_HOST };

  const op = String(input.operation ?? "");
  if (!GIT_SAFE_OPERATIONS.has(op) && op !== "commit") {
    return { error: `Unknown operation '${op}'. Available: status, diff, log, branch, commit, stash, blame` };
  }
  if (input.args) {
    for (const blocked of GIT_BLOCKED_ARGS) {
      if (input.args.includes(blocked)) {
        return { error: `Blocked for safety: '${blocked}'. Use run_terminal for destructive operations.` };
      }
    }
  }

  const runGit = async (cmd: string): Promise<ToolResult> => {
    const r = (await access.exec!(`git ${cmd}`, 30)) as ToolResult & {
      stdout?: string; stderr?: string; exit_code?: number;
    };
    if (r.error) return r; // runtime_missing (git not installed) etc. — pass through
    return {
      command: `git ${cmd}`,
      exit_code: r.exit_code ?? -1,
      output: (r.stdout ?? "").trim(),
      errors: r.exit_code !== 0 ? (r.stderr ?? "").trim() : "",
    };
  };

  switch (op) {
    case "status": return runGit("status --short");
    case "diff": return runGit(input.args ? `diff ${input.args}` : "diff");
    case "log": return runGit(`log ${input.args ?? "-10 --oneline --decorate"}`);
    case "branch": return runGit(`branch ${input.args ?? "-a"}`);
    case "stash": return runGit(`stash ${input.args ?? "list"}`);
    case "blame":
      return input.args ? runGit(`blame ${input.args}`) : { error: "Provide a file path for blame" };
    case "commit": {
      for (const f of input.files ?? []) await runGit(`add ${f}`);
      const result = await runGit(`commit ${input.args ?? '-m "Update"'}`);
      return { operation: "commit", staged_files: input.files ?? [], result };
    }
    default:
      return { error: `Unknown operation '${op}'.` };
  }
}

/* ── Dispatcher ──────────────────────────────────────────────────────────── */

/** Optional per-call hooks (currently: live terminal output for run_terminal). */
export interface ClientToolOptions {
  onTerminalLine?: (stream: "stdout" | "stderr", line: string) => void;
}

/**
 * Execute a client-side tool. Returns a JSON-serializable result to POST back
 * to the orchestrator as `tool_result`. Never throws — errors become
 * `{ error }` so the agent can react instead of the stream dying.
 */
export async function executeClientTool(
  wsId: number,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
  opts?: ClientToolOptions,
): Promise<ToolResult> {
  try {
    // Local MCP tools (mcp__server__tool) are proxied to the daemon's MCP host,
    // where the stdio server actually runs on the user's machine (Pattern C).
    if (isMcpToolName(name)) {
      return await callMcpTool(name, input || {});
    }
    switch (name) {
      case "read_file": return await readFile(wsId, input);
      case "file_write": return await writeFile(wsId, input);
      case "code_edit": return await codeEdit(wsId, input);
      case "list_directory": return await listDirectory(wsId, input);
      case "workspace_tree": return await workspaceTree(wsId);
      case "file_search": return await fileSearch(wsId, input);
      case "grep_search": return await grepSearch(wsId, input);
      case "batch_read_files": return await batchReadFiles(wsId, input);
      case "create_output": return await createOutput(wsId, input);
      case "notebook_edit": return await notebookEdit(wsId, input);
      case "update_project_memory": return await updateProjectMemory(wsId, input);
      case "run_terminal": return await runTerminal(wsId, input, opts?.onTerminalLine);
      case "git": return await gitTool(wsId, input);
      default:
        return { error: `Tool '${name}' is not a client-executable tool.` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
