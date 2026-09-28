"use client";

/**
 * useSyncEngine — drains the per-workspace IndexedDB outbox.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every file operation (create / update / rename / delete) is applied
 * synchronously to its real targets *before* it is queued:
 *   • IndexedDB          — the client-side workspace index (source of truth)
 *   • Local filesystem   — via the File System Access handle (fsHandle)
 * …and then an entry is written to the `outbox` store (see ExplorerTree and
 * useEditorTabs). In this architecture the SERVER only holds workspace
 * *metadata + session history* — file content is always client-local
 * (workspaceStore.isLocalWorkspaceId is true for every workspace, and the
 * Workspace Studio backend deliberately mounts no file-CRUD endpoints).
 *
 * The outbox therefore is the durable record of "changes applied on the
 * client that still need their side effects reconciled" — namely:
 *   1. keeping the workspace's `fileCount` metadata accurate, and
 *   2. reporting honest sync state to the UI (StatusBar).
 *
 * Until now nothing drained it: `clearOutboxOp` / `updateOutboxOpStatus`
 * were never called, so the pending-ops counter grew forever and the sync
 * indicator never returned to "synced". This hook closes that gap.
 *
 * Each cycle:
 *   • marks a batch of pending ops "sending",
 *   • reconciles workspace metadata (recomputes fileCount from the node tree),
 *   • pushes a metadata+state snapshot to the real server sync endpoint
 *     (POST /api/workspaces/{id}/sync) so the change is reflected in the
 *     server database (recovery state + audit log) — file content itself
 *     stays client-local by design,
 *   • clears the ops once the server acknowledges (or after MAX_ATTEMPTS of
 *     transient failures, so an unreachable backend can't make the pending
 *     counter grow forever — a later change re-sends a fresh full snapshot),
 *   • surfaces { pendingOps, status } for the StatusBar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOutbox,
  clearOutboxOp,
  updateOutboxOpStatus,
  getAllNodes,
  getTabs,
  getPref,
  getLocalWorkspace,
  updateLocalWorkspace,
  type OutboxOp,
} from "@/lib/db/workspaceStore";
import { pushWorkspaceSync, getSyncClientId, type WorkspaceSyncOp } from "@/lib/workspace-sync-api";
import type { SyncStatus } from "@/providers/WorkspaceProvider";

/** How often to attempt a drain when ops are waiting. */
const DRAIN_INTERVAL_MS = 3000;
/** Ops per cycle — keeps the Explorer responsive on very large batches. */
const BATCH_SIZE = 100;
/** Give up on a single op after this many failed attempts (poison-op guard). */
const MAX_ATTEMPTS = 5;

interface SyncEngineState {
  /** Ops still awaiting drain (excludes those actively "sending"). */
  pendingOps: number;
  /** Derived sync status for the StatusBar. */
  status: SyncStatus;
  /** Force an immediate drain (e.g. right after a burst of edits). */
  flushNow: () => void;
}

