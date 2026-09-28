/**
 * workspace-api — REST client for the workspace/IDE module.
 *
 *   - Workspace Studio  /api/workspaces*  → workspace metadata (this backend)
 *   - CB (/cb-api)      /workspace/*, /session/*, /files/*  → tree, content, sessions
 *
 * Scoping: none of the workspace calls take an owner or project parameter. The
 * backend derives the owner from the JWT and returns only that user's
 * workspaces. (This module previously routed workspace metadata through the
 * DevAccel USG service's /api/v1/projects, which this product doesn't serve.)
 *
 * It reuses the shared auth helpers from @/lib/auth (token + 401 handling) but
 * does not modify them.
 */
import { authFetch } from "@/lib/auth";
import {
  getFile,
  putFile,
  putNodes,
  markNodeDeleted,
  markTreeDeleted,
  deleteFileContent,
  renameNodeAndFile,
  renameFolderInDb,
  restoreNode,
  hardDeleteTree,
  getAllNodes,
  isLocalWorkspaceId,
  type WsNode,
  type WsSession,
  type OwnedWorkspace,
} from "@/lib/db/workspaceStore";
import { getCachedHandle } from "@/lib/localFs";
import {
  getWorkspaceFileAccess,
  fromHandle,
  type FileAccess,
} from "@/lib/fileAccess";

/* Shared extension-to-language map (mirrors the one in useEditorTabs). */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", java: "java", cs: "csharp", go: "go", rs: "rust", rb: "ruby",
  php: "php", json: "json", yml: "yaml", yaml: "yaml", md: "markdown",
  html: "html", css: "css", scss: "scss", sql: "sql", sh: "shell",
  xml: "xml", txt: "plaintext",
};
const langOf = (path: string): string =>
  EXT_LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

const WORKSPACE_STUDIO = "/workspace-api";
/** Same-origin rewrite → :8001/api (see ui/next.config.ts). */
const CB = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";

/** Error carrying the HTTP status so callers can distinguish e.g. 409 (conflict). */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(body.detail ?? body.message ?? fallback, res.status);
  }
  return res.json() as Promise<T>;
}

/* ── Workspaces (Projects) ─────────────────────────────────────────────── */

export interface RawProject {
  id: number;
  name: string;
  description?: string | null;
  archived?: boolean;
  owner_id?: number | null;
  created_by_user_id?: number | null;
  owner_user_id?: number | null;
  local_fs_path?: string | null;
  status?: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * The signed-in user's workspaces.
 *
 * Scope comes from the JWT — there is deliberately no scoping parameter. This
 * used to require a `project_id` sourced from a dead `/api/v1/projects` call,
 * so with no project selected the list was silently empty and agent-created
 * workspaces (project_id NULL) never appeared at all.
 */
export async function listWorkspaces(): Promise<OwnedWorkspace[]> {
  const res = await authFetch(
    `${WORKSPACE_STUDIO}/workspaces?page_size=200`,
    {},
    { silent: true },
  );
  if (!res.ok) return [];
  const data = await res.json();
  const rows: RawProject[] = Array.isArray(data) ? data : data.items ?? [];
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? undefined,
    archived: p.status === "archived" || !!p.archived,
    ownerId: p.owner_user_id ?? p.owner_id ?? p.created_by_user_id ?? undefined,
    localPathLabel: p.local_fs_path ?? undefined,
    createdAt: p.created_at ? Date.parse(p.created_at) : undefined,
  }));
}

export async function getWorkspace(id: number): Promise<RawProject> {
  return jsonOrThrow(
    await authFetch(`${WORKSPACE_STUDIO}/workspaces/${id}`, {}, { silent: true }),
    "Failed to load workspace",
  );
}

/**
 * Create a workspace owned by the signed-in user (owner comes from the JWT).
 *
 * `localFsPath` is REQUIRED and must be the absolute folder path. It used to
 * fall back to the workspace name, which wrote a non-path into local_fs_path —
 * the listing then couldn't tell which machine the workspace lived on, so it
 * showed everywhere (see lib/workspace-list).
 */
