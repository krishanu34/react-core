"use client";

/**
 * Workspace IDE route — full-screen VS Code-style layout (Code Studio).
 *
 * Fixes in this version:
 *  - Breadcrumb receives workspaceId + onOpenFile → click-to-navigate
 *  - Split editor (Ctrl+\): two Monaco panes side by side, independent active files
 *  - SCM / Extensions / Runs / Settings panels now render real placeholder UI
 *  - Rename InlineInput shows visible error on empty name (in ExplorerTree)
 *  - Responsive: Explorer hidden by default on < 640 px; Chat hidden on < 1024 px
 *  - Panel initial widths capped to viewport fraction so Zoom 200% doesn't overflow
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Files,
  FolderOpen,
  GitBranch,
  History,
  MessageSquare,
  PanelLeftOpen,
  Puzzle,
  Search,
  Settings2,
  SquareSplitHorizontal,
  Trash2,
} from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "@/providers/WorkspaceProvider";
import { ProjectProvider } from "@/providers/ProjectProvider";
import { ToastProvider } from "@/hooks/useToast";
import { ActivityBar, type ActivityView } from "@/components/ide/ActivityBar";
import { PanelFrame } from "@/components/ide/PanelFrame";
import { StatusBar } from "@/components/ide/StatusBar";
import { TopBar } from "@/components/ide/TopBar";
import { ResizeHandle } from "@/components/ide/ResizeHandle";
import { ExplorerTree } from "@/components/ide/ExplorerTree";
import { McpServersPanel } from "@/components/ide/McpServersPanel";
import { Breadcrumb } from "@/components/ide/Breadcrumb";
import { EditorTabs } from "@/components/ide/EditorTabs";
import { EditorPane } from "@/components/ide/EditorPane";
import { ChatDock } from "@/components/ide/ChatDock";
import { SearchView } from "@/components/ide/SearchView";
import { TrashView } from "@/components/ide/TrashView";
import { SourceConnectorPanel } from "@/components/ide/SourceConnectorPanel";
import { AllContextPanel } from "@/components/ide/AllContextPanel";
import { SourceControlView } from "@/components/ide/SourceControlView";
import { ProjectsPanel } from "@/components/ide/ProjectsPanel";
import { QuickAccess } from "@/components/ide/QuickAccess";
import { Sidebar } from "@/components/story-builder/sidebar";
import { useEditorTabs } from "@/hooks/useEditorTabs";
import { useSyncEngine } from "@/hooks/useSyncEngine";
import { fetchRecoveryState } from "@/lib/workspace-sync-api";
import { getPref, setPref, isLocalWorkspaceId } from "@/lib/db/workspaceStore";
import { ideThemeVars } from "@/lib/design-tokens";
import { toggleTheme, useTheme } from "@/lib/theme";
import { canAccessWorkspaceStudio } from "@/lib/workspace-rbac";

interface SavedLayout {
  showExplorer?: boolean;
  explorerCollapsed?: boolean;
  showChat?: boolean;
  isMaximized?: boolean;
  explorerW?: number;
  chatW?: number;
  view?: ActivityView;
  isSplit?: boolean;
  theme?: "dark" | "light";
}

const VIEW_TITLE: Record<ActivityView, string> = {
  projects:   "Project Artifacts",
  explorer:   "Explorer",
  search:     "Search",
  appnav:     "App Navigation",
  allcontext: "All Context",
  source:     "Workspace Connector",
  mcp:        "MCP Servers",
  scm:        "Source Control",
  extensions: "Extensions",
  runs:       "Runs / History",
  settings:   "Settings",
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Returns viewport width, SSR-safe. */
const vw = () => (typeof window !== "undefined" ? window.innerWidth : 1280);

/* ========================================================================== *
 *  SidebarContent — renders the panel for the active activity-bar view
 * ========================================================================== */
