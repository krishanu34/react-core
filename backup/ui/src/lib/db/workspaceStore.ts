/**
 * workspaceStore — IndexedDB data layer for the new Workspace IDE.
 *
 * ISOLATION: brand-new module. It does not import or modify any existing code
 * and uses the native IndexedDB API (no external dependency) so package.json /
 * lockfile stay untouched.
 *
 * Tiers:
 *   - devaccel_app : app-level (last active workspace, cached owned list)
 *   - ws_<id>      : one database per workspace (nodes, files, tabs, sessions,
 *                    outbox, prefs, meta)
 *
 * The Explorer / tabs / breadcrumb read from here; server APIs hydrate & sync
 * (see hooks/useSyncEngine.ts).
 */

/* ── Types ─────────────────────────────────────────────────────────────── */
export interface WsNode {
  path: string;
  type: "file" | "folder";
  parentPath: string;
  size?: number;
  hash?: string;
  etag?: string;
  expanded?: boolean;
  childrenLoaded?: boolean;
  deleted?: boolean;
  deletedAt?: number;
}

export interface WsFile {
  path: string;
  content: string;
  etag?: string;
  lang?: string;
  dirty?: boolean;
  updatedAt?: number;
}

export interface WsTab {
  path: string;
  order: number;
  active?: boolean;
  cursor?: { line: number; column: number };
  scrollTop?: number;
}

export interface WsSession {
  id: number;
  name: string;
  status?: string;
  isActive?: boolean;
}

export interface OutboxOp {
  id?: number;
  op: "create" | "update" | "rename" | "delete";
  path: string;
  payload?: unknown;
  baseVersion?: number;
  status?: "pending" | "sending" | "failed";
}

export interface OwnedWorkspace {
  id: number;
  name: string;
  description?: string;
  archived?: boolean;
  ownerId?: number;
  projectId?: number;
  localPathLabel?: string;
  createdAt?: number;
}

export interface LocalWorkspace {
  /** Date.now() at creation — always > 1_000_000_000_000, never collides with server IDs. */
  id: number;
  projectId?: number;
  name: string;
  description?: string;
  localPathLabel?: string;
  createdAt: number;
  fileCount: number;
}

export interface LastActive {
  key: "lastActive";
  workspaceId: number | null;
  sessionId: number | null;
}

const APP_DB = "devaccel_app";
const APP_VERSION = 5;
const WS_VERSION = 1;

const isBrowser = (): boolean =>
  typeof window !== "undefined" && "indexedDB" in window;

