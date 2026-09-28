"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  setLastActive,
  putNodes,
  replaceNodes,
  putSessions,
  createLocalWorkspace,
  getLocalWorkspace,
  updateLocalWorkspace,
  isLocalWorkspaceId,
  type WsSession,
} from "@/lib/db/workspaceStore";
import {
  isFsApiAvailable,
  getDirectoryHandle,
  pickDirectory,
  getCachedHandle,
  requestPermission,
  scanDirectory,
  cacheHandle,
  storeDirectoryHandle,
} from "@/lib/localFs";
import {
  openAgentRoot,
  resolveWorkspaceFileAccess,
  setWorkspaceFileAccess,
  agentClient,
} from "@/lib/fileAccess";
import {
  getWorkspace,
  fetchWorkspaceTree,
  fetchSessions,
  fetchActiveSession,
} from "@/lib/workspace-api";

/* ========================================================================== *
 *  Types & context
 * ========================================================================== */
export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "conflict" | "error";

interface WorkspaceContextValue {
  workspaceId: number | null;
  workspaceName: string;
  activeSession: WsSession | null;
  sessions: WsSession[];
  syncStatus: SyncStatus;
  loading: boolean;
  /** Non-null when a local workspace has a live FileSystemDirectoryHandle. */
  fsHandle: FileSystemDirectoryHandle | null;
  /** The local path label stored in workspace metadata (displayed in TopBar). */
  localPathLabel: string | null;
  /**
   * True when a stored FS handle was found but permission could not be granted
   * automatically (requires a user-gesture click to call grantFsAccess).
   */
  needsFsPermission: boolean;
  /**
   * Positive, transport-agnostic signal: true once local file access is live —
   * either the daemon reconnected (`openAgentRoot` succeeded, works over HTTP)
   * OR a browser FS handle was granted. Unlike `needsFsPermission` (FS-API only),
   * this is reliable for daemon-backed workspaces too, so the chat can decide
   * whether it needs to prompt for access before running file tools.
   */
  fileAccessReady: boolean;
  /**
   * True when the daemon IS connected but the workspace's stored absolute path
   * doesn't exist on THIS machine — e.g. the workspace was created on another
   * computer by the same user. "Grant Access" can't help (it retries the same
   * missing path); the fix is relinkFolder(), which binds a folder that exists
   * here. The binding is per-machine (this browser's IndexedDB record), so the
   * original machine keeps its own path.
   */
  needsRelink: boolean;
  /**
   * Pick a folder on THIS machine (native OS dialog via the daemon) and rebind
   * the workspace to it: registers the root, rescans the tree, and persists the
   * new path in this machine's local record. Returns true on success (false on
   * cancel / daemon unreachable).
   */
  relinkFolder: () => Promise<boolean>;
  /**
   * Re-requests FS permission from the stored handle.  Must be called from a
   * user-gesture context (button click) so the browser shows the allow dialog.
   * On success, caches the handle and rescans the directory.
   * Returns `true` when access became live (used by the in-chat grant flow to
   * decide whether to auto-continue the pending message).
   *
   * `skipPicker: true` makes the call non-interactive-safe (used by the Send
   * gesture in ChatDock): it never opens the folder picker, and after one
   * declined browser prompt it stops re-prompting for the session (the daemon
   * is still retried every call, so starting it mid-session self-heals).
   */
  grantFsAccess: (opts?: { skipPicker?: boolean }) => Promise<boolean>;
  /**
   * Re-scans the linked local folder and replaces the cached file tree.
   * Returns null when no folder handle is available or permission is denied.
   */
  syncLocalFolder: () => Promise<{ fileCount: number } | null>;
  /**
   * Re-reads local workspace metadata from IDB and picks up any newly-cached
   * FS handle.  Call this after saving settings in an in-IDE modal so the
   * TopBar updates without a page reload.
   */
  refreshLocalMeta: () => Promise<void>;
  /**
   * Monotonically increasing counter — bumped any time the IDB node tree is
   * replaced (initial scan, grantFsAccess, link-folder in settings).
   * Components that display the file tree should include this in their effect
   * dependency arrays so they re-read IDB automatically.
   */
  treeRevision: number;
  /**
   * Explicitly signal that the IDB node tree has changed.  Call this from any
   * component that writes to the `nodes` store outside of WorkspaceProvider
   * (e.g. WorkspaceSettingsModal after picking a new folder).
   */
  bumpTreeRevision: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}