function SidebarContent({
  view,
  workspaceId,
  loading,
  activePath,
  openFile,
  closeTab,
  closeTabsUnder,
  renameTab,
  renamePrefixTabs,
  theme,
  onToggleTheme,
  maxTabs,
  setMaxTabs,
  autoCloseOldest,
  setAutoCloseOldest,
}: {
  view: ActivityView;
  workspaceId: number | null;
  loading: boolean;
  activePath: string | null;
  openFile: (path: string) => void;
  closeTab: (path: string) => void;
  closeTabsUnder: (prefix: string) => void;
  renameTab: (oldPath: string, newPath: string) => void;
  renamePrefixTabs: (oldPath: string, newPath: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  maxTabs: number;
  setMaxTabs: (n: number) => void;
  autoCloseOldest: boolean;
  setAutoCloseOldest: (v: boolean) => void;
}) {
  const {
    workspaceId: wsId, needsFsPermission, fileAccessReady, grantFsAccess,
    needsRelink, relinkFolder, localPathLabel, treeRevision, bumpTreeRevision,
  } = useWorkspace();
  const [showTrash, setShowTrash] = useState(false);
  const [relinking, setRelinking] = useState(false);
  // Show the banner whenever a LOCAL workspace has no live access — covers the
  // daemon (HTTP) case too, where `needsFsPermission` (FS-API only) never fires.
  const showAccessBanner =
    needsFsPermission || (wsId != null && isLocalWorkspaceId(wsId) && !fileAccessReady);

  if (loading)
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--ide-muted)]">
        Loading workspace…
      </div>
    );

  /* ── App Navigation ─────────────────────────────────────────────────────── */
  if (view === "appnav")
    return (
      <Sidebar className="flex h-full w-full flex-col bg-slate-950 overflow-y-auto" />
    );

  if (workspaceId == null)
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--ide-muted)]">
        No workspace in URL.
      </div>
    );

  /* ── Projects ───────────────────────────────────────────────────────────── */
  if (view === "projects")
    return <ProjectsPanel />;

  /* ── Search ─────────────────────────────────────────────────────────────── */
  if (view === "search")
    return <SearchView workspaceId={workspaceId} onOpenFile={openFile} />;

  /* ── All Context ──────────────────────────────────────────────────────── */
  if (view === "allcontext")
    return <AllContextPanel workspaceId={workspaceId} />;

  /* ── Source Connector ──────────────────────────────────────────────────── */
  if (view === "source")
    return <SourceConnectorPanel workspaceId={workspaceId} />;

  /* ── MCP Servers ───────────────────────────────────────────────────────── */
  if (view === "mcp")
    return <McpServersPanel workspaceId={workspaceId} />;

  /* ── Source Control (Git) ──────────────────────────────────────────────── */
  if (view === "scm")
    return <SourceControlView workspaceId={workspaceId} onOpenFile={openFile} />;

  /* ── Explorer ───────────────────────────────────────────────────────────── */
  if (view === "explorer")
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Header: FILES / TRASH toggle */}
        <div className="flex items-center justify-between px-2 py-1 shrink-0">
          <span className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)]">
            {showTrash ? "TRASH" : "FILES"}
          </span>
          <button
            type="button"
            onClick={() => setShowTrash((t) => !t)}
            title={showTrash ? "Back to files" : "Open Trash"}
            className="h-4 w-4 inline-flex items-center justify-center rounded text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
          >
            {showTrash ? (
              <Files className="h-3 w-3" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          </button>
        </div>

        {showTrash ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <TrashView
              workspaceId={workspaceId}
              onRestore={() => {
                setShowTrash(false);
                bumpTreeRevision();
              }}
            />
          </div>
        ) : (
          <>
            {showAccessBanner && (needsRelink ? (
              /* Workspace created on another machine: the stored path doesn't
                 exist here, so "Grant Access" (which retries that same path)
                 can't help — offer to locate the folder on THIS machine. */
              <div className="mx-2 mb-1 rounded-md border border-amber-700/50 bg-amber-950/30 px-2.5 py-2 text-[11px] shrink-0">
                <p className="text-amber-300 font-medium mb-1.5 flex items-center gap-1.5">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  Folder not found on this machine
                </p>
                <p className="text-[var(--ide-muted)] mb-2 leading-relaxed">
                  This workspace is linked to{" "}
                  <span className="text-[var(--ide-text)] break-all">{localPathLabel ?? "a folder"}</span>,
                  which doesn&apos;t exist here — it was probably created on another computer. Pick the
                  folder that holds this project on this machine (e.g. your local clone) to continue.
                </p>
                <button
                  type="button"
                  disabled={relinking}
                  onClick={async () => {
                    setRelinking(true);
                    try { await relinkFolder(); } finally { setRelinking(false); }
                  }}
                  className="w-full h-7 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-[11px] font-medium text-white transition-colors"
                >
                  {relinking ? "Choose the folder in the dialog…" : "Locate Folder on This Machine"}
                </button>
              </div>
            ) : (
              <div className="mx-2 mb-1 rounded-md border border-amber-700/50 bg-amber-950/30 px-2.5 py-2 text-[11px] shrink-0">
                <p className="text-amber-300 font-medium mb-1.5 flex items-center gap-1.5">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  Filesystem access required
                </p>
                <p className="text-[var(--ide-muted)] mb-2 leading-relaxed">
                  Grant read/write access to your local folder to see and edit files.
                </p>
                <button
                  type="button"
                  onClick={() => grantFsAccess()}
                  className="w-full h-7 rounded bg-amber-600 hover:bg-amber-500 text-[11px] font-medium text-white transition-colors"
                >
                  Grant Access
                </button>
              </div>
            ))}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ExplorerTree
                workspaceId={workspaceId}
                activePath={activePath}
                onOpenFile={openFile}
                onCloseFile={closeTab}
                onCloseTabsUnder={closeTabsUnder}
                onRenameFile={renameTab}
                onRenameFolder={renamePrefixTabs}
                externalRevision={treeRevision}
              />
            </div>
          </>
        )}
      </div>
    );

  /* ── Extensions ─────────────────────────────────────────────────────────── */
  if (view === "extensions")
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 py-1.5 border-b border-[var(--ide-border)] shrink-0">
          <div className="flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--ide-surface-2)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-muted)]">
            <Search className="h-3 w-3 shrink-0" />
            <span>Search extensions…</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {(
            [
              { name: "Prettier",     desc: "Opinionated code formatter",     badge: "Popular" },
              { name: "ESLint",       desc: "Pluggable JS/TS linting",        badge: "Popular" },
              { name: "GitLens",      desc: "Git history, blame & insights",  badge: null },
              { name: "Tailwind CSS", desc: "IntelliSense for class names",   badge: null },
            ] as const
          ).map((ext) => (
            <div
              key={ext.name}
              className="flex items-start gap-2 px-2 py-2 opacity-60 cursor-not-allowed"
            >
              <div className="h-8 w-8 rounded bg-[var(--ide-surface-2)] border border-[var(--ide-border)] shrink-0 flex items-center justify-center">
                <Puzzle className="h-4 w-4 text-[var(--ide-muted)]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[12px] text-[var(--ide-text)] truncate">
                    {ext.name}
                  </span>
                  {ext.badge && (
                    <span className="shrink-0 text-[9px] bg-violet-600/40 text-violet-300 px-1 rounded leading-none py-0.5">
                      {ext.badge}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[var(--ide-muted)] truncate mt-0.5">
                  {ext.desc}
                </p>
              </div>
            </div>
          ))}
          <p className="text-center text-[10px] text-[var(--ide-muted)] py-3 opacity-40">
            Extension marketplace coming soon
          </p>
        </div>
      </div>
    );

  /* ── Runs / History ─────────────────────────────────────────────────────── */
  if (view === "runs")
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 py-1.5 border-b border-[var(--ide-border)] shrink-0">
          <span className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase">
            Runs / History
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <div className="h-10 w-10 rounded-full bg-[var(--ide-surface-2)] flex items-center justify-center mx-auto mb-3">
              <History className="h-5 w-5 text-[var(--ide-muted)]" />
            </div>
            <p className="text-[12px] text-[var(--ide-muted)] font-medium">No runs yet</p>
            <p className="text-[11px] text-[var(--ide-muted)] mt-1 opacity-60 leading-relaxed">
              Agent run history from the Chat panel will appear here.
            </p>
          </div>
        </div>
      </div>
    );

  /* ── Settings ───────────────────────────────────────────────────────────── */
  if (view === "settings")
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 py-1.5 border-b border-[var(--ide-border)] shrink-0">
          <span className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase">
            Settings
          </span>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-5">
          {/* Appearance */}
          <div>
            <label className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase block mb-2">
              Appearance
            </label>
            <div className="flex gap-2">
              {(["dark", "light"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={onToggleTheme}
                  className={`flex-1 h-8 rounded border text-[11px] font-medium transition-colors capitalize ${
                    theme === t
                      ? "bg-violet-600/30 border-violet-500 text-violet-300"
                      : "bg-[var(--ide-surface-2)] border-[var(--ide-border)] text-[var(--ide-muted)] hover:border-[var(--ide-muted)]"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Keyboard shortcuts */}
          <div>
            <label className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase block mb-2">
              Keyboard Shortcuts
            </label>
            <div className="space-y-1.5">
              {(
                [
                  { label: "Toggle Explorer",   keys: "Ctrl+B" },
                  { label: "Toggle Chat",       keys: "Ctrl+Alt+B" },
                  { label: "Split Editor",      keys: "Ctrl+\\" },
                  { label: "Save File",         keys: "Ctrl+S" },
                ] as const
              ).map(({ label, keys }) => (
                <div key={label} className="flex items-center justify-between text-[11px]">
                  <span className="text-[var(--ide-muted)]">{label}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] text-[10px] text-[var(--ide-text)] font-mono">
                    {keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div>
            <label className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase block mb-2">
              Tabs
            </label>
            <div className="flex items-center justify-between text-[11px] mb-2">
              <span className="text-[var(--ide-muted)]">Maximum open tabs</span>
              <input
                type="number"
                min={1}
                max={99}
                value={maxTabs}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n) && n > 0) setMaxTabs(n);
                }}
                className="w-14 h-7 px-2 rounded bg-[var(--ide-surface-2)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)] text-right"
              />
            </div>
            <label className="flex items-center justify-between text-[11px] cursor-pointer">
              <span className="text-[var(--ide-muted)]">Auto-close oldest tab when limit reached</span>
              <input
                type="checkbox"
                checked={autoCloseOldest}
                onChange={(e) => setAutoCloseOldest(e.target.checked)}
                className="h-3.5 w-3.5 accent-violet-500"
              />
            </label>
          </div>

          {/* Workspace */}
          <div>
            <label className="text-[10px] font-semibold tracking-wider text-[var(--ide-muted)] uppercase block mb-2">
              Workspace
            </label>
            <p className="text-[11px] text-[var(--ide-muted)] leading-relaxed">
              Use the <strong className="text-[var(--ide-text)]">Manage</strong> button
              in the top bar to rename, delete, or configure the current workspace.
            </p>
          </div>
        </div>
      </div>
    );

  return null;
}

/* ========================================================================== *
 *  IdeShell — assembles the full IDE layout
 * ========================================================================== */
function IdeShell() {
  const router = useRouter();
  const { syncStatus, workspaceId, loading, workspaceName } = useWorkspace();

  /* ── Layout state ──────────────────────────────────────────────────────── */
  const [view,      setView]      = useState<ActivityView>("explorer");
  // Dark/light is app-wide (lib/theme.ts), not per workspace: the IDE used to
  // hold its own useState + per-workspace saved value, so switching here left
  // the rest of DevSphere on the other theme and vice versa.
  const theme = useTheme();

  /* Apply theme vars to document root so portaled modals can access them.
     data-ide-theme itself is set globally by applyTheme(); only the IDE's
     variable set is scoped to being inside the IDE. */
  useEffect(() => {
    const vars = ideThemeVars(theme);
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    return () => {
      for (const key of Object.keys(vars)) {
        root.style.removeProperty(key);
      }
    };
  }, [theme]);

  /* Responsive defaults — SSR-safe fixed values, adjusted on client after mount */
  const [showExplorer, setShowExplorer] = useState(true);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [showChat,     setShowChat]     = useState(false);
  const [isMaximized,  setIsMaximized]  = useState(false);
  const [quickAccessOpen, setQuickAccessOpen] = useState(false);

  /* Panel widths — SSR-safe fixed values */
  const [explorerW, setExplorerW] = useState(264);
  const [chatW,     setChatW]     = useState(360);

  /* Adjust panel sizes/visibility to actual viewport once mounted on client */
  useEffect(() => {
    const w = window.innerWidth;
    queueMicrotask(() => {
      if (w < 640)  setShowExplorer(false);
      if (w < 1024) setShowChat(false);
      setExplorerW(Math.min(264, w * 0.25));
      setChatW(Math.min(360, w * 0.30));
    });
  }, []);

  /* ── Split editor ─────────────────────────────────────────────────────── */
  const [isSplit,         setIsSplit]         = useState(false);
  const [splitActivePath, setSplitActivePath] = useState<string | null>(null);

  /* ── Layout restoration across sessions ──────────────────────────────────
     Loads the saved panel layout once per workspace, then persists changes
     (debounced) once hydration has completed — so we never overwrite a saved
     layout with the transient SSR-safe defaults before it's loaded. */
  const layoutHydratedRef = useRef(false);

  useEffect(() => {
    if (workspaceId == null) return;
    layoutHydratedRef.current = false;
    let cancelled = false;
    (async () => {
      let saved = await getPref<SavedLayout>(workspaceId, "layout").catch(() => null);
      // IndexedDB has no saved layout (fresh device / cache wipe / stale) →
      // rehydrate the panel layout from the server recovery snapshot.
      if (!saved) {
        const remote = await fetchRecoveryState(workspaceId);
        const remoteLayout = remote?.layout as SavedLayout | undefined;
        if (remoteLayout && Object.keys(remoteLayout).length > 0) saved = remoteLayout;
      }
      if (cancelled || !saved) return;
      if (saved.showExplorer != null) setShowExplorer(saved.showExplorer);
      if (saved.explorerCollapsed != null) setExplorerCollapsed(saved.explorerCollapsed);
      if (saved.showChat != null) setShowChat(saved.showChat);
      if (saved.isMaximized != null) setIsMaximized(saved.isMaximized);
      if (saved.explorerW != null) setExplorerW(saved.explorerW);
      if (saved.chatW != null) setChatW(saved.chatW);
      if (saved.view) setView(saved.view);
      if (saved.isSplit != null) setIsSplit(saved.isSplit);
      // saved.theme is deliberately NOT restored — the theme is an app-wide
      // preference now, so a workspace opened after the user switched must not
      // drag the old value back. The field stays on SavedLayout for
      // compatibility with layouts written by earlier builds.
    })()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) layoutHydratedRef.current = true;
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId == null || !layoutHydratedRef.current) return;
    const id = setTimeout(() => {
      void setPref(workspaceId, "layout", {
        showExplorer, explorerCollapsed, showChat, isMaximized, explorerW, chatW, view, isSplit,
      } satisfies SavedLayout).catch(() => {});
    }, 400);
    return () => clearTimeout(id);
  }, [workspaceId, showExplorer, explorerCollapsed, showChat, isMaximized, explorerW, chatW, view, isSplit]);

  /* ── Editor tabs ──────────────────────────────────────────────────────── */
  const {
    tabs, activePath, activeFile, dirtyPaths, files,
    openFile, setActive, closeTab, closeOthers, closeAll, closeTabsUnder,
    updateContent, saveActive, loadFile, saveFile, updateTabViewState,
    reorderTabs, renameTab, renamePrefixTabs,
    maxTabs, setMaxTabs, autoCloseOldest, setAutoCloseOldest,
  } = useEditorTabs(workspaceId);

  /* File shown in the right (split) pane */
  const splitFile = splitActivePath ? (files[splitActivePath] ?? null) : null;

  /* ── Sync engine: drains the outbox, keeps metadata + sync state honest ──── */
  const { pendingOps, status: outboxSyncStatus } = useSyncEngine(workspaceId);

  /* Prefer the live outbox-drain state once the initial load has settled, so
     the StatusBar reflects real save/sync progress (not just the load phase). */
  const effectiveSyncStatus =
    syncStatus === "syncing" || syncStatus === "error" || syncStatus === "conflict"
      ? syncStatus
      : outboxSyncStatus;

  /* ── Split helpers ────────────────────────────────────────────────────── */
  const toggleSplit = useCallback(() => {
    if (isSplit) {
      setIsSplit(false);
      setSplitActivePath(null);
    } else {
      const initial = activePath;
      setIsSplit(true);
      setSplitActivePath(initial);
      if (initial) void loadFile(initial);
    }
  }, [isSplit, activePath, loadFile]);

  const handleSplitSelect = useCallback(
    async (path: string) => {
      setSplitActivePath(path);
      await loadFile(path);
    },
    [loadFile],
  );

  const handleSplitSave = useCallback(async () => {
    if (splitActivePath) await saveFile(splitActivePath);
  }, [splitActivePath, saveFile]);

  /* ── Maximize / restore all panels ───────────────────────────────────── */
  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => {
      const next = !prev;
      if (next) {
        setShowExplorer(false);
        setShowChat(false);
      } else {
        setShowExplorer(true);
        setShowChat(true);
      }
      return next;
    });
  }, []);


  /* ── Global keyboard shortcuts ────────────────────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (!e.shiftKey && !e.altKey && e.key === "b") {
        e.preventDefault();
        setShowExplorer((v) => !v);
      } else if (e.altKey && e.key === "b") {
        e.preventDefault();
        setShowChat((v) => !v);
      } else if (!e.shiftKey && !e.altKey && e.key === "\\") {
        e.preventDefault();
        toggleSplit();
      } else if (!e.shiftKey && !e.altKey && (e.key === "p" || e.key === "k")) {
        e.preventDefault();
        setQuickAccessOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSplit]);

  /* ── Quick Access command handler ───────────────────────────────────── */
  const handleQuickAccessCommand = useCallback((id: string) => {
    switch (id) {
      case "toggle-explorer":  setShowExplorer((v) => !v); break;
      case "toggle-chat":      setShowChat((v) => !v); break;
      case "toggle-theme":     toggleTheme(); break;
      case "toggle-split":     toggleSplit(); break;
      case "layout-default":   setShowExplorer(true);  setShowChat(true);  break;
      case "layout-editor":    setShowExplorer(false); setShowChat(false); break;
      case "layout-code-chat": setShowExplorer(false); setShowChat(true);  break;
      case "layout-sidebar":   setShowExplorer(true);  setShowChat(false); break;
      case "layout-all":       setShowExplorer(true);  setShowChat(true);  break;
    }
  }, [toggleSplit]);

  return (
    <div
      style={ideThemeVars(theme) as React.CSSProperties}
      className={`flex flex-col h-screen w-screen bg-[var(--ide-bg)] text-[var(--ide-text)] overflow-hidden ide-noise ${
        theme === "dark" ? "ide-gradient-bg-dark" : "ide-gradient-bg-light"
      }`}
    >
      <TopBar
        activePath={activePath}
        theme={theme}
        onToggleTheme={toggleTheme}
        dirtyPaths={dirtyPaths}
        showExplorer={showExplorer}
        showChat={showChat}
        onToggleExplorer={() => setShowExplorer((v) => !v)}
        onToggleChat={() => setShowChat((v) => !v)}
        onSetLayout={({ explorer, chat }) => {
          setShowExplorer(explorer);
          setShowChat(chat);
        }}
        isMaximized={isMaximized}
        onToggleMaximize={toggleMaximize}
        onSearchClick={() => setQuickAccessOpen(true)}
      />

      <div className="flex flex-1 min-h-0">
        <ActivityBar active={view} onSelect={(v) => {
          if (v === "appnav") { router.push("/"); return; }
          setView(v);
          setShowExplorer(true);
          setExplorerCollapsed(false);
        }} />

        {/* ── Primary Sidebar ─────────────────────────────────────────── */}
        {showExplorer && explorerCollapsed && (
          <div className="shrink-0 p-1 min-h-0">
            <button
              type="button"
              title={`Show ${VIEW_TITLE[view]}`}
              onClick={() => setExplorerCollapsed(false)}
              className="h-full w-9 flex flex-col items-center gap-2 pt-2.5 bg-[var(--ide-glass)] backdrop-blur-md border border-[var(--ide-glass-border)] rounded-xl shadow-lg hover:brightness-110"
            >
              <PanelLeftOpen className="h-4 w-4" />
              <Files className="h-3.5 w-3.5 opacity-60" />
            </button>
          </div>
        )}
        {showExplorer && !explorerCollapsed && (
          <>
            <div
              style={{ width: explorerW }}
              className="shrink-0 p-1 min-h-0 transition-all duration-200"
            >
              <PanelFrame
                title={VIEW_TITLE[view]}
                icon={<Files className="h-3.5 w-3.5" />}
                onChange={(s) => { if (s.collapsed) setExplorerCollapsed(true); }}
                onClose={() => setShowExplorer(false)}
              >
                <SidebarContent
                  view={view}
                  workspaceId={workspaceId}
                  loading={loading}
                  activePath={activePath}
                  openFile={openFile}
                  closeTab={closeTab}
                  closeTabsUnder={closeTabsUnder}
                  renameTab={renameTab}
                  renamePrefixTabs={renamePrefixTabs}
                  theme={theme}
                  onToggleTheme={toggleTheme}
                  maxTabs={maxTabs}
                  setMaxTabs={setMaxTabs}
                  autoCloseOldest={autoCloseOldest}
                  setAutoCloseOldest={setAutoCloseOldest}
                />
              </PanelFrame>
            </div>
            <ResizeHandle
              dir="x"
              onDelta={(d) =>
                setExplorerW((w) => clamp(w + d, 180, vw() * 0.45))
              }
            />
          </>
        )}

        {/* ── Center: editor ──────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 min-w-0 p-1 gap-1 relative">

          {/* Editor panel */}
          <div
            style={{ flex: "1 1 0", overflow: "hidden" }}
            className="min-h-0 flex flex-col bg-[var(--ide-surface)] border border-[var(--ide-glass-border)] rounded-xl shadow-lg"
          >
            {/* ── Tab bar row: left-pane tabs + split toggle ── */}
            <div className="flex items-stretch shrink-0 border-b border-[var(--ide-border)]">
              <div className="flex-1 min-w-0 overflow-hidden">
                <EditorTabs
                  tabs={tabs}
                  activePath={activePath}
                  dirtyPaths={dirtyPaths}
                  onSelect={setActive}
                  onClose={closeTab}
                  onCloseOthers={closeOthers}
                  onCloseAll={closeAll}
                  onReorder={reorderTabs}
                  onOpenFile={openFile}
                />
              </div>
              <button
                type="button"
                title={
                  isSplit
                    ? "Close Split Editor (Ctrl+\\)"
                    : "Split Editor Right (Ctrl+\\)"
                }
                onClick={toggleSplit}
                className={`h-8 px-2 inline-flex items-center justify-center shrink-0 border-l border-[var(--ide-border)] transition-colors ${
                  isSplit
                    ? "bg-violet-600/20 text-violet-300"
                    : "text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                }`}
              >
                <SquareSplitHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* ── Editor area: single or split ── */}
            {isSplit ? (
              /* Split layout */
              <div className="flex flex-1 min-h-0">
                {/* Left pane */}
                <div className="flex flex-col flex-1 min-w-0 min-h-0">
                  <Breadcrumb
                    path={activePath}
                    workspaceId={workspaceId}
                    onOpenFile={openFile}
                  />
                  <div className="flex-1 min-h-0">
                    <EditorPane
                      file={activeFile}
                      onChange={updateContent}
                      onSave={saveActive}
                      theme={theme}
                      onOpenFile={openFile}
                      tabs={tabs}
                      workspaceName={workspaceName}
                      onViewStateChange={updateTabViewState}
                    />
                  </div>
                </div>

                {/* Divider + right pane */}
                <div className="w-px bg-[var(--ide-border)] shrink-0" />
                <div className="flex flex-col flex-1 min-w-0 min-h-0">
                  {/* Right pane tab bar */}
                  <div className="shrink-0 border-b border-[var(--ide-border)] overflow-hidden">
                    <EditorTabs
                      tabs={tabs}
                      activePath={splitActivePath}
                      dirtyPaths={dirtyPaths}
                      onSelect={handleSplitSelect}
                      onClose={closeTab}
                      onCloseOthers={closeOthers}
                      onCloseAll={closeAll}
                      onReorder={reorderTabs}
                      onOpenFile={handleSplitSelect}
                    />
                  </div>
                  <Breadcrumb
                    path={splitActivePath}
                    workspaceId={workspaceId}
                    onOpenFile={handleSplitSelect}
                  />
                  <div className="flex-1 min-h-0">
                    <EditorPane
                      file={splitFile}
                      onChange={updateContent}
                      onSave={handleSplitSave}
                      theme={theme}
                      onOpenFile={handleSplitSelect}
                      tabs={tabs}
                      workspaceName={workspaceName}
                      onViewStateChange={updateTabViewState}
                    />
                  </div>
                </div>
              </div>
            ) : (
              /* Single layout */
              <>
                <Breadcrumb
                  path={activePath}
                  workspaceId={workspaceId}
                  onOpenFile={openFile}
                />
                <div className="flex-1 min-h-0">
                  <EditorPane
                    file={activeFile}
                    onChange={updateContent}
                    onSave={saveActive}
                    theme={theme}
                    onOpenFile={openFile}
                    tabs={tabs}
                    workspaceName={workspaceName}
                    onViewStateChange={updateTabViewState}
                  />
                </div>
              </>
            )}
          </div>

          {/* Quick Access (Ctrl+P / Ctrl+K) — inside editor column so it centers here */}
          {workspaceId != null && (
            <QuickAccess
              open={quickAccessOpen}
              onClose={() => setQuickAccessOpen(false)}
              workspaceId={workspaceId}
              tabs={tabs}
              onOpenFile={openFile}
              onCommand={handleQuickAccessCommand}
            />
          )}
        </div>

        {/* ── Secondary Sidebar (Chat) — inline, hidden by default ──── */}
        {showChat && (
          <>
            <ResizeHandle
              dir="x"
              onDelta={(d) =>
                setChatW((w) => clamp(w - d, 280, vw() * 0.45))
              }
            />
            <div style={{ width: chatW }} className="shrink-0 p-1 min-h-0 transition-all duration-200">
              <ChatDock onClose={() => setShowChat(false)} onOpenFile={openFile} />
            </div>
          </>
        )}
      </div>

      <StatusBar
        syncStatus={effectiveSyncStatus}
        fullPath={activePath ? `/${activePath}` : null}
        language={activeFile?.lang}
        pendingOps={pendingOps}
      />

      {/* ── Chat FAB toggle ─────────────────────────────────────────── */}
      {!showChat && (
        <button
          type="button"
          title="Open AI chat (Ctrl+Alt+B)"
          onClick={() => setShowChat(true)}
          className="fixed bottom-3 right-3 z-30 h-12 w-12 rounded-full shadow-lg flex items-center justify-center bg-gradient-to-br from-violet-600 to-indigo-600 text-white hover:shadow-violet-500/30 hover:scale-105 ide-send-glow transition-all duration-200"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
      )}

    </div>
  );
}

export default function WorkspaceIdePage() {
  const params = useParams();
  const router = useRouter();
  const raw = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const id = raw ? Number(raw) : null;
  // RBAC gate — resolved in an effect, NOT during render: canAccessWorkspaceStudio()
  // reads the user from localStorage, which doesn't exist during SSR, so a
  // render-time check made the server render null while the hydrating client
  // rendered the IDE → React hydration mismatch. `null` = undecided, rendered
  // identically (nothing) on the server and the first client pass.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    const ok = canAccessWorkspaceStudio();
    setAllowed(ok);
    if (!ok) router.replace("/");
  }, [router]);

  if (!allowed) return null; // undecided (first paint) or denied

  return (
    <WorkspaceProvider workspaceId={Number.isFinite(id) ? id : null}>
      <ProjectProvider>
        <ToastProvider>
          <IdeShell />
        </ToastProvider>
      </ProjectProvider>
    </WorkspaceProvider>
  );
}
