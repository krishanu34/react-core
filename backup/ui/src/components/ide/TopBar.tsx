"use client";

/**
 * TopBar — floating glass bar with three-zone layout.
 *
 * Zones: LEFT (brand + workspace chip) | CENTER (hero search) | RIGHT (controls + traffic lights)
 *
 * Decluttered: "New Workspace" and "Manage" live in the workspace dropdown only.
 * Session chip integrated into workspace button. Path display removed (breadcrumb handles it).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Plus,
  Settings2,
  Sun,
  Moon,
  Folder,
  Pencil,
  Search,
  LayoutGrid,
  PanelLeft,
  PanelRight,
  Minus,
  Maximize2,
  Minimize2,
  X,
  Check,
  Trash2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import {
  getLocalWorkspace,
  updateLocalWorkspace,
  deleteLocalWorkspace,
  isLocalWorkspaceId,
} from "@/lib/db/workspaceStore";
import { removeDirectoryHandle } from "@/lib/localFs";
import { archiveWorkspace, listWorkspaces, renameWorkspace, updateWorkspace } from "@/lib/workspace-api";
import { NewWorkspaceModal } from "@/components/ide/NewWorkspaceModal";
import { WorkspaceSettingsModal } from "@/components/ide/WorkspaceSettingsModal";

type WorkspaceEntry = {
  id: number;
  name: string;
  localPathLabel?: string;
};

/* ── Layout presets ─────────────────────────────────────────────────────── */
const LAYOUT_PRESETS = [
  { id: "default",   label: "Default",     explorer: true,  chat: true  },
  { id: "editor",    label: "Editor Only", explorer: false, chat: false },
  { id: "code-chat", label: "Code + Chat", explorer: false, chat: true  },
  { id: "sidebar",   label: "Sidebar",     explorer: true,  chat: false },
  { id: "all",       label: "All Panels",  explorer: true,  chat: true  },
] as const;

function LayoutThumb({ explorer, chat }: { explorer: boolean; chat: boolean }) {
  return (
    <div className="flex gap-0.5 w-full h-7 rounded-lg bg-[var(--ide-bg)] p-0.5">
      {explorer && <div className="w-2.5 rounded shrink-0 bg-gradient-to-b from-violet-500/60 to-violet-600/40" />}
      <div className="flex-1 rounded bg-[var(--ide-surface-2)]" />
      {chat && <div className="w-2.5 rounded shrink-0 bg-gradient-to-b from-teal-500/60 to-teal-600/40" />}
    </div>
  );
}