/* ========================================================================== *
 *  WorkspaceProvider
 * ========================================================================== */
export function WorkspaceProvider({
  children,
  workspaceId,
}: {
  children: React.ReactNode;
  workspaceId: number | null;
}) {
  const [workspaceName,  setWorkspaceName]  = useState<string>("");
  const [activeSession,  setActiveSession]  = useState<WsSession | null>(null);
  const [sessions,       setSessions]       = useState<WsSession[]>([]);
  const [syncStatus,     setSyncStatus]     = useState<SyncStatus>("idle");
  const [loading,        setLoading]        = useState(true);
  const [fsHandle,          setFsHandle]          = useState<FileSystemDirectoryHandle | null>(null);
  const [localPathLabel,    setLocalPathLabel]    = useState<string | null>(null);
  const [needsFsPermission, setNeedsFsPermission] = useState(false);
  const [fileAccessReady,   setFileAccessReady]   = useState(false);
  const [needsRelink,       setNeedsRelink]       = useState(false);
  const [pendingHandle,     setPendingHandle]     = useState<FileSystemDirectoryHandle | null>(null);
  const [treeRevision,      setTreeRevision]      = useState(0);
  const bumpTreeRevision = useCallback(() => setTreeRevision((n) => n + 1), []);
  /* Session latch: a skipPicker (auto) grant whose browser prompt the user
     declined must not re-prompt on every subsequent Send. Reset on workspace
     change and on any successful grant. */
  const autoGrantDeclinedRef = useRef(false);

  /* ── Initial load effect ─────────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    if (workspaceId == null) { setLoading(false); return; }

    setLoading(true);
    setSyncStatus("syncing");
    setFsHandle(null);
    setLocalPathLabel(null);
    setFileAccessReady(false);
    setNeedsRelink(false);
    autoGrantDeclinedRef.current = false;

    /* ── LOCAL workspace ───────────────────────────────────────────────── */
    if (isLocalWorkspaceId(workspaceId)) {
      (async () => {
        try {
          const local = await getLocalWorkspace(workspaceId);
          let name = local?.name ?? "";
          let localPath = local?.localPathLabel ?? null;
          if (!local) {
            const remote = await getWorkspace(workspaceId).catch(() => null);
            if (remote) {
              name = remote.name;
              localPath = remote.local_fs_path ?? null;
              await createLocalWorkspace(
                {
                  name: remote.name,
                  description: remote.description ?? undefined,
                  localPathLabel: remote.local_fs_path ?? undefined,
                  fileCount: 0,
                },
                workspaceId,
              ).catch(() => {});
            }
          }
          if (!cancelled) {
            setWorkspaceName(name || `Workspace ${workspaceId}`);
            setLocalPathLabel(localPath);
            setSessions([]);
            setActiveSession(null);
          }

          // Persist as the last-opened workspace so the landing page can offer
          // to resume it on the next app startup / refresh (AC: workspace
          // persistence — "last opened workspace is recoverable"). Local
          // workspaces have no server session, so sessionId is null.
          await setLastActive(workspaceId, null).catch(() => {});

          // Daemon-first reconnect: prefer the local daemon whenever it's
          // connected (works over HTTP AND in Chrome on HTTPS/localhost), using
          // the workspace's absolute path. Only fall back to the browser FS-API
          // handle when no daemon reconnected — this also avoids a spurious
          // "grant filesystem access" prompt for daemon-backed workspaces.
          let reconnectedViaAgent = false;
          let daemonSawPathFail = false;
          if (!cancelled && localPath && /^([A-Za-z]:[\\/]|\/|\\\\)/.test(localPath)) {
            // The daemon may still be starting when the page loads, so a single
            // ~400 ms probe can miss it and needlessly force a manual "Grant
            // Access". Retry a few times with a short backoff before giving up so
            // the common case reconnects silently (zero clicks).
            for (let attempt = 0; attempt < 3 && !cancelled && !reconnectedViaAgent; attempt++) {
              let daemonUp = false;
              try {
                if (await agentClient.isAgentAvailable()) {
                  daemonUp = true;
                  const fa = await openAgentRoot(localPath);
                  setWorkspaceFileAccess(workspaceId, fa);
                  const nodes = await fa.scan();
                  if (!cancelled) {
                    await replaceNodes(workspaceId, nodes).catch(() => {});
                    setTreeRevision((n) => n + 1);
                    setFileAccessReady(true);
                    setNeedsFsPermission(false);
                  }
                  reconnectedViaAgent = true;
                }
              } catch {
                // Daemon up but the stored path can't be opened → the folder
                // doesn't exist on THIS machine (workspace created elsewhere).
                // Remember it so the UI offers "locate folder" instead of a
                // futile "Grant Access". Daemon down → plain retry.
                if (daemonUp) daemonSawPathFail = true;
              }
              if (!reconnectedViaAgent && attempt < 2) {
                await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
                await agentClient.discover(true).catch(() => null); // force a fresh probe next loop
              }
            }
          }
          if (!cancelled && daemonSawPathFail && !reconnectedViaAgent) setNeedsRelink(true);

          // Fall back to the browser File System Access handle only when the
          // daemon didn't handle it.
          if (!cancelled && !reconnectedViaAgent && isFsApiAvailable()) {
            const handle = await getDirectoryHandle(workspaceId).catch(() => null);
            if (handle && !cancelled) {
              const ok = await requestPermission(handle);
              if (ok && !cancelled) {
                setFsHandle(handle);
                setNeedsFsPermission(false);
                setFileAccessReady(true);
                cacheHandle(workspaceId, handle);
                // Replace IDB node tree so deleted files don't linger
                const nodes = await scanDirectory(handle);
                if (!cancelled) {
                  await replaceNodes(workspaceId, nodes).catch(() => {});
                  setTreeRevision((n) => n + 1);
                }
              } else if (!cancelled) {
                // Auto-grant failed; require a user-gesture click via grantFsAccess
                setPendingHandle(handle);
                setNeedsFsPermission(true);
              }
            } else if (!cancelled) {
              setNeedsFsPermission(true);
            }
          }

          if (!cancelled) setSyncStatus("idle");
        } catch {
          if (!cancelled) setWorkspaceName(`Workspace ${workspaceId}`);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }

    /* ── SERVER workspace ──────────────────────────────────────────────── */
    (async () => {
      try {
        const ws = await getWorkspace(workspaceId);
        if (!cancelled) setWorkspaceName(ws.name ?? `Workspace ${workspaceId}`);
      } catch {
        if (!cancelled) setWorkspaceName(`Workspace ${workspaceId}`);
      }
      try {
        const [tree, sess, active] = await Promise.all([
          fetchWorkspaceTree(workspaceId),
          fetchSessions(workspaceId),
          fetchActiveSession(workspaceId),
        ]);
        if (tree.length) await putNodes(workspaceId, tree).catch(() => {});
        const merged = active
          ? sess.map((s) => ({ ...s, isActive: s.id === active.id }))
          : sess;
        if (merged.length) await putSessions(workspaceId, merged).catch(() => {});
        if (!cancelled) {
          setSessions(merged);
          setActiveSession(active ?? merged[0] ?? null);
          setSyncStatus("synced");
        }
        await setLastActive(workspaceId, active?.id ?? null).catch(() => {});
      } catch {
        if (!cancelled) setSyncStatus("error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  /* ── relinkFolder — bind the workspace to a folder on THIS machine ───── */
  const relinkFolder = useCallback(async (): Promise<boolean> => {
    if (workspaceId == null) return false;
    try {
      if (!(await agentClient.discover(true))) return false;
      // Native OS folder dialog on the user's machine (via the daemon).
      const picked = await agentClient.pickFolder();
      if (!picked) return false; // canceled / picker unavailable
      const fa = await openAgentRoot(picked);
      setWorkspaceFileAccess(workspaceId, fa);
      const nodes = await fa.scan();
      await replaceNodes(workspaceId, nodes).catch(() => {});
      setTreeRevision((n) => n + 1);
      setLocalPathLabel(picked);
      setNeedsRelink(false);
      setNeedsFsPermission(false);
      setFileAccessReady(true);
      autoGrantDeclinedRef.current = false;
      // Persist the new path in THIS machine's local record only — the machine
      // the workspace was created on keeps its own binding (server metadata is
      // untouched, so nothing breaks there).
      //
      // A MISSING record is created rather than skipped. Persisting only when
      // one already existed is why picking a folder felt like it never stuck:
      // a server-created workspace opened on a second machine has no local
      // record, so the path was dropped on every reload and the user had to
      // pick the same folder again — the "open via daemon is manual" defect.
      // The path is what the mount effect reconnects from, so if it isn't
      // stored, nothing can be automatic.
      const local = await getLocalWorkspace(workspaceId).catch(() => null);
      await updateLocalWorkspace(
        local
          ? { ...local, localPathLabel: picked }
          : {
              id: workspaceId,
              name: workspaceName ?? picked.split(/[\\/]/).pop() ?? "Workspace",
              localPathLabel: picked,
              createdAt: Date.now(),
              fileCount: 0,
            },
      ).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }, [workspaceId, workspaceName]);

  /* ── grantFsAccess — must be called from a user-gesture handler ─────── */
  const grantFsAccess = useCallback(async (opts?: { skipPicker?: boolean }): Promise<boolean> => {
    if (workspaceId == null) return false;
    // Guard with `=== true`: the FILES-banner wires this directly as an
    // onClick handler, so the first argument can be a MouseEvent.
    const skipPicker = opts?.skipPicker === true;

    // Daemon-first: on plain HTTP the browser File System Access API doesn't
    // exist (pickDirectory throws), so "Grant Access" would do nothing. If the
    // local daemon is running and the workspace has an absolute path, reconnect
    // through the daemon instead — that's the transport for HTTP deployments.
    const path = localPathLabel?.replace(/^["']+|["']+$/g, "").trim();
    if (path && /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path)) {
      try {
        // force=true: the user clicked expecting the just-started daemon to be
        // found, so bypass the negative-probe cache.
        if (await agentClient.discover(true)) {
          const fa = await openAgentRoot(path);
          setWorkspaceFileAccess(workspaceId, fa);
          setNeedsFsPermission(false);
          setFileAccessReady(true);
          const nodes = await fa.scan();
          await replaceNodes(workspaceId, nodes).catch(() => {});
          setTreeRevision((n) => n + 1);
          autoGrantDeclinedRef.current = false;
          return true;
        }
      } catch {
        // Daemon unreachable or path not on this machine — fall through to the
        // browser FS API (HTTPS/localhost) below.
      }
    }

    // Auto (Send-gesture) grants stop prompting after one decline this session
    // — the daemon attempt above still ran, so it can self-heal silently.
    if (skipPicker && autoGrantDeclinedRef.current) return false;

    // Browser File System Access API fallback (HTTPS/localhost only).
    let handle = pendingHandle;
    if (!handle) handle = await getDirectoryHandle(workspaceId).catch(() => null);
    if (!handle && !skipPicker) handle = await pickDirectory().catch(() => null);
    if (!handle) return false;
    const ok = await requestPermission(handle);
    if (ok) {
      setFsHandle(handle);
      setNeedsFsPermission(false);
      setFileAccessReady(true);
      setPendingHandle(null);
      cacheHandle(workspaceId, handle);
      await storeDirectoryHandle(workspaceId, handle).catch(() => {});
      const nodes = await scanDirectory(handle);
      await replaceNodes(workspaceId, nodes).catch(() => {});
      setTreeRevision((n) => n + 1);
      autoGrantDeclinedRef.current = false;
      return true;
    }
    if (skipPicker) autoGrantDeclinedRef.current = true;
    return false;
  }, [workspaceId, pendingHandle, localPathLabel]);

  const syncLocalFolder = useCallback(async () => {
    if (workspaceId == null || !isLocalWorkspaceId(workspaceId)) return null;
    setSyncStatus("syncing");

    // Already-bound access wins. Re-scanning through the transport that is
    // ALREADY connected is what "sync" means here — going back to the browser
    // handle first is what made every click re-prompt for permission.
    const bound = resolveWorkspaceFileAccess(workspaceId);
    if (bound) {
      try {
        const nodes = await bound.scan();
        await replaceNodes(workspaceId, nodes).catch(() => {});
        setTreeRevision((n) => n + 1);
        setSyncStatus("synced");
        return { fileCount: nodes.filter((node) => node.type === "file").length };
      } catch {
        // Transport went away (daemon stopped, handle revoked) — fall through
        // and try to re-establish it below.
      }
    }

    // Daemon transport, same ladder as grantFsAccess. Without this branch,
    // sync was browser-FS-API-only: on plain HTTP that API doesn't exist, so
    // the handle lookup always failed and every click showed the permission
    // banner for access the user had already granted through the daemon.
    const path = localPathLabel?.replace(/^["']+|["']+$/g, "").trim();
    if (path && /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path)) {
      try {
        if (await agentClient.discover(true)) {
          const fa = await openAgentRoot(path);
          setWorkspaceFileAccess(workspaceId, fa);
          setNeedsFsPermission(false);
          setFileAccessReady(true);
          const nodes = await fa.scan();
          await replaceNodes(workspaceId, nodes).catch(() => {});
          setTreeRevision((n) => n + 1);
          setSyncStatus("synced");
          return { fileCount: nodes.filter((node) => node.type === "file").length };
        }
      } catch {
        // Daemon unreachable or the path isn't on this machine — the browser
        // FS API below is the other way in.
      }
    }

    let handle = fsHandle ?? getCachedHandle(workspaceId);
    if (!handle) handle = await getDirectoryHandle(workspaceId).catch(() => null);
    if (!handle) {
      setNeedsFsPermission(true);
      setSyncStatus("error");
      return null;
    }

    const ok = await requestPermission(handle);
    if (!ok) {
      setPendingHandle(handle);
      setNeedsFsPermission(true);
      setSyncStatus("error");
      return null;
    }

    setFsHandle(handle);
    setPendingHandle(null);
    setNeedsFsPermission(false);
    setFileAccessReady(true);
    autoGrantDeclinedRef.current = false;
    cacheHandle(workspaceId, handle);
    await storeDirectoryHandle(workspaceId, handle).catch(() => {});
    const nodes = await scanDirectory(handle);
    await replaceNodes(workspaceId, nodes).catch(() => {});
    setTreeRevision((n) => n + 1);
    setSyncStatus("synced");
    return { fileCount: nodes.filter((node) => node.type === "file").length };
  }, [workspaceId, fsHandle, localPathLabel]);

  /* ── refreshLocalMeta — called by in-IDE settings modal after save ───── */
  const refreshLocalMeta = useCallback(async () => {
    if (workspaceId == null || !isLocalWorkspaceId(workspaceId)) return;
    try {
      const local = await getLocalWorkspace(workspaceId);
      if (local) {
        setWorkspaceName(local.name ?? `Workspace ${workspaceId}`);
        setLocalPathLabel(local.localPathLabel ?? null);
      }
      // Pick up a handle that was newly cached by the settings modal
      const cached = getCachedHandle(workspaceId);
      if (cached) { setFsHandle(cached); setFileAccessReady(true); }
    } catch { /* silent — stale state is acceptable */ }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId == null || !fsHandle) return;
    const syncFocusedFolder = () => {
      scanDirectory(fsHandle)
        .then((nodes) => replaceNodes(workspaceId, nodes))
        .then(() => setTreeRevision((n) => n + 1))
        .catch(() => {});
    };
    window.addEventListener("focus", syncFocusedFolder);
    return () => window.removeEventListener("focus", syncFocusedFolder);
  }, [workspaceId, fsHandle]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceId, workspaceName, activeSession, sessions,
      syncStatus, loading, fsHandle, localPathLabel,
      needsFsPermission, fileAccessReady, needsRelink, relinkFolder,
      grantFsAccess, syncLocalFolder, refreshLocalMeta,
      treeRevision, bumpTreeRevision,
    }),
    [workspaceId, workspaceName, activeSession, sessions, syncStatus, loading, fsHandle, localPathLabel, needsFsPermission, fileAccessReady, needsRelink, relinkFolder, grantFsAccess, syncLocalFolder, refreshLocalMeta, treeRevision, bumpTreeRevision],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