export function useSyncEngine(workspaceId: number | null): SyncEngineState {
  const [pendingOps, setPendingOps] = useState(0);
  const [status, setStatus] = useState<SyncStatus>("idle");

  // Consecutive transient (retriable) push failures for the current batch —
  // bounds retries so an unreachable backend can't grow the counter forever.
  const failuresRef = useRef(0);
  // Latest server sync_version, echoed back as base_sync_version next push.
  const syncVersionRef = useRef(0);
  // Guards against overlapping drains (interval + flushNow racing).
  const drainingRef = useRef(false);

  /**
   * Build the metadata + state snapshot the server sync endpoint accepts.
   * (SyncService only applies op ∈ {"metadata","state"} — file content is
   * client-local, so we sync recoverable state, not file bytes.)
   */
  const buildSnapshot = useCallback(
    async (wid: number): Promise<{ ops: WorkspaceSyncOp[]; localPathLabel?: string | null }> => {
      const [local, nodes, tabs, layout] = await Promise.all([
        getLocalWorkspace(wid),
        getAllNodes(wid).catch(() => []),
        getTabs(wid).catch(() => []),
        getPref<Record<string, unknown>>(wid, "layout").catch(() => null),
      ]);
      const fileCount = nodes.filter((n) => n.type === "file" && !n.deleted).length;
      const activePath = tabs.find((t) => t.active)?.path ?? null;

      // ORDER MATTERS: state MUST come before metadata. The server stores the
      // recovery metadata as a nested key inside the same session_state row,
      // and the "state" op replaces that whole row — so applying "state" after
      // "metadata" would clobber the just-written metadata. Applying "state"
      // first, then "metadata", lets metadata merge into the existing state row
      // (verified end-to-end against the running backend). Keep this order.
      const ops: WorkspaceSyncOp[] = [
        {
          op_id: `state-${wid}`,
          op: "state",
          payload: {
            open_tabs: tabs.map((t) => ({ path: t.path, active: !!t.active, order: t.order })),
            active_files: activePath ? [activePath] : [],
            recent_files: tabs.map((t) => t.path),
            layout: layout ?? {},
            version: 1,
          },
        },
        {
          op_id: `meta-${wid}`,
          op: "metadata",
          payload: {
            id: wid,
            name: local?.name ?? `Workspace ${wid}`,
            description: local?.description ?? null,
            localPathLabel: local?.localPathLabel ?? null,
            createdAt: local?.createdAt ?? null,
            fileCount,
          },
        },
      ];
      return { ops, localPathLabel: local?.localPathLabel ?? null };
    },
    [],
  );

  /**
   * Reconcile the workspace's cached fileCount metadata from the node tree.
   * Best-effort and cheap — the node tree already lives in IndexedDB.
   */
  const reconcileMetadata = useCallback(async (wid: number) => {
    try {
      const [nodes, local] = await Promise.all([
        getAllNodes(wid),
        getLocalWorkspace(wid),
      ]);
      if (!local) return;
      const fileCount = nodes.filter((n) => n.type === "file" && !n.deleted).length;
      if (fileCount !== local.fileCount) {
        await updateLocalWorkspace({ ...local, fileCount });
      }
    } catch {
      /* metadata reconcile is best-effort — never block the drain */
    }
  }, []);

  const drain = useCallback(async () => {
    if (workspaceId == null || drainingRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setStatus("offline");
      return;
    }
    drainingRef.current = true;
    try {
      const all = await getOutbox(workspaceId).catch(() => [] as OutboxOp[]);
      const queued = all.filter((o) => o.status !== "sending" && o.status !== "failed");

      if (queued.length === 0) {
        // Nothing queued. Recover any "sending" rows left behind by a hard
        // refresh mid-drain so they get retried on the next cycle.
        const stuck = all.filter((o) => o.status === "sending");
        for (const op of stuck) {
          if (op.id != null) await updateOutboxOpStatus(workspaceId, op.id, "pending").catch(() => {});
        }
        const remaining = all.filter((o) => o.status !== "failed").length;
        setPendingOps(remaining);
        setStatus(remaining > 0 ? "syncing" : "synced");
        return;
      }

      setStatus("syncing");
      const batch = queued.slice(0, BATCH_SIZE);
      const batchIds = batch.map((o) => o.id).filter((id): id is number => id != null);

      // The ops' real targets (IndexedDB + local filesystem) were already
      // written by the caller before enqueue. Mark them in-flight, then push a
      // recoverable-state snapshot to the server so the change is reflected in
      // the server database (recovery state + audit log).
      for (const id of batchIds) {
        await updateOutboxOpStatus(workspaceId, id, "sending").catch(() => {});
      }
      await reconcileMetadata(workspaceId);

      const { ops, localPathLabel } = await buildSnapshot(workspaceId);
      const result = await pushWorkspaceSync(workspaceId, {
        batchId: `${getSyncClientId()}-${Date.now()}`,
        localPathLabel,
        baseSyncVersion: syncVersionRef.current,
        operations: ops,
      });

      const clearBatch = async () => {
        for (const id of batchIds) await clearOutboxOp(workspaceId, id).catch(() => {});
      };
      const requeueBatch = async () => {
        for (const id of batchIds) await updateOutboxOpStatus(workspaceId, id, "pending").catch(() => {});
      };

      if (result.status === "ok") {
        syncVersionRef.current = result.syncVersion;
        failuresRef.current = 0;
        await clearBatch();
      } else if (result.status === "drop") {
        // Server rejected the snapshot (4xx) — clearing avoids an infinite
        // loop; a later change will build and send a corrected snapshot.
        failuresRef.current = 0;
        await clearBatch();
      } else {
        // Transient failure (offline / backend unreachable / 5xx). Retry a few
        // times, then drop the batch locally so the pending counter can't grow
        // forever — the next change re-sends a fresh full snapshot anyway.
        failuresRef.current += 1;
        if (failuresRef.current >= MAX_ATTEMPTS) {
          failuresRef.current = 0;
          await clearBatch();
        } else {
          await requeueBatch();
        }
      }

      const after = await getOutbox(workspaceId).catch(() => [] as OutboxOp[]);
      const stillPending = after.filter((o) => o.status !== "failed").length;
      setPendingOps(stillPending);
      setStatus(
        stillPending > 0
          ? result.status === "retry"
            ? "offline"
            : "syncing"
          : "synced",
      );
    } finally {
      drainingRef.current = false;
    }
  }, [workspaceId, reconcileMetadata, buildSnapshot]);

  const flushNow = useCallback(() => { void drain(); }, [drain]);

  // Reset counters when the workspace changes, then drain immediately.
  useEffect(() => {
    failuresRef.current = 0;
    syncVersionRef.current = 0;
    setPendingOps(0);
    setStatus("idle");
    if (workspaceId == null) return;
    void drain();
    const id = setInterval(() => { void drain(); }, DRAIN_INTERVAL_MS);
    // Drain again as soon as connectivity returns.
    const onOnline = () => { void drain(); };
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, [workspaceId, drain]);

  return { pendingOps, status, flushNow };
}

export default useSyncEngine;
