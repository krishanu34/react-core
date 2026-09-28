/**
 * fileAccess — entry point + availability ladder.
 *
 * Availability ladder (best → fallback):
 *   1. Local daemon reachable on 127.0.0.1  → AgentFileAccess  (works over HTTP)
 *   2. Browser File System Access API (HTTPS/localhost) → FsApiFileAccess
 *   3. Neither → callers show "start the daemon or use HTTPS" (never a silent hide)
 *
 * Callers use `getCapability()` to decide what UI to show, and construct a
 * concrete FileAccess via `openAgentRoot()` (path string) or `fromHandle()`
 * (picked directory handle).
 */

import { isFsApiAvailable, getCachedHandle } from "@/lib/localFs";
import { isAgentAvailable, discover } from "./agentClient";
import { AgentFileAccess } from "./AgentFileAccess";
import { FsApiFileAccess } from "./FsApiFileAccess";
import type { FileAccess, FileAccessCapability } from "./types";

export type { FileAccess, FileAccessCapability, FileAccessKind } from "./types";
export { AgentFileAccess } from "./AgentFileAccess";
export { FsApiFileAccess } from "./FsApiFileAccess";
export * as agentClient from "./agentClient";

/** Probe what local-file mechanisms are usable right now. */
export async function getCapability(): Promise<FileAccessCapability> {
  const fsApi = isFsApiAvailable();
  const agentUrl = await discover().catch(() => null);
  return { agent: !!agentUrl, fsApi, agentUrl: agentUrl ?? undefined };
}

/** True if ANY local-disk mechanism is available (daemon OR FS API). */
export async function isAnyFileAccessAvailable(): Promise<boolean> {
  if (isFsApiAvailable()) return true;
  return isAgentAvailable();
}

/**
 * Bind to a workspace root the daemon can see, by absolute path.
 * `create` mkdir-p's the folder first (used when saving uploaded files to a
 * new path); omit it when linking an existing folder.
 */
export function openAgentRoot(absPath: string, create = false): Promise<AgentFileAccess> {
  return AgentFileAccess.open(absPath, create);
}

/** Wrap a picked directory handle (browser File System Access API). */
export function fromHandle(handle: FileSystemDirectoryHandle): FileAccess {
  return new FsApiFileAccess(handle);
}

/* ── Per-workspace session cache ─────────────────────────────────────────────
 * Parallels localFs.cacheHandle/getCachedHandle but transport-agnostic: the
 * IDE resolves the correct FileAccess (agent OR fs-api) for a workspace without
 * caring which transport backs it. Populated on workspace open/create.
 * ────────────────────────────────────────────────────────────────────────── */
const _wsAccess = new Map<number, FileAccess>();

export function setWorkspaceFileAccess(wsId: number, fa: FileAccess): void {
  _wsAccess.set(wsId, fa);
}
export function getWorkspaceFileAccess(wsId: number): FileAccess | null {
  return _wsAccess.get(wsId) ?? null;
}

/**
 * Resolve the FileAccess for a workspace, transport-agnostically: the
 * session-bound access (daemon OR fs-api, set on open/create), falling back to
 * a cached File System Access handle. Use this anywhere that needs to touch the
 * user's local files (e.g. the agent's client-side tool executor) so it works
 * over the daemon on plain HTTP AND the browser FS API on HTTPS/localhost.
 */
export function resolveWorkspaceFileAccess(wsId: number): FileAccess | null {
  const fa = _wsAccess.get(wsId);
  if (fa) return fa;
  const handle = getCachedHandle(wsId);
  return handle ? fromHandle(handle) : null;
}
export function evictWorkspaceFileAccess(wsId: number): void {
  _wsAccess.delete(wsId);
}