/* ── Low-level helpers ─────────────────────────────────────────────────── */
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isBrowser()) {
      reject(new Error("IndexedDB is only available in the browser"));
      return;
    }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out: T | undefined;
    const r = fn(s);
    if (r) r.onsuccess = () => (out = r.result);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function bulkPut(db: IDBDatabase, store: string, items: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    items.forEach((it) => s.put(it));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ── App-level DB ──────────────────────────────────────────────────────── */
function appUpgrade(db: IDBDatabase) {
  if (!db.objectStoreNames.contains("app")) db.createObjectStore("app", { keyPath: "key" });
  if (!db.objectStoreNames.contains("owned")) db.createObjectStore("owned", { keyPath: "id" });
  if (!db.objectStoreNames.contains("local_workspaces"))
    db.createObjectStore("local_workspaces", { keyPath: "id" });
  // v4: stores FileSystemDirectoryHandle objects (structured-clone-able)
  if (!db.objectStoreNames.contains("fs_handles"))
    db.createObjectStore("fs_handles", { keyPath: "id" });
}

export function openAppDb(): Promise<IDBDatabase> {
  return openDb(APP_DB, APP_VERSION, appUpgrade);
}

export async function getLastActive(): Promise<LastActive | null> {
  const db = await openAppDb();
  return (await runTx<LastActive>(db, "app", "readonly", (s) => s.get("lastActive"))) ?? null;
}

export async function setLastActive(
  workspaceId: number | null,
  sessionId: number | null,
): Promise<void> {
  const db = await openAppDb();
  await runTx(db, "app", "readwrite", (s) =>
    s.put({ key: "lastActive", workspaceId, sessionId } satisfies LastActive),
  );
}

export async function getOwned(): Promise<OwnedWorkspace[]> {
  const db = await openAppDb();
  return (await runTx<OwnedWorkspace[]>(db, "owned", "readonly", (s) => s.getAll())) ?? [];
}

export async function setOwned(list: OwnedWorkspace[]): Promise<void> {
  const db = await openAppDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("owned", "readwrite");
    const s = t.objectStore("owned");
    s.clear();
    list.forEach((it) => s.put(it));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ── Local workspaces (IndexedDB-only, no backend required) ────────────── */

export async function createLocalWorkspace(
  data: Omit<LocalWorkspace, "id" | "createdAt">,
  id = Date.now(),
): Promise<LocalWorkspace> {
  const ws: LocalWorkspace = { ...data, id, createdAt: id };
  const db = await openAppDb();
  await runTx(db, "local_workspaces", "readwrite", (s) => s.put(ws));
  return ws;
}

export async function listLocalWorkspaces(): Promise<LocalWorkspace[]> {
  const db = await openAppDb();
  return (await runTx<LocalWorkspace[]>(db, "local_workspaces", "readonly", (s) => s.getAll())) ?? [];
}

export async function getLocalWorkspace(id: number): Promise<LocalWorkspace | null> {
  const db = await openAppDb();
  return (await runTx<LocalWorkspace>(db, "local_workspaces", "readonly", (s) => s.get(id))) ?? null;
}

export async function updateLocalWorkspace(ws: LocalWorkspace): Promise<void> {
  const db = await openAppDb();
  await runTx(db, "local_workspaces", "readwrite", (s) => s.put(ws));
}

export async function deleteLocalWorkspace(id: number): Promise<void> {
  const db = await openAppDb();
  await runTx(db, "local_workspaces", "readwrite", (s) => s.delete(id));
  await deleteWorkspaceDb(id);
}

/* Workspace Studio workspaces are metadata-backed, but files are always client-local. */
export const isLocalWorkspaceId = (id: number): boolean => Number.isFinite(id) && id > 0;

/* ── Per-workspace DB ──────────────────────────────────────────────────── */
const wsName = (id: number): string => `ws_${id}`;

function wsUpgrade(db: IDBDatabase) {
  if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
  if (!db.objectStoreNames.contains("nodes")) {
    const nodes = db.createObjectStore("nodes", { keyPath: "path" });
    nodes.createIndex("parentPath", "parentPath", { unique: false });
  }
  if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
  if (!db.objectStoreNames.contains("tabs")) db.createObjectStore("tabs", { keyPath: "path" });
  if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
  if (!db.objectStoreNames.contains("outbox"))
    db.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
  if (!db.objectStoreNames.contains("prefs")) db.createObjectStore("prefs", { keyPath: "key" });
}

export function openWorkspaceDb(id: number): Promise<IDBDatabase> {
  return openDb(wsName(id), WS_VERSION, wsUpgrade);
}

export async function deleteWorkspaceDb(id: number): Promise<void> {
  if (!isBrowser()) return;
  await promisify(indexedDB.deleteDatabase(wsName(id)) as unknown as IDBRequest);
}

/* nodes */
export async function getChildren(id: number, parentPath: string): Promise<WsNode[]> {
  const db = await openWorkspaceDb(id);
  const rows =
    (await runTx<WsNode[]>(db, "nodes", "readonly", (s) =>
      s.index("parentPath").getAll(parentPath),
    )) ?? [];
  return rows.filter((n) => !n.deleted).sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

export async function putNodes(id: number, nodes: WsNode[]): Promise<void> {
  const db = await openWorkspaceDb(id);
  await bulkPut(db, "nodes", nodes);
}

/** Clear all nodes then insert fresh ones — used after a directory scan so
 *  deleted/moved files don't linger in the explorer. */
export async function replaceNodes(id: number, nodes: WsNode[]): Promise<void> {
  const db = await openWorkspaceDb(id);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("nodes", "readwrite");
    t.objectStore("nodes").clear();
    t.oncomplete = () => resolve();
    t.onerror   = () => reject(t.error);
  });
  if (nodes.length) await bulkPut(db, "nodes", nodes);
}

/** Wipe all cached file content — call when linking a different local folder. */
export async function clearWorkspaceFiles(id: number): Promise<void> {
  const db = await openWorkspaceDb(id);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("files", "readwrite");
    t.objectStore("files").clear();
    t.oncomplete = () => resolve();
    t.onerror   = () => reject(t.error);
  });
}

/** All non-deleted nodes — used by the Search view for fast filename matching. */
export async function getAllNodes(id: number): Promise<WsNode[]> {
  const db = await openWorkspaceDb(id);
  const rows = (await runTx<WsNode[]>(db, "nodes", "readonly", (s) => s.getAll())) ?? [];
  return rows.filter((n) => !n.deleted);
}

