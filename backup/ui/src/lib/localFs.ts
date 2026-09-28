/**
 * localFs — File System Access API utilities.
 *
 * Lets the IDE read and write files directly on the user's local machine
 * (Chrome / Edge 86+). Falls back gracefully when the API is unavailable.
 *
 * Architecture:
 *   1. User picks a folder via pickDirectory() → FileSystemDirectoryHandle.
 *   2. Handle stored in IndexedDB (devaccel_app / fs_handles) so it survives
 *      page reloads (user must re-grant permission on each session).
 *   3. WorkspaceProvider retrieves the handle on load, calls requestPermission(),
 *      scans the directory to populate the IDB node tree, then calls cacheHandle()
 *      so the module-level cache is hot for the session.
 *   4. workspace-api functions check getCachedHandle() and use FS reads/writes
 *      in preference to IDB when the handle is available.
 *
 * API integration path: when server endpoints for workspace file CRUD exist,
 * the getCachedHandle() checks in workspace-api can be replaced with server
 * calls without touching any UI code.
 */

import type { WsNode } from "@/lib/db/workspaceStore";
import { openAppDb } from "@/lib/db/workspaceStore";

/* ── API availability ───────────────────────────────────────────────────── */

export const isFsApiAvailable = (): boolean =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;

/* ── Module-level handle cache (populated by WorkspaceProvider) ─────────── */

const _cache = new Map<number, FileSystemDirectoryHandle>();

export function cacheHandle(wsId: number, handle: FileSystemDirectoryHandle): void {
  _cache.set(wsId, handle);
}

export function getCachedHandle(wsId: number): FileSystemDirectoryHandle | null {
  return _cache.get(wsId) ?? null;
}

export function evictHandle(wsId: number): void {
  _cache.delete(wsId);
}

/* ── IDB persistence (fs_handles store in devaccel_app) ─────────────────── */

export async function storeDirectoryHandle(
  wsId: number,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openAppDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("fs_handles", "readwrite");
    t.objectStore("fs_handles").put({ id: wsId, handle });
    t.oncomplete = () => resolve();
    t.onerror   = () => reject(t.error);
  });
}

export async function getDirectoryHandle(
  wsId: number,
): Promise<FileSystemDirectoryHandle | null> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const t   = db.transaction("fs_handles", "readonly");
    const req = t.objectStore("fs_handles").get(wsId);
    req.onsuccess = () => resolve((req.result as { handle: FileSystemDirectoryHandle } | undefined)?.handle ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function removeDirectoryHandle(wsId: number): Promise<void> {
  const db = await openAppDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("fs_handles", "readwrite");
    t.objectStore("fs_handles").delete(wsId);
    t.oncomplete = () => resolve();
    t.onerror   = () => reject(t.error);
  });
}

/* ── Permission ─────────────────────────────────────────────────────────── */

export async function requestPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<boolean> {
  try {
    // queryPermission/requestPermission are Chromium extensions not yet in TS lib types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = handle as any;
    const status = await h.queryPermission({ mode });
    if (status === "granted") return true;
    const granted = await h.requestPermission({ mode });
    return granted === "granted";
  } catch {
    return false;
  }
}

/* ── Folder picker ──────────────────────────────────────────────────────── */

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  // showDirectoryPicker is a Chromium extension to the standard
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).showDirectoryPicker({ mode: "readwrite" });
}

/* ── Directory scanning ─────────────────────────────────────────────────── */

const MAX_DEPTH = 8;
// Common noise directories — skip to keep the tree manageable
const SKIP = new Set([
  "node_modules", ".git", "__pycache__", ".next", "dist", "build",
  ".vscode", ".idea", "venv", ".venv", "coverage", ".cache",
]);