/* ── Local path chip — click to copy; inline editor for full path ─────── */
function LocalPathChip({ path, workspaceId, onPathUpdated }: {
  path: string;
  workspaceId: number | null;
  onPathUpdated: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [displayPath, setDisplayPath] = useState(path);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Self-heals a previously-saved path that still has stray quotes wrapped
  // around it (e.g. pasted from Windows' "Copy as path").
  useEffect(() => {
    queueMicrotask(() => setDisplayPath(path.replace(/^["']+|["']+$/g, "").trim()));
  }, [path]);

  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setEditing(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  useEffect(() => {
    if (editing) setTimeout(() => inputRef.current?.select(), 50);
  }, [editing]);

  const isFullPath = /^[A-Za-z]:[\\/]|^\//.test(displayPath);

  const btnRef = useRef<HTMLButtonElement>(null);
  const [popPos, setPopPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  const handleClick = () => {
    if (isFullPath) {
      navigator.clipboard.writeText(displayPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setEditValue(displayPath);
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setPopPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
      }
      setEditing(true);
    }
  };

  const handleSave = async () => {
    // Strip stray wrapping quotes — Windows' "Copy as path" wraps the value in
    // quotes, which otherwise breaks the isFullPath check and makes this popup
    // reappear every time instead of being remembered.
    const trimmed = editValue.trim().replace(/^["']+|["']+$/g, "").trim();
    if (!trimmed) return;
    if (workspaceId != null) {
      try {
        await updateWorkspace(workspaceId, { local_fs_path: trimmed });
        const ws = await getLocalWorkspace(workspaceId);
        if (ws) {
          await updateLocalWorkspace({ ...ws, localPathLabel: trimmed });
          onPathUpdated();
        }
      } catch { /* ignore */ }
    }
    setDisplayPath(trimmed);
    navigator.clipboard.writeText(trimmed);
    setEditing(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={copied ? "Copied!" : isFullPath ? `Click to copy: ${displayPath}` : "Click to set full path"}
        onClick={handleClick}
        className={`hidden lg:inline-flex items-center gap-1.5 h-7 px-2.5 mr-1 rounded-xl border text-[11px] max-w-[260px] transition-all duration-200 shrink-0 ${
          copied
            ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
            : isFullPath
              ? "bg-[var(--ide-surface-2)] border-[var(--ide-glass-border)] text-[var(--ide-text)] hover:border-[var(--ide-muted)] cursor-copy"
              : "bg-amber-500/10 border-amber-500/25 text-amber-300 hover:border-amber-400 cursor-pointer"
        }`}
      >
        {copied
          ? <Check className="h-3.5 w-3.5 shrink-0" />
          : <Folder className={`h-3.5 w-3.5 shrink-0 ${isFullPath ? "text-amber-400" : "text-amber-300"}`} />}
        <span className="truncate font-mono text-[10px]">
          {copied ? "Copied!" : displayPath}
        </span>
      </button>

      {editing && (
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setEditing(false)} />
          <div
            ref={popRef}
            style={{ top: popPos.top, right: popPos.right }}
            className="fixed z-[101] w-80 rounded-xl border border-[var(--ide-glass-border)] bg-[var(--ide-surface-2)] shadow-2xl p-3 space-y-2"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ide-muted)]">Set Full Local Path</p>
            <p className="text-[10px] text-[var(--ide-muted)] leading-relaxed">
              Enter the full path once — it will be saved and used for Copy Path.
            </p>
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder="e.g. C:\Users\you\projects\my-app"
              className="w-full h-8 rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface)] px-2.5 text-[12px] font-mono text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setEditing(false)}
                className="h-7 px-3 rounded-lg text-[11px] text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] transition-colors">
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={!editValue.trim()}
                className="h-7 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-[11px] font-medium text-white transition-colors">
                Save &amp; Copy
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ========================================================================== *
 *  TopBar — floating glass bar with three-zone layout
 * ========================================================================== */
export function TopBar({
  theme,
  onToggleTheme,
  dirtyPaths,
  showExplorer = true,
  showChat = true,
  onToggleExplorer,
  onToggleChat,
  isMaximized = false,
  onToggleMaximize,
  onSetLayout,
  onSearchClick,
}: {
  activePath: string | null;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  dirtyPaths?: Set<string>;
  showExplorer?: boolean;
  showChat?: boolean;
  onToggleExplorer?: () => void;
  onToggleChat?: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onSetLayout?: (cfg: { explorer: boolean; chat: boolean }) => void;
  onSearchClick?: () => void;
}) {
  const router = useRouter();
  const {
    workspaceId, workspaceName, activeSession,
    localPathLabel, fsHandle, refreshLocalMeta, syncLocalFolder,
  } = useWorkspace();

  const [open,         setOpen]         = useState(false);
  const [list,         setList]         = useState<WorkspaceEntry[]>([]);
  const [newOpen,      setNewOpen]      = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layoutOpen,   setLayoutOpen]   = useState(false);

  const [editingId,  setEditingId]  = useState<number | null>(null);
  const [editName,   setEditName]   = useState("");
  const [busyId,     setBusyId]     = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [syncingLocal, setSyncingLocal] = useState(false);

  const ref       = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
        setDeletingId(null);
      }
      if (layoutRef.current && !layoutRef.current.contains(e.target as Node)) {
        setLayoutOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const activePresetId = LAYOUT_PRESETS.find(
    (l) => l.explorer === showExplorer && l.chat === showChat,
  )?.id;

  const loadList = async () => {
    const ws = await listWorkspaces().catch(() => []);
    setList(
      ws
        .filter((w) => !w.archived)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .map((w) => ({ id: w.id, name: w.name, localPathLabel: w.localPathLabel })),
    );
  };

  const navigateTo = (id: number) => {
    setOpen(false);
    if (id === workspaceId) return;
    if (dirtyPaths && dirtyPaths.size > 0) {
      if (!window.confirm("You have unsaved changes. Leave this workspace?")) return;
    }
    router.push(`/workspaces/${id}/ide`);
  };

  const startRename = (w: WorkspaceEntry) => {
    setEditingId(w.id);
    setEditName(w.name);
    setDeletingId(null);
  };

  const commitRename = async (w: WorkspaceEntry) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === w.name) { setEditingId(null); return; }
    setBusyId(w.id);
    try {
      await renameWorkspace(w.id, trimmed);
      const local = await getLocalWorkspace(w.id).catch(() => null);
      if (local) await updateLocalWorkspace({ ...local, name: trimmed });
      setList((prev) => prev.map((x) => (x.id === w.id ? { ...x, name: trimmed } : x)));
      if (w.id === workspaceId) await refreshLocalMeta();
    } catch {
      window.alert("Rename failed.");
    } finally {
      setBusyId(null);
      setEditingId(null);
    }
  };

  const confirmDelete = async (w: WorkspaceEntry) => {
    setBusyId(w.id);
    try {
      await archiveWorkspace(w.id, w.name);
      await deleteLocalWorkspace(w.id);
      await removeDirectoryHandle(w.id).catch(() => {});
      setList((prev) => prev.filter((x) => x.id !== w.id));
      setDeletingId(null);
      if (w.id === workspaceId) {
        setOpen(false);
        router.push("/workspaces");
      }
    } catch {
      window.alert("Delete failed.");
    } finally {
      setBusyId(null);
    }
  };

  const handleManualSync = async () => {
    if (syncingLocal) return;
    setSyncingLocal(true);
    try {
      const result = await syncLocalFolder();
      if (!result) window.alert("Grant access to the linked local folder before syncing.");
    } catch {
      window.alert("Sync failed.");
    } finally {
      setSyncingLocal(false);
    }
  };

  const isLocal = workspaceId != null && isLocalWorkspaceId(workspaceId);
  const wsTooltip = isLocal
    ? localPathLabel || fsHandle?.name || workspaceName || "Local Workspace"
    : workspaceName || "Workspace";

  return (
  <>
    <header className="relative z-50 mx-2 mt-2 flex items-center justify-between h-10 shrink-0 bg-[var(--ide-glass)] backdrop-blur-xl border border-[var(--ide-glass-border)] rounded-2xl px-1.5 text-[var(--ide-text)] shadow-lg ide-island-glow ide-topbar-glow">

      {/* ── LEFT ZONE: Brand + Workspace ─────────────────────────────── */}
      <div className="flex items-center gap-1.5 shrink-0 z-[1]">
        <div className="flex items-center gap-1.5 pl-2 pr-1 shrink-0">
          <div className="flex flex-col leading-none">
            <div className="flex items-baseline gap-1">
              <span className="text-[15px] font-extrabold text-[#e31937] tracking-tight">CGI</span>
              <span className="text-[15px] font-bold text-[var(--ide-text)] tracking-tight">DevAccel</span>
            </div>
            <span className="text-[8px] font-medium text-[var(--ide-muted)] tracking-widest uppercase">AI Dev Accelerator</span>
          </div>
        </div>

        <div className="w-px h-5 bg-[var(--ide-border)] shrink-0" />

        <div ref={ref} className="relative shrink-0">
          <button
            type="button"
            title={wsTooltip}
            onClick={() => { setOpen((o) => !o); if (!open) loadList(); }}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-xl bg-[var(--ide-surface-2)] border border-[var(--ide-glass-border)] hover:border-[var(--ide-muted)] text-xs font-medium transition-colors"
          >
            <LayoutGrid className="h-3.5 w-3.5 text-violet-400 shrink-0" />
            <div className="flex flex-col items-start leading-tight min-w-0">
              <span className="truncate max-w-[130px] text-[11px]">{workspaceName || "Workspace"}</span>
              {activeSession && (
                <span className="truncate max-w-[130px] text-[8px] text-[var(--ide-muted)] -mt-0.5">{activeSession.name}</span>
              )}
            </div>
            {isLocal && (
              <span className="shrink-0 rounded-full border border-[var(--ide-border)] px-1.5 py-px text-[9px] text-[var(--ide-muted)] font-mono leading-none">local</span>
            )}
            <ChevronDown className="h-3 w-3 text-[var(--ide-muted)] shrink-0" />
          </button>

          {/* ── Workspace dropdown ─────────────────────────────────────── */}
          {open && (
            <div className="absolute left-0 mt-1 w-72 z-50 rounded-xl border border-[var(--ide-glass-border)] bg-[var(--ide-surface-2)] shadow-2xl backdrop-blur-xl p-1">
              <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">Workspaces</p>

              <div className="max-h-72 overflow-auto">
                {list.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-[var(--ide-muted)]">No workspaces yet. Create one below.</p>
                ) : (
                  list.map((w) => {
                    const isBusy     = busyId === w.id;
                    const isEditing  = editingId === w.id;
                    const isDeleting = deletingId === w.id;
                    const isCurrent  = w.id === workspaceId;

                    return (
                      <div key={w.id} className="group relative">
                        {isEditing ? (
                          <div className="flex items-center gap-1 px-2 py-1">
                            <input
                              autoFocus
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename(w);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="flex-1 h-6 px-1.5 rounded bg-[var(--ide-surface)] border border-violet-500 text-[12px] focus:outline-none"
                            />
                            <button type="button" onClick={() => commitRename(w)} disabled={isBusy}
                              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] disabled:opacity-40">
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-emerald-400" />}
                            </button>
                            <button type="button" onClick={() => setEditingId(null)}
                              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)]">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : isDeleting ? (
                          <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                            <span className="flex-1 text-red-400 truncate">Delete &ldquo;{w.name}&rdquo;?</span>
                            <button type="button" onClick={() => confirmDelete(w)} disabled={isBusy}
                              className="h-6 px-2 rounded bg-red-600 hover:bg-red-500 text-white disabled:opacity-40">
                              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
                            </button>
                            <button type="button" onClick={() => setDeletingId(null)}
                              className="h-6 px-2 rounded border border-[var(--ide-border)] hover:bg-[var(--ide-hover)]">Cancel</button>
                          </div>
                        ) : (
                          <div className="flex items-start gap-1 pr-1">
                            <button type="button" onClick={() => navigateTo(w.id)}
                              className="flex-1 flex items-start gap-2 px-2 py-1.5 rounded text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] text-left min-w-0">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="truncate">{w.name}</span>
                                  <span className="shrink-0 rounded-full border border-[var(--ide-border)] px-1.5 py-px text-[10px] text-[var(--ide-muted)] font-mono leading-none">local</span>
                                </div>
                                {w.localPathLabel && (
                                  <p className="mt-0.5 text-[10px] text-[var(--ide-muted)] truncate font-mono">{w.localPathLabel}</p>
                                )}
                              </div>
                              {isCurrent && <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />}
                            </button>
                            <div className="hidden group-hover:flex items-center gap-0.5 py-1">
                              <button type="button" title="Rename" onClick={() => startRename(w)}
                                className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]">
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button type="button" title="Delete" onClick={() => setDeletingId(w.id)}
                                className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-red-950/40 text-[var(--ide-muted)] hover:text-red-400">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="border-t border-[var(--ide-border)] mt-1 pt-1 space-y-0.5">
                <button type="button" onClick={() => { setOpen(false); setNewOpen(true); }}
                  className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded text-xs text-violet-300 hover:bg-[var(--ide-hover)]">
                  <Plus className="h-3.5 w-3.5" /> New Workspace
                </button>
                {workspaceId != null && (
                  <button type="button" onClick={() => { setOpen(false); setSettingsOpen(true); }}
                    className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded text-xs text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]">
                    <Settings2 className="h-3.5 w-3.5" /> Manage Current Workspace
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* ── CENTER ZONE: Hero search bar ──────────────────────────────── */}
      <div className="flex-1 flex justify-center px-3 min-w-0">
        <button
          type="button"
          onClick={onSearchClick}
          className="flex items-center gap-2 h-7 px-3 w-full max-w-sm rounded-xl bg-[var(--ide-hover)] border border-[var(--ide-glass-border)] text-xs text-[var(--ide-muted)] hover:border-[var(--ide-muted)] hover:bg-[var(--ide-surface-2)] transition-all"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left truncate">Search files, commands…</span>
          <kbd className="shrink-0 px-1.5 py-0.5 rounded-md bg-[var(--ide-surface)] border border-[var(--ide-glass-border)] text-[10px] font-mono">Ctrl+K</kbd>
        </button>
      </div>

      {/* ── RIGHT ZONE: Local path + Controls + Traffic Lights ─────── */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Local path chip — click to copy */}
        {isLocal && (
          <LocalPathChip
            path={localPathLabel || fsHandle?.name || workspaceName || "Local Workspace"}
            workspaceId={workspaceId}
            onPathUpdated={refreshLocalMeta}
          />
        )}

        {isLocal && (
          <button type="button" onClick={handleManualSync} disabled={syncingLocal} title="Sync local folder"
            className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-teal-300 hover:bg-[var(--ide-hover)] disabled:opacity-50 transition-colors">
            <RefreshCw className={`h-3.5 w-3.5 ${syncingLocal ? "animate-spin" : ""}`} />
          </button>
        )}

        <button type="button" onClick={onToggleTheme} title="Toggle theme"
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-amber-300 hover:bg-[var(--ide-hover)] transition-colors">
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>

        {/* Layout picker */}
        <div ref={layoutRef} className="relative">
          <button type="button" title="Customize Layout" onClick={() => setLayoutOpen((o) => !o)}
            className={`h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)] ${
              layoutOpen ? "bg-[var(--ide-hover)] text-[var(--ide-text)]" : "text-[var(--ide-muted)]"
            }`}>
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>

          {layoutOpen && (
            <div className="absolute right-0 top-full mt-1 w-72 z-50 rounded-xl border border-[var(--ide-glass-border)] bg-[var(--ide-surface-2)] shadow-2xl backdrop-blur-xl">
              <div className="p-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] mb-2">Layout Presets</p>
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {LAYOUT_PRESETS.map((preset) => {
                    const isActive = preset.id === activePresetId;
                    return (
                      <button key={preset.id} type="button" title={preset.label}
                        onClick={() => { onSetLayout?.({ explorer: preset.explorer, chat: preset.chat }); setLayoutOpen(false); }}
                        className={`flex flex-col gap-1 p-1.5 rounded-lg border text-left transition-colors ${
                          isActive
                            ? "border-violet-500 bg-violet-500/10"
                            : "border-[var(--ide-border)] hover:border-[var(--ide-muted)] hover:bg-[var(--ide-hover)]"
                        }`}>
                        <LayoutThumb explorer={preset.explorer} chat={preset.chat} />
                        <span className="text-[9px] text-center w-full block text-[var(--ide-muted)] leading-tight">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="border-t border-[var(--ide-border)] mb-2" />
                <p className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)] mb-1.5">Panels</p>
                <div className="space-y-0.5">
                  {([
                    { label: "Primary Sidebar",  hint: "Ctrl+B",     Icon: PanelLeft,  active: showExplorer, toggle: onToggleExplorer },
                    { label: "Secondary Sidebar", hint: "Ctrl+Alt+B", Icon: PanelRight, active: showChat,     toggle: onToggleChat },
                  ] as const).map(({ label, hint, Icon, active, toggle }) => (
                    <button key={label} type="button" onClick={() => toggle?.()}
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-[var(--ide-hover)] transition-colors">
                      <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-violet-400" : "text-[var(--ide-muted)]"}`} />
                      <span className={`flex-1 text-xs text-left ${active ? "text-[var(--ide-text)]" : "text-[var(--ide-muted)]"}`}>{label}</span>
                      <kbd className="shrink-0 text-[10px] px-1 py-px rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] text-[var(--ide-muted)] font-mono">{hint}</kbd>
                      {active && <Check className="h-3 w-3 text-violet-400 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Panel quick toggles */}
        <button type="button" title="Toggle Primary Sidebar (Ctrl+B)" onClick={onToggleExplorer}
          className={`h-7 w-7 inline-flex items-center justify-center rounded-lg hover:bg-[var(--ide-hover)] transition-colors ${showExplorer ? "text-[var(--ide-text)]" : "text-[var(--ide-muted)]"}`}>
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
        <button type="button" title="Toggle Secondary Sidebar (Ctrl+Alt+B)" onClick={onToggleChat}
          className={`h-7 w-7 inline-flex items-center justify-center rounded-lg hover:bg-[var(--ide-hover)] transition-colors ${showChat ? "text-[var(--ide-text)]" : "text-[var(--ide-muted)]"}`}>
          <PanelRight className="h-3.5 w-3.5" />
        </button>

        <div className="w-px h-4 bg-[var(--ide-border)] mx-1" />

        {/* Traffic light window controls */}
        <div className="flex items-center gap-1.5 pr-1.5">
          <button type="button" title="Minimize" onClick={onToggleMaximize}
            className="group h-3.5 w-3.5 rounded-full bg-amber-500 hover:bg-amber-400 transition-all flex items-center justify-center shadow-sm">
            <Minus className="h-2 w-2 text-amber-950 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
          <button type="button" title={isMaximized ? "Restore Layout" : "Maximize Editor"} onClick={onToggleMaximize}
            className="group h-3.5 w-3.5 rounded-full bg-green-500 hover:bg-green-400 transition-all flex items-center justify-center shadow-sm">
            {isMaximized
              ? <Minimize2 className="h-2 w-2 text-green-950 opacity-0 group-hover:opacity-100 transition-opacity" />
              : <Maximize2 className="h-2 w-2 text-green-950 opacity-0 group-hover:opacity-100 transition-opacity" />}
          </button>
          <button type="button" title="Close" onClick={() => router.push("/workspaces")}
            className="group h-3.5 w-3.5 rounded-full bg-red-500 hover:bg-red-400 transition-all flex items-center justify-center shadow-sm">
            <X className="h-2 w-2 text-red-950 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>
      </div>

    </header>

    {/* Modals — outside header to avoid backdrop-filter containing block */}
    <NewWorkspaceModal open={newOpen} onClose={() => setNewOpen(false)} />
    <WorkspaceSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </>
  );
}

export default TopBar;