export async function markNodeDeleted(id: number, path: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  const node = await runTx<WsNode>(db, "nodes", "readonly", (s) => s.get(path));
  if (node) {
    await runTx(db, "nodes", "readwrite", (s) =>
      s.put({ ...node, deleted: true, deletedAt: Date.now() }),
    );
  }
}

/**
 * Mark a node AND every descendant as deleted (soft-delete an entire subtree).
 * Content is preserved in the files store for recovery.
 */
export async function markTreeDeleted(id: number, prefix: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  const allNodes = (await runTx<WsNode[]>(db, "nodes", "readonly", (s) => s.getAll())) ?? [];
  const now = Date.now();
  const toMark = allNodes.filter(
    (n) => !n.deleted && (n.path === prefix || n.path.startsWith(prefix + "/")),
  );
  if (toMark.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("nodes", "readwrite");
    const s = t.objectStore("nodes");
    toMark.forEach((n) => s.put({ ...n, deleted: true, deletedAt: now }));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * Return top-level trash items — deleted nodes whose parent is NOT also deleted.
 * Sorted newest-first by deletedAt timestamp.
 */
export async function getTrash(id: number): Promise<WsNode[]> {
  const db = await openWorkspaceDb(id);
  const all = (await runTx<WsNode[]>(db, "nodes", "readonly", (s) => s.getAll())) ?? [];
  const deleted = all.filter((n) => n.deleted);
  const deletedPaths = new Set(deleted.map((n) => n.path));
  return deleted
    .filter((n) => !n.parentPath || !deletedPaths.has(n.parentPath))
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

/**
 * Restore a soft-deleted node: undeletes the node, all its descendants, and
 * all ancestor folders that were also marked deleted.
 */
export async function restoreNode(id: number, path: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  const allNodes = (await runTx<WsNode[]>(db, "nodes", "readonly", (s) => s.getAll())) ?? [];

  const parts = path.split("/").filter(Boolean);
  const ancestorPaths = new Set(parts.map((_, i) => parts.slice(0, i + 1).join("/")));

  const toRestore = allNodes.filter(
    (n) =>
      n.deleted &&
      (n.path === path || n.path.startsWith(path + "/") || ancestorPaths.has(n.path)),
  );
  if (toRestore.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("nodes", "readwrite");
    const s = t.objectStore("nodes");
    toRestore.forEach((n) => s.put({ ...n, deleted: false, deletedAt: undefined }));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * Permanently delete a node subtree from both the nodes and files stores.
 * Use only when the user explicitly empties trash or hard-deletes an item.
 */
export async function hardDeleteTree(id: number, prefix: string): Promise<void> {
  const db = await openWorkspaceDb(id);

  const allNodes = (await runTx<WsNode[]>(db, "nodes", "readonly", (s) => s.getAll())) ?? [];
  const nodePaths = allNodes
    .filter((n) => n.path === prefix || n.path.startsWith(prefix + "/"))
    .map((n) => n.path);
  if (nodePaths.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("nodes", "readwrite");
      const s = t.objectStore("nodes");
      nodePaths.forEach((p) => s.delete(p));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  const allFiles = (await runTx<WsFile[]>(db, "files", "readonly", (s) => s.getAll())) ?? [];
  const filePaths = allFiles
    .filter((f) => f.path === prefix || f.path.startsWith(prefix + "/"))
    .map((f) => f.path);
  if (filePaths.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("files", "readwrite");
      const s = t.objectStore("files");
      filePaths.forEach((p) => s.delete(p));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}

/** Hard-delete a node record (use after server-confirmed delete; prefer markNodeDeleted for optimistic ops). */
export async function deleteNode(id: number, path: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "nodes", "readwrite", (s) => s.delete(path));
}

/* files */
export async function getFile(id: number, path: string): Promise<WsFile | null> {
  const db = await openWorkspaceDb(id);
  return (await runTx<WsFile>(db, "files", "readonly", (s) => s.get(path))) ?? null;
}

export async function putFile(id: number, file: WsFile): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "files", "readwrite", (s) => s.put(file));
}

export async function deleteFileContent(id: number, path: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "files", "readwrite", (s) => s.delete(path));
}

/** Rename a single file node and its content blob (both keyed by path). */
export async function renameNodeAndFile(
  id: number,
  oldPath: string,
  newPath: string,
  newParentPath: string,
): Promise<void> {
  const db = await openWorkspaceDb(id);
  // update node
  const node = await runTx<WsNode>(db, "nodes", "readonly", (s) => s.get(oldPath));
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("nodes", "readwrite");
    const s = t.objectStore("nodes");
    if (node) {
      s.delete(oldPath);
      s.put({ ...node, path: newPath, parentPath: newParentPath });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  // update file content
  const file = await runTx<WsFile>(db, "files", "readonly", (s) => s.get(oldPath));
  if (file) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("files", "readwrite");
      const s = t.objectStore("files");
      s.delete(oldPath);
      s.put({ ...file, path: newPath });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}

/** Rename a folder: remaps the folder node + all descendant node paths + file content paths. */
export async function renameFolderInDb(id: number, oldPrefix: string, newPrefix: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  const remap = (p: string): string =>
    p === oldPrefix ? newPrefix :
    p.startsWith(oldPrefix + "/") ? newPrefix + p.slice(oldPrefix.length) : p;

  const allNodes = (await runTx<WsNode[]>(db, "nodes", "readonly", (s) => s.getAll())) ?? [];
  const affected = allNodes.filter(
    (n) => n.path === oldPrefix || n.path.startsWith(oldPrefix + "/") ||
           n.parentPath === oldPrefix || n.parentPath.startsWith(oldPrefix + "/"),
  );
  if (affected.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("nodes", "readwrite");
      const s = t.objectStore("nodes");
      // delete old keys first, then re-insert with new paths
      affected.forEach((n) => {
        if (n.path === oldPrefix || n.path.startsWith(oldPrefix + "/")) s.delete(n.path);
      });
      affected.forEach((n) => {
        s.put({ ...n, path: remap(n.path), parentPath: remap(n.parentPath) });
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  const allFiles = (await runTx<WsFile[]>(db, "files", "readonly", (s) => s.getAll())) ?? [];
  const affectedFiles = allFiles.filter((f) => f.path.startsWith(oldPrefix + "/"));
  if (affectedFiles.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("files", "readwrite");
      const s = t.objectStore("files");
      affectedFiles.forEach((f) => {
        s.delete(f.path);
        s.put({ ...f, path: remap(f.path) });
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}

/* tabs */
export async function getTabs(id: number): Promise<WsTab[]> {
  const db = await openWorkspaceDb(id);
  const all = (await runTx<WsTab[]>(db, "tabs", "readonly", (s) => s.getAll())) ?? [];
  return all.sort((a, b) => a.order - b.order);
}

export async function putTab(id: number, tab: WsTab): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "tabs", "readwrite", (s) => s.put(tab));
}

export async function removeTab(id: number, path: string): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "tabs", "readwrite", (s) => s.delete(path));
}

/* sessions */
export async function getSessions(id: number): Promise<WsSession[]> {
  const db = await openWorkspaceDb(id);
  return (await runTx<WsSession[]>(db, "sessions", "readonly", (s) => s.getAll())) ?? [];
}

export async function putSessions(id: number, sessions: WsSession[]): Promise<void> {
  const db = await openWorkspaceDb(id);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("sessions", "readwrite");
    const s = t.objectStore("sessions");
    s.clear();
    sessions.forEach((sess) => s.put(sess));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* prefs */
export async function getPref<T = unknown>(id: number, key: string): Promise<T | null> {
  const db = await openWorkspaceDb(id);
  const v = await runTx<{ key: string; value: T }>(db, "prefs", "readonly", (s) => s.get(key));
  return v ? v.value : null;
}

export async function setPref(id: number, key: string, value: unknown): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "prefs", "readwrite", (s) => s.put({ key, value }));
}

/* outbox */
export async function enqueueOutbox(id: number, op: OutboxOp): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "outbox", "readwrite", (s) => s.add({ ...op, status: "pending" }));
}

export async function getOutbox(id: number): Promise<OutboxOp[]> {
  const db = await openWorkspaceDb(id);
  return (await runTx<OutboxOp[]>(db, "outbox", "readonly", (s) => s.getAll())) ?? [];
}

export async function clearOutboxOp(id: number, opId: number): Promise<void> {
  const db = await openWorkspaceDb(id);
  await runTx(db, "outbox", "readwrite", (s) => s.delete(opId));
}

export async function updateOutboxOpStatus(
  id: number,
  opId: number,
  status: "pending" | "sending" | "failed",
): Promise<void> {
  const db = await openWorkspaceDb(id);
  const op = await runTx<OutboxOp>(db, "outbox", "readonly", (s) => s.get(opId));
  if (op) {
    await runTx(db, "outbox", "readwrite", (s) => s.put({ ...op, status }));
  }
}