export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  parentPath = "",
  depth = 0,
): Promise<WsNode[]> {
  if (depth > MAX_DEPTH) return [];
  const nodes: WsNode[] = [];
  // FileSystemDirectoryHandle implements AsyncIterable<[string, FileSystemHandle]>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const [name, entry] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith(".") && depth > 0) continue; // skip hidden in subfolders
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (entry.kind === "directory") {
      if (SKIP.has(name)) continue;
      nodes.push({ path, type: "folder", parentPath });
      const children = await scanDirectory(
        entry as FileSystemDirectoryHandle,
        path,
        depth + 1,
      );
      nodes.push(...children);
    } else {
      nodes.push({ path, type: "file", parentPath });
    }
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

/* ── Internal path resolution helpers ──────────────────────────────────── */

async function resolveParent(
  root: FileSystemDirectoryHandle,
  filePath: string,
  create = false,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = filePath.split("/").filter(Boolean);
  const name  = parts.pop()!;
  let   dir   = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return { dir, name };
}

/* ── File read ──────────────────────────────────────────────────────────── */

export async function readFsFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const { dir, name } = await resolveParent(root, path, false);
  const fh   = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return file.text();
}

/**
 * Read a file as raw bytes.
 *
 * readFsFile() calls File.text(), which decodes as UTF-8 — correct for source
 * and config, destructive for everything else: a .docx or .pdf read that way
 * arrives as replacement characters that no parser can recover. Document
 * extraction needs the actual bytes.
 */
export async function readFsFileBytes(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<Uint8Array> {
  const { dir, name } = await resolveParent(root, path, false);
  const fh   = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/* ── File write ─────────────────────────────────────────────────────────── */

export async function writeFsFile(
  root: FileSystemDirectoryHandle,
  path: string,
  content: string,
): Promise<void> {
  const { dir, name } = await resolveParent(root, path, true);
  const fh       = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Write raw bytes. `writeFsFile` takes a string, which cannot carry a .docx or
 * a .png — used when saving an attachment into the user's own workspace so the
 * file on their disk is the real one, byte for byte.
 */
export async function writeFsFileBytes(
  root: FileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const { dir, name } = await resolveParent(root, path, true);
  const fh       = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  // Copy into a fresh ArrayBuffer: a Uint8Array view over a larger buffer
  // would otherwise write the whole backing buffer.
  await writable.write(bytes.slice().buffer as ArrayBuffer);
  await writable.close();
}

/* ── CRUD ───────────────────────────────────────────────────────────────── */

export async function createFsEntry(
  root: FileSystemDirectoryHandle,
  path: string,
  type: "file" | "folder",
): Promise<void> {
  const { dir, name } = await resolveParent(root, path, true);
  if (type === "folder") {
    await dir.getDirectoryHandle(name, { create: true });
  } else {
    const fh = await dir.getFileHandle(name, { create: true });
    const w  = await fh.createWritable();
    await w.write("");
    await w.close();
  }
}

export async function deleteFsEntry(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const { dir, name } = await resolveParent(root, path, false);
  await dir.removeEntry(name, { recursive: true });
}

/** Rename/move a single file — read → write at new path → delete old. */
export async function renameFsFile(
  root: FileSystemDirectoryHandle,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const content = await readFsFile(root, oldPath);
  await writeFsFile(root, newPath, content);
  await deleteFsEntry(root, oldPath);
}

/** Recursively copy every file in srcPath into destPath, preserving structure. */
async function copyFsDirectory(
  root: FileSystemDirectoryHandle,
  srcPath: string,
  destPath: string,
): Promise<void> {
  const { dir: srcParent, name: srcName } = await resolveParent(root, srcPath, false);
  const srcDir = await srcParent.getDirectoryHandle(srcName, { create: false });
  const { dir: destParent, name: destName } = await resolveParent(root, destPath, true);
  const destDir = await destParent.getDirectoryHandle(destName, { create: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const [name, entry] of (srcDir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (entry.kind === "file") {
      const fh   = await srcDir.getFileHandle(name);
      const file = await fh.getFile();
      const dFh  = await destDir.getFileHandle(name, { create: true });
      const w    = await dFh.createWritable();
      await w.write(await file.text());
      await w.close();
    } else {
      await copyFsDirectory(root, `${srcPath}/${name}`, `${destPath}/${name}`);
    }
  }
}

/**
 * Rename/move a directory on the live filesystem.
 * The File System Access API has no atomic rename, so we copy-then-delete.
 */
export async function renameFsFolder(
  root: FileSystemDirectoryHandle,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await copyFsDirectory(root, oldPath, newPath);
  await deleteFsEntry(root, oldPath);
}
