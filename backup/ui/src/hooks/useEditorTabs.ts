"use client";

/**
 * useEditorTabs — open-file/tab state for the IDE, persisted in IndexedDB so
 * tabs survive reload and workspace switch (AC6).
 *
 * Reads content from IndexedDB first (instant), falls back to the server. Edits
 * are optimistic + marked dirty; saving writes to IndexedDB and enqueues an
 * outbox op (server push lands in P6 sync). ISOLATION: new file.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getTabs,
  putTab,
  removeTab,
  getFile,
  putFile,
  enqueueOutbox,
  getPref,
  setPref,
  type WsTab,
} from "@/lib/db/workspaceStore";
import { fetchFileContent, saveFileContent } from "@/lib/workspace-api";
import { fetchRecoveryState } from "@/lib/workspace-sync-api";
import { useToast } from "@/hooks/useToast";

const DEFAULT_MAX_TABS = 15;
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/* ========================================================================== *
 *  Types
 * ========================================================================== */
export interface OpenFile {
  path: string;
  content: string;
  lang: string;
  dirty: boolean;
}

/* ========================================================================== *
 *  Language inference (file extension → Monaco language id)
 * ========================================================================== */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", java: "java", cs: "csharp", go: "go", rs: "rust", rb: "ruby",
  php: "php", json: "json", yml: "yaml", yaml: "yaml", md: "markdown",
  html: "html", css: "css", scss: "scss", sql: "sql", sh: "shell",
  xml: "xml", txt: "plaintext",
};
const langOf = (path: string): string =>
  EXT_LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

/* ========================================================================== *
 *  useEditorTabs — open-file / tab state (IndexedDB-backed, AC6)
 * ========================================================================== */
