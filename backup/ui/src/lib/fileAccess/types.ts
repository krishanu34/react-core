/**
 * fileAccess/types — transport-agnostic local file access.
 *
 * The IDE used to talk to the browser File System Access API directly
 * (see ui/src/lib/localFs.ts). That API is only exposed in a secure context
 * (HTTPS/localhost), so on a plain-HTTP deployment "Save to Disk" disappears.
 *
 * `FileAccess` abstracts a chosen workspace root so callers don't care whether
 * the bytes are written via:
 *   • FsApiFileAccess  — the browser File System Access API (HTTPS/localhost), or
 *   • AgentFileAccess  — the local daemon on 127.0.0.1 (works over plain HTTP,
 *                        and is what the CLI/IDE clients also use).
 *
 * Same interface, same results across browser/CLI/IDE. Files always stay on the
 * user's machine — nothing is uploaded to the server.
 */

import type { WsNode } from "@/lib/db/workspaceStore";

export type FileAccessKind = "fs-api" | "agent";

/** A file-access session bound to one workspace root on the user's machine. */
export interface FileAccess {
  /** Which transport backs this instance. */
  readonly kind: FileAccessKind;
  /** Human-readable root label for the workspace header (folder name or path). */
  readonly rootLabel: string;
  /**
   * Stable per-workspace key for daemon-side state (~/.devaccel/projects/
   * <stateId>/…) — the daemon's rootId. Only the daemon transport has one;
   * absence means per-user state can't be stored on this client.
   */
  readonly stateId?: string;

  /** Recursively list the workspace tree (same shape workspaceStore expects). */
  scan(): Promise<WsNode[]>;
  /** Read a file's text content by workspace-relative path. */
  read(path: string): Promise<string>;
  /**
   * Read a file's RAW BYTES by workspace-relative path.
   *
   * `read()` decodes as UTF-8, which silently destroys any non-text format —
   * a .docx or .pdf comes back as replacement characters. Document extraction
   * (lib/agent/documentExtract.ts) needs the real bytes, so it uses this.
   */
  readBytes(path: string): Promise<Uint8Array>;
  /** Create/overwrite a file with text content (parent dirs auto-created). */
  write(path: string, content: string): Promise<void>;
  /**
   * Create/overwrite a file with RAW BYTES (parent dirs auto-created).
   *
   * `write()` takes a string and so cannot carry a .docx, .pdf or .png without
   * corrupting it. Used when an attachment is saved into the user's own
   * workspace, where the copy on their disk must be the real file.
   */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Create an empty file or a folder. */
  create(path: string, type: "file" | "folder"): Promise<void>;
  /** Delete a file or folder (recursive for folders). */
  remove(path: string): Promise<void>;
  /** Rename/move a file or folder. */
  rename(oldPath: string, newPath: string, kind: "file" | "folder"): Promise<void>;

  /**
   * Execute a shell command in the workspace root on the user's machine.
   * Only the daemon transport can do this (the browser FS-API has no shell),
   * so it's optional — absence means "no runtime host on this client".
   * `onLine` receives live output lines for terminal-style rendering.
   */
  exec?(
    command: string,
    timeoutSeconds?: number,
    onLine?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<Record<string, unknown>>;

  /**
   * Content search executed WHERE THE FILES ARE (daemon transport only).
   * The alternative — the browser fetching every file to scan it — is one
   * HTTP round trip per file, which on a large existing repo overruns the
   * client-tool timeout. Absence means the caller falls back to that slower
   * in-browser loop (FS-API transport, small workspaces only).
   * Options/result contract: daemon/search.js, mirroring grep_search_tool.py.
   */
  grep?(
    query: string,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Find files by glob, newest-modified first (daemon transport only).
   *  `includeIgnored` reaches into dependencies and build output — the same
   *  opt-in the server tool exposes, so a daemon-backed search answers the
   *  same questions a server-backed one does. */
  glob?(
    pattern: string,
    searchPath?: string,
    includeIgnored?: boolean,
  ): Promise<Record<string, unknown>>;
}

/** What local-file mechanisms are currently usable in this client. */
export interface FileAccessCapability {
  /** Local daemon reachable on 127.0.0.1 (works over plain HTTP). */
  agent: boolean;
  /** Browser File System Access API present (needs HTTPS/localhost). */
  fsApi: boolean;
  /** Discovered daemon base URL, when agent === true. */
  agentUrl?: string;
}
