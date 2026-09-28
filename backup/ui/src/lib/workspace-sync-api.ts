/**
 * workspace-sync-api - API client for workspace metadata and chat history sync.
 *
 * Chat sessions are cached in localStorage for fast UI hydration and persisted
 * to Workspace Studio so they survive server restarts and browser cache loss.
 */

import { authFetch } from "@/lib/auth";
import { fitChatSessions, getItem, setItem } from "@/lib/storage";
import { uuid } from "@/lib/uuid";

const WORKSPACE_STUDIO = "/workspace-api";

export interface WorkspaceMetadata {
  id: number;
  name: string;
  description?: string;
  localPathLabel?: string;
  createdAt: number;
  fileCount: number;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: unknown[];
  createdAt: number;
}

export async function saveWorkspaceMetadata(
  wsId: number,
  metadata: WorkspaceMetadata,
): Promise<void> {
  setItem(`ws_meta_${wsId}`, JSON.stringify(metadata));
}

export async function loadWorkspaceMetadata(
  wsId: number,
): Promise<WorkspaceMetadata | null> {
  try {
    const raw = getItem(`ws_meta_${wsId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveChatSessions(
  wsId: number,
  sessions: ChatSession[],
): Promise<void> {
  // Cache the recent tail only. This is the third tier (user's machine →
  // Workspace Studio → browser), so a capped copy loses nothing — the FULL
  // list still goes to the server below. Uncapped, one key per workspace grew
  // without limit until the origin was full and login could not store its token.
  const { sessions: cacheable } = fitChatSessions(sessions);
  setItem(`chat_sessions_${wsId}`, JSON.stringify(cacheable));

  try {
    await authFetch(`${WORKSPACE_STUDIO}/workspaces/${wsId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions }),
    }, { silent: true });
  } catch { /* backend sync is best-effort; local cache is already updated */ }
}

export async function loadChatSessions(
  wsId: number,
): Promise<ChatSession[] | null> {
  try {
    const raw = getItem(`chat_sessions_${wsId}`);
    const local = raw ? JSON.parse(raw) : null;
    if (Array.isArray(local) && local.length > 0) return local;
  } catch { /* fallback to backend */ }

  try {
    const res = await authFetch(`${WORKSPACE_STUDIO}/workspaces/${wsId}/chat`, {}, { silent: true });
    if (res.ok) {
      const data = await res.json();
      const sessions = data.sessions ?? data;
      if (Array.isArray(sessions) && sessions.length > 0) {
        const { sessions: cacheable } = fitChatSessions(sessions);
        setItem(`chat_sessions_${wsId}`, JSON.stringify(cacheable));
        // Return what the SERVER sent, not the trimmed cache — the caller is
        // rendering a conversation, not reading storage.
        return sessions;
      }
    }
  } catch { /* no remote chat available */ }
  return null;
}

/* ── Workspace state sync (POST /api/workspaces/{id}/sync) ──────────────────
 *
 * Pushes a snapshot of recoverable workspace state to the real Workspace
 * Studio sync endpoint so file operations are reflected in the SERVER
 * database (recovery metadata/state + a sync audit log). File *content*
 * stays client-local by design — the server only records metadata + state,
 * which is exactly what SyncService accepts (op ∈ {"metadata","state"}).
 * The backend dedupes by (client_id, batch_id), so retries are idempotent.
 */

/** Stable per-browser id so the server can dedupe/attribute sync batches. */
export function getSyncClientId(): string {
  const KEY = "ws_sync_client_id";
  try {
    let id = getItem(KEY);
    if (!id) {
      id = uuid();
      // Essential: losing this id makes the server treat every batch as coming
      // from a new client, defeating the (client_id, batch_id) dedupe.
      setItem(KEY, id, "essential");
    }
    return id;
  } catch {
    return "anonymous-client";
  }
}

export interface WorkspaceSyncOp {
  op_id: string;
  op: "metadata" | "state";
  path?: string;
  type?: "file" | "folder";
  payload: Record<string, unknown>;
}

/* ── Recovery-state rehydration (GET /api/workspaces/{id}/state) ────────────
 *
 * The server holds the last recovery snapshot the client pushed via /sync
 * (open tabs, active file, layout). This reads it back so the UI can be
 * rebuilt when IndexedDB is missing / empty / stale (e.g. new device, cache
 * wipe). Deduped per-workspace so the tabs restorer and the layout restorer
 * share a single request.
 */
export interface WorkspaceRecoveryState {
  open_tabs?: Array<{ path: string; active?: boolean; order?: number }>;
  active_files?: string[];
  layout?: Record<string, unknown>;
  recent_files?: string[];
}

const _recoveryStateCache = new Map<number, Promise<WorkspaceRecoveryState | null>>();

export function fetchRecoveryState(wsId: number): Promise<WorkspaceRecoveryState | null> {
  const cached = _recoveryStateCache.get(wsId);
  if (cached) return cached;
  const p = (async (): Promise<WorkspaceRecoveryState | null> => {
    try {
      const res = await authFetch(`${WORKSPACE_STUDIO}/workspaces/${wsId}/state`, {}, { silent: true });
      if (!res.ok) return null;
      return (await res.json().catch(() => null)) as WorkspaceRecoveryState | null;
    } catch {
      return null;
    }
  })();
  _recoveryStateCache.set(wsId, p);
  // Expire shortly so a later reload re-fetches a fresh snapshot.
  void p.finally(() => setTimeout(() => _recoveryStateCache.delete(wsId), 4000));
  return p;
}

/** Outcome the sync engine acts on: retry (transient) vs drop (rejected). */
export type PushSyncResult =
  | { status: "ok"; syncVersion: number }
  | { status: "retry" }   // offline / network / 5xx / proxy — try again later
  | { status: "drop" };   // 4xx validation — clearing avoids an infinite loop

export async function pushWorkspaceSync(
  wsId: number,
  args: {
    batchId: string;
    localPathLabel?: string | null;
    baseSyncVersion?: number;
    operations: WorkspaceSyncOp[];
  },
): Promise<PushSyncResult> {
  const body = {
    client_id: getSyncClientId(),
    batch_id: args.batchId,
    local_fs_path: args.localPathLabel ?? null,
    base_sync_version: args.baseSyncVersion ?? 0,
    operations: args.operations,
  };
  try {
    const res = await authFetch(
      `${WORKSPACE_STUDIO}/workspaces/${wsId}/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { silent: true },
    );
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { status: "ok", syncVersion: Number(data?.sync_version ?? 0) };
    }
    // 4xx (except throttling/timeout) means the request itself is bad — don't
    // retry forever. Everything else (5xx, 502 proxy) is transient.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      return { status: "drop" };
    }
    return { status: "retry" };
  } catch {
    // Network failure / backend unreachable — transient.
    return { status: "retry" };
  }
}