export function useEditorTabs(workspaceId: number | null) {
  // ── State ────────────────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<WsTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, OpenFile>>({});
  // Tracks which paths are already in `files` — avoids redundant IDB/server reads.
  const loadedPaths = useRef(new Set<string>());
  const { toast } = useToast();

  // Always-fresh snapshot of `tabs`, read synchronously by openFile's limit check.
  const tabsRef = useRef<WsTab[]>([]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // ── Max open tabs (configurable per workspace, Settings panel) ────────────
  const [maxTabs, setMaxTabsState] = useState(DEFAULT_MAX_TABS);
  const [autoCloseOldest, setAutoCloseOldestState] = useState(true);

  useEffect(() => {
    if (workspaceId == null) return;
    getPref<number>(workspaceId, "maxTabs").then((v) => { if (v != null) setMaxTabsState(v); }).catch(() => {});
    getPref<boolean>(workspaceId, "autoCloseOldestTab").then((v) => { if (v != null) setAutoCloseOldestState(v); }).catch(() => {});
  }, [workspaceId]);

  const setMaxTabs = useCallback(
    (n: number) => {
      setMaxTabsState(n);
      if (workspaceId != null) void setPref(workspaceId, "maxTabs", n).catch(() => {});
    },
    [workspaceId],
  );

  const setAutoCloseOldest = useCallback(
    (v: boolean) => {
      setAutoCloseOldestState(v);
      if (workspaceId != null) void setPref(workspaceId, "autoCloseOldestTab", v).catch(() => {});
    },
    [workspaceId],
  );

  // ── Restore persisted tabs on workspace load (AC6) ────────────────────────
  useEffect(() => {
    if (workspaceId == null) return;
    let cancelled = false;
    getTabs(workspaceId)
      .then(async (saved) => {
        if (cancelled) return;

        if (saved.length > 0) {
          setTabs(saved);
          const active = saved.find((t) => t.active) ?? saved[0];
          setActivePath(active.path);
          await ensureContent(workspaceId, active.path);
          return;
        }

        // IndexedDB has no tabs (fresh device / cache wipe / stale) → rehydrate
        // the open-tabs + active file from the server recovery snapshot.
        const remote = await fetchRecoveryState(workspaceId);
        if (cancelled || !remote?.open_tabs?.length) return;

        const activeFromServer = remote.active_files?.[0];
        const restored: WsTab[] = remote.open_tabs
          .filter((t) => t && typeof t.path === "string")
          .map((t, i) => ({
            path: t.path,
            order: typeof t.order === "number" ? t.order : i,
            active: activeFromServer ? t.path === activeFromServer : !!t.active,
          }));
        if (restored.length === 0) return;
        if (!restored.some((t) => t.active)) restored[0].active = true;

        setTabs(restored);
        await Promise.all(restored.map((t) => putTab(workspaceId, t))).catch(() => {});
        const active = restored.find((t) => t.active) ?? restored[0];
        setActivePath(active.path);
        await ensureContent(workspaceId, active.path);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const ensureContent = useCallback(
    async (wid: number, path: string) => {
      // Skip if already loaded — avoids redundant IDB reads on every tab click.
      if (loadedPaths.current.has(path)) return;
      loadedPaths.current.add(path);
      const cached = await getFile(wid, path).catch(() => null);
      if (cached) {
        setFiles((prev) => ({
          ...prev,
          [path]: { path, content: cached.content, lang: cached.lang ?? langOf(path), dirty: !!cached.dirty },
        }));
        return;
      }
      try {
        const { content, lang } = await fetchFileContent(wid, path);
        await putFile(wid, { path, content, lang: lang ?? langOf(path), dirty: false, updatedAt: Date.now() });
        setFiles((prev) => ({ ...prev, [path]: { path, content, lang: lang ?? langOf(path), dirty: false } }));
      } catch {
        loadedPaths.current.delete(path); // allow retry on next open
        setFiles((prev) => ({
          ...prev,
          [path]: { path, content: "// Failed to load file.", lang: langOf(path), dirty: false },
        }));
      }
    },
    [],
  );

  const persistTabs = useCallback(
    async (wid: number, next: WsTab[]) => {
      await Promise.all(next.map((t) => putTab(wid, t))).catch(() => {});
    },
    [],
  );

  // ── Tab operations: open / activate / close ──────────────────────────────
  const openFile = useCallback(
    async (path: string) => {
      if (workspaceId == null) return;
      const current = tabsRef.current;
      const exists = current.some((t) => t.path === path);
      let base = current;

      if (!exists && current.length >= maxTabs) {
        if (!autoCloseOldest) {
          toast("error", `Maximum ${maxTabs} tabs reached. Close a tab before opening another.`);
          return;
        }
        const oldest =
          [...current].sort((a, b) => a.order - b.order).find((t) => t.path !== activePath) ?? current[0];
        loadedPaths.current.delete(oldest.path);
        setFiles((prev) => {
          const { [oldest.path]: _drop, ...rest } = prev;
          return rest;
        });
        void removeTab(workspaceId, oldest.path).catch(() => {});
        toast("info", `Closed "${baseName(oldest.path)}" — maximum ${maxTabs} tabs reached.`);
        base = current.filter((t) => t.path !== oldest.path);
      }

      setActivePath(path);
      const next = (exists ? base : [...base, { path, order: base.length }]).map((t) => ({
        ...t,
        active: t.path === path,
      }));
      tabsRef.current = next;
      setTabs(next);
      void persistTabs(workspaceId, next);
      await ensureContent(workspaceId, path);
    },
    [workspaceId, ensureContent, persistTabs, maxTabs, autoCloseOldest, activePath, toast],
  );

  const setActive = useCallback(
    async (path: string) => {
      if (workspaceId == null) return;
      setActivePath(path);
      setTabs((prev) => {
        const next = prev.map((t) => ({ ...t, active: t.path === path }));
        void persistTabs(workspaceId, next);
        return next;
      });
      await ensureContent(workspaceId, path);
    },
    [workspaceId, ensureContent, persistTabs],
  );

  const closeTab = useCallback(
    (path: string) => {
      if (workspaceId == null) return;
      // Evict cached content — keeps memory bounded and forces a fresh load on re-open.
      loadedPaths.current.delete(path);
      setFiles((prev) => {
        const { [path]: _, ...rest } = prev;
        return rest;
      });
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const next = prev.filter((t) => t.path !== path).map((t, i) => ({ ...t, order: i }));
        void removeTab(workspaceId, path).catch(() => {});
        if (activePath === path) {
          const neighbor = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
          const nextActive = neighbor?.path ?? null;
          setActivePath(nextActive);
          if (nextActive) void ensureContent(workspaceId, nextActive);
          return next.map((t) => ({ ...t, active: t.path === nextActive }));
        }
        return next;
      });
    },
    [workspaceId, activePath, ensureContent],
  );

  // ── Editing & save (optimistic local write + outbox for server push) ──────
  const updateContent = useCallback((path: string, content: string) => {
    setFiles((prev) => ({ ...prev, [path]: { ...prev[path], path, content, dirty: true } }));
  }, []);

  const saveActive = useCallback(async () => {
    if (workspaceId == null || !activePath) return;
    const f = files[activePath];
    if (!f) return;
    // saveFileContent writes to the live FS (if handle available) and mirrors to IDB
    await saveFileContent(workspaceId, activePath, f.content).catch(() => {});
    await enqueueOutbox(workspaceId, { op: "update", path: activePath, payload: { content: f.content } }).catch(() => {});
    setFiles((prev) => ({ ...prev, [activePath]: { ...prev[activePath], dirty: false } }));
  }, [workspaceId, activePath, files]);

  // Rename a single open tab (after file rename).
  const renameTab = useCallback(
    (oldPath: string, newPath: string) => {
      if (workspaceId == null) return;
      setFiles((prev) => {
        if (!prev[oldPath]) return prev;
        const { [oldPath]: f, ...rest } = prev;
        return { ...rest, [newPath]: { ...f, path: newPath } };
      });
      setActivePath((prev) => (prev === oldPath ? newPath : prev));
      setTabs((prev) => {
        const next = prev.map((t) => (t.path === oldPath ? { ...t, path: newPath } : t));
        void removeTab(workspaceId, oldPath).catch(() => {});
        void Promise.all(next.filter((t) => t.path === newPath).map((t) => putTab(workspaceId, t))).catch(() => {});
        return next;
      });
    },
    [workspaceId],
  );

  // Rename all open tabs under a folder prefix (after folder rename).
  const renamePrefixTabs = useCallback(
    (oldPrefix: string, newPrefix: string) => {
      if (workspaceId == null) return;
      const remap = (p: string): string =>
        p === oldPrefix ? newPrefix :
        p.startsWith(oldPrefix + "/") ? newPrefix + p.slice(oldPrefix.length) : p;
      setFiles((prev) => {
        const next: Record<string, OpenFile> = {};
        for (const [k, v] of Object.entries(prev)) {
          const nk = remap(k);
          next[nk] = { ...v, path: nk };
        }
        return next;
      });
      setActivePath((prev) => (prev ? remap(prev) : prev));
      setTabs((prev) => {
        const next = prev.map((t) => ({ ...t, path: remap(t.path) }));
        void Promise.all(prev.map((t) => removeTab(workspaceId, t.path).catch(() => {}))).then(
          () => Promise.all(next.map((t) => putTab(workspaceId, t))).catch(() => {}),
        );
        return next;
      });
    },
    [workspaceId],
  );

  // Close all open tabs whose paths are at or under a folder prefix (folder delete).
  const closeTabsUnder = useCallback(
    (prefix: string) => {
      if (workspaceId == null) return;
      const isUnder = (p: string) => p === prefix || p.startsWith(prefix + "/");

      setFiles((prev) => {
        const next: Record<string, OpenFile> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (isUnder(k)) {
            loadedPaths.current.delete(k);
          } else {
            next[k] = v;
          }
        }
        return next;
      });

      setTabs((prev) => {
        const toRemove = prev.filter((t) => isUnder(t.path));
        const next = prev
          .filter((t) => !isUnder(t.path))
          .map((t, i) => ({ ...t, order: i }));
        toRemove.forEach((t) => void removeTab(workspaceId, t.path).catch(() => {}));

        if (activePath && isUnder(activePath)) {
          const nextActive = next[0]?.path ?? null;
          setActivePath(nextActive);
          if (nextActive) void ensureContent(workspaceId, nextActive);
          return next.map((t) => ({ ...t, active: t.path === nextActive }));
        }
        return next;
      });
    },
    [workspaceId, activePath, ensureContent],
  );

  /** Close every tab except `path`. */
  const closeOthers = useCallback(
    (path: string) => {
      if (workspaceId == null) return;
      setFiles((prev) => {
        const next: Record<string, OpenFile> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k === path) next[k] = v;
          else loadedPaths.current.delete(k);
        }
        return next;
      });
      setTabs((prev) => {
        const toRemove = prev.filter((t) => t.path !== path);
        toRemove.forEach((t) => void removeTab(workspaceId, t.path).catch(() => {}));
        const next = prev
          .filter((t) => t.path === path)
          .map((t, i) => ({ ...t, order: i, active: true }));
        setActivePath(path);
        void ensureContent(workspaceId, path);
        return next;
      });
    },
    [workspaceId, ensureContent],
  );

  /** Close every open tab. */
  const closeAll = useCallback(() => {
    if (workspaceId == null) return;
    setTabs((prev) => {
      prev.forEach((t) => void removeTab(workspaceId, t.path).catch(() => {}));
      return [];
    });
    setFiles({});
    loadedPaths.current.clear();
    setActivePath(null);
  }, [workspaceId]);

  const dirtyPaths = new Set(
    Object.values(files).filter((f) => f.dirty).map((f) => f.path),
  );

  /** Load content for a path without changing the active tab (used by split pane). */
  const loadFile = useCallback(
    async (path: string) => {
      if (workspaceId == null) return;
      await ensureContent(workspaceId, path);
    },
    [workspaceId, ensureContent],
  );

  /** Save any open file by path without requiring it to be the active tab. */
  const saveFile = useCallback(
    async (path: string) => {
      if (workspaceId == null) return;
      const f = files[path];
      if (!f) return;
      await saveFileContent(workspaceId, path, f.content).catch(() => {});
      await enqueueOutbox(workspaceId, { op: "update", path, payload: { content: f.content } }).catch(() => {});
      setFiles((prev) => ({ ...prev, [path]: { ...prev[path], dirty: false } }));
    },
    [workspaceId, files],
  );

  /** Persist cursor/scroll position for a tab (debounced caller in EditorPane). */
  const updateTabViewState = useCallback(
    (path: string, viewState: { cursor?: { line: number; column: number }; scrollTop?: number }) => {
      if (workspaceId == null) return;
      setTabs((prev) => {
        const next = prev.map((t) => (t.path === path ? { ...t, ...viewState } : t));
        const tab = next.find((t) => t.path === path);
        if (tab) void putTab(workspaceId, tab).catch(() => {});
        return next;
      });
    },
    [workspaceId],
  );

  /** Reorder tabs by moving fromPath before or after targetPath. */
  const reorderTabs = useCallback(
    (fromPath: string, targetPath: string, side: "before" | "after") => {
      if (fromPath === targetPath) return;
      setTabs((prev) => {
        const from = prev.find((t) => t.path === fromPath);
        if (!from) return prev;
        const filtered = prev.filter((t) => t.path !== fromPath);
        const targetIdx = filtered.findIndex((t) => t.path === targetPath);
        if (targetIdx === -1) return prev;
        const insertAt = side === "before" ? targetIdx : targetIdx + 1;
        const next = [
          ...filtered.slice(0, insertAt),
          from,
          ...filtered.slice(insertAt),
        ].map((t, i) => ({ ...t, order: i }));
        if (workspaceId != null) void persistTabs(workspaceId, next).catch(() => {});
        return next;
      });
    },
    [workspaceId, persistTabs],
  );

  return {
    tabs,
    activePath,
    activeFile: activePath ? files[activePath] ?? null : null,
    /** All loaded file contents keyed by path — used by the split-pane editor. */
    files,
    dirtyPaths,
    openFile,
    setActive,
    closeTab,
    closeOthers,
    closeAll,
    closeTabsUnder,
    updateContent,
    saveActive,
    loadFile,
    saveFile,
    updateTabViewState,
    reorderTabs,
    renameTab,
    renamePrefixTabs,
    maxTabs,
    setMaxTabs,
    autoCloseOldest,
    setAutoCloseOldest,
  };
}