export async function createWorkspace(
  name: string,
  description: string | undefined,
  localFsPath: string,
): Promise<RawProject> {
  return jsonOrThrow(
    await authFetch(`${WORKSPACE_STUDIO}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: description ?? null,
        local_fs_path: localFsPath,
      }),
    }),
    "Failed to create workspace",
  );
}

export async function renameWorkspace(id: number, name: string): Promise<RawProject> {
  return jsonOrThrow(
    await authFetch(`${WORKSPACE_STUDIO}/workspaces/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    "Failed to rename workspace",
  );
}

/** Soft delete = archive (no hard-delete endpoint exists today). */
export async function archiveWorkspace(id: number, _name?: string): Promise<RawProject> {
  void _name;
  return jsonOrThrow(
    await authFetch(`${WORKSPACE_STUDIO}/workspaces/${id}/archive`, { method: "POST" }),
    "Failed to archive workspace",
  );
}

export async function updateWorkspace(
  id: number,
  updates: { name?: string; description?: string | null; local_fs_path?: string | null },
): Promise<RawProject> {
  return jsonOrThrow(
    await authFetch(`${WORKSPACE_STUDIO}/workspaces/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }),
    "Failed to update workspace",
  );
}

/* ── File tree (hydrates IndexedDB nodes) ──────────────────────────────── */

interface RawTreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  children?: RawTreeNode[];
}

/** Flatten the backend tree into WsNode rows keyed by path. */
function flattenTree(nodes: RawTreeNode[], parentPath: string): WsNode[] {
  const out: WsNode[] = [];
  for (const n of nodes) {
    out.push({
      path: n.path,
      type: n.type,
      parentPath,
      size: n.size,
      childrenLoaded: n.type === "folder" ? Array.isArray(n.children) : undefined,
    });
    if (n.children?.length) out.push(...flattenTree(n.children, n.path));
  }
  return out;
}

/** Fetch the workspace source tree and return flattened nodes for IndexedDB. */
export async function fetchWorkspaceTree(projectId: number): Promise<WsNode[]> {
  const res = await authFetch(`${CB}/workspace/files?project_id=${projectId}`, {}, { silent: true });
  if (!res.ok) return [];
  const data = await res.json();
  const tree: RawTreeNode[] = data.tree ?? [];
  return flattenTree(tree, "");
}

export async function fetchFileContent(
  projectId: number,
  path: string,
): Promise<{ content: string; lang: string; size: number }> {
  if (isLocalWorkspaceId(projectId)) {
    // Prefer live filesystem when local access is available (daemon or FS API)
    const fa = resolveFileAccess(projectId);
    if (fa) {
      try {
        const content = await fa.read(path);
        // Mirror to IDB so the editor has a cached copy
        await putFile(projectId, { path, content, lang: "plaintext", dirty: false, updatedAt: Date.now() }).catch(() => {});
        return { content, lang: "plaintext", size: content.length };
      } catch { /* file may not exist yet — fall through to IDB */ }
    }
    const file = await getFile(projectId, path);
    if (file) return { content: file.content, lang: file.lang ?? "plaintext", size: file.content.length };
    return { content: "", lang: "plaintext", size: 0 };
  }
  const res = await authFetch(
    `${CB}/workspace/files/${path}?project_id=${projectId}`,
    {},
    { silent: true },
  );
  const data = await jsonOrThrow<{ content: string; language: string; size: number }>(
    res,
    "Failed to read file",
  );
  return { content: data.content, lang: data.language, size: data.size };
}

/* ── Sessions (hydrates IndexedDB sessions) ────────────────────────────── */

export async function fetchSessions(projectId: number): Promise<WsSession[]> {
  const res = await authFetch(`${CB}/session/list?project_id=${projectId}`, {}, { silent: true });
  if (!res.ok) return [];
  const data = await res.json();
  const rows: Array<{ id: number; session_name: string; status: string }> = data.sessions ?? [];
  return rows.map((s) => ({ id: s.id, name: s.session_name, status: s.status }));
}

export async function fetchActiveSession(projectId: number): Promise<WsSession | null> {
  const res = await authFetch(`${CB}/session/active?project_id=${projectId}`, {}, { silent: true });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.id) return null;
  return { id: data.id, name: data.session_name ?? "Session", status: data.status, isActive: true };
}

/* ── File CRUD (wraps existing /cb-api/workspace endpoints) ─────────────── */

/** URL-encode each path segment while keeping the slashes. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function normalizeClientPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

/**
 * Resolve a transport-agnostic FileAccess for a workspace. Prefers the session
 * cache (agent OR fs-api, populated on create/open); falls back to a cached
 * File System Access handle so reloaded browser workspaces keep working.
 */
function resolveFileAccess(projectId: number): FileAccess | null {
  const fa = getWorkspaceFileAccess(projectId);
  if (fa) return fa;
  const handle = getCachedHandle(projectId);
  return handle ? fromHandle(handle) : null;
}

function requireFileAccess(projectId: number): FileAccess {
  const fa = resolveFileAccess(projectId);
  if (!fa) {
    throw new Error(
      "Local file access is required before Workspace Studio can write files. " +
        "Start the DevAccel daemon or link a local folder over HTTPS/localhost.",
    );
  }
  return fa;
}

function ancestorFolderNodes(path: string): WsNode[] {
  const parts = normalizeClientPath(path).split("/").filter(Boolean);
  const nodes: WsNode[] = [];
  for (let i = 1; i < parts.length; i++) {
    nodes.push({
      path: parts.slice(0, i).join("/"),
      type: "folder",
      parentPath: parts.slice(0, i - 1).join("/"),
      childrenLoaded: true,
    });
  }
  return nodes;
}

export async function writeClientWorkspaceFile(
  projectId: number,
  path: string,
  content: string,
): Promise<string> {
  const cleanPath = normalizeClientPath(path);
  if (!cleanPath) throw new Error("File path is required.");
  const fa = requireFileAccess(projectId);
  const parentPath = cleanPath.includes("/") ? cleanPath.split("/").slice(0, -1).join("/") : "";
  await fa.write(cleanPath, content);
  await putNodes(projectId, [
    ...ancestorFolderNodes(cleanPath),
    { path: cleanPath, type: "file", parentPath },
  ]);
  await putFile(projectId, {
    path: cleanPath,
    content,
    lang: langOf(cleanPath),
    dirty: false,
    updatedAt: Date.now(),
  });
  return cleanPath;
}

export async function createFile(
  projectId: number,
  path: string,
  type: "file" | "folder",
  content = "",
): Promise<void> {
  const cleanPath = normalizeClientPath(path);
  const parentPath = cleanPath.includes("/") ? cleanPath.split("/").slice(0, -1).join("/") : "";
  if (isLocalWorkspaceId(projectId)) {
    if (type === "file") {
      await writeClientWorkspaceFile(projectId, cleanPath, content);
      return;
    }
    const fa = requireFileAccess(projectId);
    await fa.create(cleanPath, type);
    await putNodes(projectId, [
      ...ancestorFolderNodes(cleanPath),
      { path: cleanPath, type, parentPath },
    ]);
    return;
  }
  const url = `${CB}/workspace/files/create?project_id=${projectId}&path=${encodeURIComponent(path)}&type=${type}`;
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await jsonOrThrow(res, "Failed to create");
  // Mirror to IDB so the explorer reflects the new entry immediately
  await putNodes(projectId, [{ path, type, parentPath }]).catch(() => {});
  if (type === "file") {
    await putFile(projectId, { path, content, lang: langOf(path), dirty: false, updatedAt: Date.now() }).catch(() => {});
  }
}

export async function deleteFile(projectId: number, path: string): Promise<void> {
  const cleanPath = normalizeClientPath(path);
  if (isLocalWorkspaceId(projectId)) {
    const fa = requireFileAccess(projectId);
    // Remove from the live filesystem (recursive for folders)
    await fa.remove(cleanPath);
    // Soft-delete the node + all descendants; content kept in IDB for recovery
    await markTreeDeleted(projectId, cleanPath);
    return;
  }
  const res = await authFetch(
    `${CB}/workspace/files/${encodePath(path)}/delete?project_id=${projectId}`,
    { method: "POST" },
  );
  await jsonOrThrow(res, "Failed to delete");
  await markNodeDeleted(projectId, path).catch(() => {});
  await deleteFileContent(projectId, path).catch(() => {});
}

/**
 * Restore a soft-deleted file or folder subtree from local IndexedDB trash.
 * For local workspaces with an active FS handle, recreates the content on disk.
 */
export async function restoreFile(projectId: number, path: string): Promise<void> {
  await restoreNode(projectId, path);
  if (!isLocalWorkspaceId(projectId)) return;
  const fa = resolveFileAccess(projectId);
  if (!fa) return;
  // Recreate all file content under the restored path on the live filesystem
  const allNodes = await getAllNodes(projectId);
  const fileNodes = allNodes.filter(
    (n) => n.type === "file" && (n.path === path || n.path.startsWith(path + "/")),
  );
  for (const node of fileNodes) {
    const file = await getFile(projectId, node.path);
    if (file && file.content !== "(binary)") {
      await fa.write(node.path, file.content).catch(() => {});
    }
  }
}

/**
 * Permanently delete a soft-deleted node subtree from IndexedDB (nodes + content).
 * Does not touch the filesystem (already removed on initial delete).
 */
export async function hardDeleteFile(projectId: number, path: string): Promise<void> {
  await hardDeleteTree(projectId, path);
}

/** Rename a single file — works for both local (filesystem + IndexedDB) and server workspaces. */
export async function renameFile(
  projectId: number,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const cleanOldPath = normalizeClientPath(oldPath);
  const cleanNewPath = normalizeClientPath(newPath);
  const newParentPath = cleanNewPath.includes("/") ? cleanNewPath.split("/").slice(0, -1).join("/") : "";
  if (isLocalWorkspaceId(projectId)) {
    const fa = requireFileAccess(projectId);
    await fa.rename(cleanOldPath, cleanNewPath, "file");
    await renameNodeAndFile(projectId, cleanOldPath, cleanNewPath, newParentPath);
    return;
  }
  // Server: read content → create at new path → delete old
  const { content } = await fetchFileContent(projectId, oldPath);
  await createFile(projectId, newPath, "file", content);
  await deleteFile(projectId, oldPath);
}

/** Write updated content back to the live filesystem (called from useEditorTabs on save). */
export async function saveFileContent(
  projectId: number,
  path: string,
  content: string,
): Promise<void> {
  const cleanPath = normalizeClientPath(path);
  const lang = langOf(cleanPath);
  if (isLocalWorkspaceId(projectId)) {
    const fa = requireFileAccess(projectId);
    await fa.write(cleanPath, content);
    await putFile(projectId, { path: cleanPath, content, lang, dirty: false, updatedAt: Date.now() }).catch(() => {});
    return;
  }
  // Server workspaces: IDB only for now (server push via outbox)
  await putFile(projectId, { path, content, lang, dirty: false, updatedAt: Date.now() }).catch(() => {});
}

/**
 * Rename a folder — updates the live filesystem (local workspaces only) and
 * remaps all descendant node/file paths in IndexedDB.
 * For server workspaces the IDB rename is optimistic until a bulk-rename
 * endpoint is available.
 */
export async function renameFolder(
  projectId: number,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const cleanOldPath = normalizeClientPath(oldPath);
  const cleanNewPath = normalizeClientPath(newPath);
  if (isLocalWorkspaceId(projectId)) {
    const fa = requireFileAccess(projectId);
    await fa.rename(cleanOldPath, cleanNewPath, "folder");
  }
  await renameFolderInDb(projectId, cleanOldPath, cleanNewPath);
}
