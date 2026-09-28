"use client";

/**
 * ExplorerTree — VS Code-style file tree with robust drag-and-drop.
 *
 * Key design decisions that make DnD reliable:
 *
 *  • Drop indicators are position:absolute — they do NOT shift row layout, so
 *    getPos() always measures the unshifted 24 px row rect.  The old block-
 *    element DropLine caused a 2 px layout shift that made the indicator flicker.
 *
 *  • setDropTarget is ref-guarded — skips the React setState when the computed
 *    target hasn't changed, so dragover events don't thrash re-renders.
 *
 *  • dragItemsRef is written synchronously inside startDrag so executeDrop
 *    always reads the correct set of items even if state hasn't flushed yet.
 *
 *  • Ghost image uses left:-9999px (not top:-9999px) which is reliable across
 *    all browser / OS / DPI combinations.
 *
 * Exported constant EXPLORER_DRAG_MIME lets other components (EditorTabs,
 * EditorPane container) recognise drags originating from this tree.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  ClipboardCopy,
  File as FileIcon,
  FileCode2,
  FileJson2,
  FileText,
  FileImage,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderInput,
  Loader2,
  Pencil,
  Trash2,
  Globe,
  Palette,
  Settings2,
  Database,
  Terminal,
} from "lucide-react";
import { getChildren, enqueueOutbox, type WsNode } from "@/lib/db/workspaceStore";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import { useToast } from "@/hooks/useToast";
import {
  createFile,
  deleteFile,
  fetchFileContent,
  renameFile,
  renameFolder,
} from "@/lib/workspace-api";

/** Characters not allowed in a file/folder name on common filesystems. */
const INVALID_NAME_RE = /[\\/:*?"<>|]/;

/** Returns a user-facing message if `name` is invalid, else null. */
function nameError(name: string): string | null {
  if (!name.trim()) return "Name cannot be empty.";
  if (INVALID_NAME_RE.test(name)) return `Name cannot contain: \\ / : * ? " < > |`;
  return null;
}

/** Friendlier copy for a failed FS/API operation, distinguishing permission errors. */
function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === "NotAllowedError") {
    return "Permission denied — reopen the folder to grant access again.";
  }
  return err?.message || "Something went wrong.";
}

/* ── MIME type (shared with EditorTabs / page.tsx) ───────────────────────── */
export const EXPLORER_DRAG_MIME = "application/vnd.devaccel.paths";

/* ========================================================================== *
 *  Types
 * ========================================================================== */

interface DragItem {
  path: string;
  isFolder: boolean;
}

interface DropTarget {
  /** Resolved destination folder path ("" = workspace root). */
  folder: string;
  /** Path of the row that renders the indicator line; null in folder-highlight mode. */
  indicatorRow: string | null;
  pos: "before" | "into" | "after";
}

/* ========================================================================== *
 *  Tree context
 * ========================================================================== */

interface TreeApi {
  workspaceId: number;
  activePath: string | null;
  reloadKey: number;
  fullBasePath: string;
  onOpenFile: (path: string) => void;
  onCloseFile?: (path: string) => void;
  onCloseTabsUnder?: (prefix: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onRenameFolder?: (oldPath: string, newPath: string) => void;
  refresh: () => void;
  openMenu: (x: number, y: number, node: WsNode | null) => void;
  /* selection */
  selectedItems: Map<string, boolean>; // path → isFolder
  toggleSelect: (path: string, isFolder: boolean, multi: boolean) => void;
  clearSelection: () => void;
  /* drag */
  dragItems: DragItem[] | null;
  startDrag: (items: DragItem[]) => void;
  endDrag: () => void;
  dropTarget: DropTarget | null;
  setDropTarget: (t: DropTarget | null) => void;
  executeDrop: (folder: string, copy: boolean) => void;
}

const TreeCtx = createContext<TreeApi | null>(null);
const useTree = () => {
  const c = useContext(TreeCtx);
  if (!c) throw new Error("Tree context missing");
  return c;
};

/* ── Utilities ──────────────────────────────────────────────────────────── */

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const extOf = (p: string) => p.split(".").pop()?.toLowerCase() ?? "";

/** File-type → icon + color, so the explorer distinguishes files the way VS Code does. */
const FILE_ICON_MAP: Record<string, { Icon: typeof FileIcon; color: string }> = {
  ts:    { Icon: FileCode2,  color: "text-blue-400" },
  tsx:   { Icon: FileCode2,  color: "text-cyan-400" },
  js:    { Icon: FileCode2,  color: "text-yellow-400" },
  jsx:   { Icon: FileCode2,  color: "text-amber-400" },
  mjs:   { Icon: FileCode2,  color: "text-yellow-400" },
  py:    { Icon: FileCode2,  color: "text-sky-400" },
  java:  { Icon: FileCode2,  color: "text-orange-400" },
  go:    { Icon: FileCode2,  color: "text-teal-400" },
  rs:    { Icon: FileCode2,  color: "text-rose-400" },
  rb:    { Icon: FileCode2,  color: "text-red-400" },
  php:   { Icon: FileCode2,  color: "text-violet-400" },
  cs:    { Icon: FileCode2,  color: "text-green-400" },
  c:     { Icon: FileCode2,  color: "text-blue-300" },
  cpp:   { Icon: FileCode2,  color: "text-blue-300" },
  h:     { Icon: FileCode2,  color: "text-blue-300" },
  html:  { Icon: Globe,      color: "text-orange-400" },
  htm:   { Icon: Globe,      color: "text-orange-400" },
  css:   { Icon: Palette,    color: "text-pink-400" },
  scss:  { Icon: Palette,    color: "text-pink-400" },
  json:  { Icon: FileJson2,  color: "text-emerald-400" },
  yml:   { Icon: Settings2,  color: "text-purple-400" },
  yaml:  { Icon: Settings2,  color: "text-purple-400" },
  md:    { Icon: FileText,   color: "text-slate-300" },
  sql:   { Icon: Database,   color: "text-indigo-400" },
  sh:    { Icon: Terminal,   color: "text-lime-400" },
  bash:  { Icon: Terminal,   color: "text-lime-400" },
  xml:   { Icon: FileCode2,  color: "text-orange-300" },
  png:   { Icon: FileImage,  color: "text-fuchsia-400" },
  jpg:   { Icon: FileImage,  color: "text-fuchsia-400" },
  jpeg:  { Icon: FileImage,  color: "text-fuchsia-400" },
  gif:   { Icon: FileImage,  color: "text-fuchsia-400" },
  svg:   { Icon: FileImage,  color: "text-fuchsia-400" },
  ico:   { Icon: FileImage,  color: "text-fuchsia-400" },
  pdf:   { Icon: FileText,   color: "text-red-400" },
  txt:   { Icon: FileText,   color: "text-[var(--ide-muted)]" },
};
const DEFAULT_FILE_ICON = { Icon: FileIcon, color: "text-[var(--ide-muted)]" };
const fileIconFor = (path: string) => FILE_ICON_MAP[extOf(path)] ?? DEFAULT_FILE_ICON;

const parentOf = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/"); // "" = root-level
};

/* ========================================================================== *
 *  NodeList — lazy-loaded children of one folder
 * ========================================================================== */

function NodeList({ parentPath, depth }: { parentPath: string; depth: number }) {
  const { workspaceId, reloadKey } = useTree();
  const [nodes, setNodes] = useState<WsNode[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getChildren(workspaceId, parentPath)
      .then((rows) => !cancelled && setNodes(rows))
      .catch(() => !cancelled && setNodes([]));
    return () => { cancelled = true; };
  }, [workspaceId, parentPath, reloadKey]);

  if (nodes === null)
    return (
      <div
        className="flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--ide-muted)]"
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </div>
    );

  if (nodes.length === 0 && depth === 0)
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--ide-muted)]">
        Empty workspace.
      </div>
    );

  return (
    <>
      {nodes.map((n) => (
        <NodeRow key={n.path} node={n} depth={depth} />
      ))}
    </>
  );
}

/* ========================================================================== *
 *  IndicatorLine — absolute-positioned drop line (NO layout shift)
 *
 *  Uses position:absolute so it overlays the row without pushing siblings,
 *  which was the root cause of the getPos() flicker in the previous version.
 * ========================================================================== */

function IndicatorLine({ depth, at }: { depth: number; at: "top" | "bottom" }) {
  return (
    <div
      className={`absolute ${at === "top" ? "top-0" : "bottom-0"} right-0 h-0.5 bg-violet-500 z-20 pointer-events-none`}
      style={{ left: depth * 12 + 6 }}
    />
  );
}

/* ========================================================================== *
 *  NodeRow — one file or folder row; handles all drag-and-drop for itself
 * ========================================================================== */

function NodeRow({ node, depth }: { node: WsNode; depth: number }) {
  const tree = useTree();
  const {
    activePath, onOpenFile, openMenu, fullBasePath,
    selectedItems, toggleSelect,
    dragItems, startDrag, endDrag,
    dropTarget, setDropTarget, executeDrop,
  } = tree;

  const [expanded, setExpanded] = useState(false);
  const isFolder = node.type === "folder";
  const isActive  = activePath === node.path;
  const isSelected = selectedItems.has(node.path);
  const isDragging = dragItems?.some((d) => d.path === node.path) ?? false;

  /* rowRef points to the 24 px row div, not the outer wrapper that includes
     children.  getPos() always measures this rect, so indicator position is
     computed from the stable row height regardless of children or indicators. */
  const rowRef = useRef<HTMLDivElement>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelExpandTimer = () => {
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  };
  useEffect(() => () => cancelExpandTimer(), []);

  /* ── Position helper ────────────────────────────────────────────────────── */
  const getPos = (clientY: number): "before" | "into" | "after" => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return isFolder ? "into" : "after";
    const pct = (clientY - rect.top) / rect.height;
    if (pct < 0.25) return "before";
    if (isFolder && pct < 0.75) return "into";
    return "after";
  };

  const destFolderFor = (pos: "before" | "into" | "after") =>
    pos === "into" && isFolder ? node.path : parentOf(node.path);

  /* ── Drag start ─────────────────────────────────────────────────────────── */
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();

    const items: DragItem[] =
      isSelected && selectedItems.size > 1
        ? [...selectedItems.entries()].map(([p, f]) => ({ path: p, isFolder: f }))
        : [{ path: node.path, isFolder }];

    e.dataTransfer.setData(EXPLORER_DRAG_MIME, JSON.stringify(items.map((i) => i.path)));
    e.dataTransfer.effectAllowed = "copyMove";

    /* Ghost image: left:-9999px is reliable across all DPI/zoom levels.
       top:-9999px can be off-screen on some displays; left:-9999px is safer. */
    const ghost = document.createElement("div");
    Object.assign(ghost.style, {
      position:     "fixed",
      top:          "0",
      left:         "-9999px",
      background:   "var(--ide-surface, #1e1e2e)",
      border:       "1px solid var(--ide-border, #5b5b7e)",
      borderRadius: "4px",
      padding:      "3px 10px",
      color:        "var(--ide-text, #cdd6f4)",
      fontSize:     "12px",
      fontFamily:   "ui-monospace, monospace",
      pointerEvents:"none",
      whiteSpace:   "nowrap",
      zIndex:       "9999",
    });
    ghost.textContent = items.length > 1 ? `${items.length} items` : baseName(node.path);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 10);
    setTimeout(() => ghost.parentNode?.removeChild(ghost), 0);

    startDrag(items);
  };

  /* ── Drag end ───────────────────────────────────────────────────────────── */
  const handleDragEnd = () => {
    cancelExpandTimer();
    endDrag();
    setDropTarget(null);
  };

  /* ── Drag over ──────────────────────────────────────────────────────────── */
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(EXPLORER_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();

    const pos    = getPos(e.clientY);
    const folder = destFolderFor(pos);

    /* Block self-drop and ancestor → descendant */
    if (dragItems?.some((d) => folder === d.path || folder.startsWith(d.path + "/")))
      return;

    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";

    setDropTarget({
      folder,
      indicatorRow: pos === "into" ? null : node.path,
      pos,
    });

    /* Auto-expand collapsed folder after 600 ms */
    if (isFolder && !expanded && pos === "into") {
      if (!expandTimerRef.current) {
        expandTimerRef.current = setTimeout(() => {
          setExpanded(true);
          expandTimerRef.current = null;
        }, 600);
      }
    } else {
      cancelExpandTimer();
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      cancelExpandTimer();
    }
  };

  /* ── Drop ───────────────────────────────────────────────────────────────── */
  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(EXPLORER_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    cancelExpandTimer();

    const pos    = getPos(e.clientY);
    const folder = destFolderFor(pos);

    executeDrop(folder, e.ctrlKey || e.altKey);
    if (pos === "into" && isFolder) setExpanded(true);
    setDropTarget(null);
  };

  /* ── Visual state ───────────────────────────────────────────────────────── */
  const myPos      = dropTarget?.indicatorRow === node.path ? dropTarget.pos : null;
  const isDropInto = dropTarget?.pos === "into" && dropTarget.folder === node.path;

  const rowBg = isDropInto
    ? "bg-violet-600/30 ring-1 ring-inset ring-violet-500/60"
    : isSelected
      ? "bg-violet-600/20"
      : isActive
        ? "bg-violet-600/25"
        : "hover:bg-[var(--ide-hover)]";

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/*
        ── Row wrapper: position:relative so IndicatorLine can be absolute ──
        This wrapper is ONLY the 24 px row div height — children are OUTSIDE it.
        This is critical: the indicator must not affect the height of the row,
        which would shift getBoundingClientRect() and corrupt getPos().
      */}
      <div className="relative">
        {myPos === "before" && <IndicatorLine depth={depth} at="top" />}

        <div
          ref={rowRef}
          role="treeitem"
          title={fullBasePath ? `${fullBasePath}${fullBasePath.includes("\\") ? "\\" : "/"}${node.path.replace(/\//g, fullBasePath.includes("\\") ? "\\" : "/")}` : `/${node.path}`}
          style={{ paddingLeft: depth * 12 + 6, opacity: isDragging ? 0.4 : 1 }}
          className={[
            "group flex items-center gap-1 h-6 pr-2 cursor-pointer select-none text-[12px] text-[var(--ide-text)]",
            rowBg,
          ].join(" ")}
          onClick={(e) => {
            e.stopPropagation();
            toggleSelect(node.path, isFolder, e.ctrlKey || e.metaKey);
            if (isFolder) setExpanded((p) => !p);
            else onOpenFile(node.path);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e.clientX, e.clientY, node);
          }}
        >
          {isFolder ? (
            expanded
              ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 text-[var(--ide-muted)]" />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ide-muted)]" />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          {isFolder ? (
            expanded
              ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
              : <Folder     className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
          ) : (
            (() => {
              const { Icon, color } = fileIconFor(node.path);
              return <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />;
            })()
          )}

          <span className="truncate">{baseName(node.path)}</span>

          {isDragging && selectedItems.size > 1 && (
            <span className="ml-auto shrink-0 rounded-sm bg-violet-600/60 px-1 text-[10px] text-violet-200">
              {selectedItems.size}
            </span>
          )}
        </div>

        {myPos === "after" && <IndicatorLine depth={depth} at="bottom" />}
      </div>

      {/* Children rendered OUTSIDE the relative wrapper so indicators don't overlap them */}
      {isFolder && expanded && (
        <NodeList parentPath={node.path} depth={depth + 1} />
      )}
    </div>
  );
}

/* ========================================================================== *
 *  InlineInput — rename input with empty-name validation
 * ========================================================================== */

function InlineInput({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);

  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      <input
        ref={ref}
        autoFocus
        value={val}
        onChange={(e) => { setVal(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const err = nameError(val);
            if (err) { setError(err); return; }
            onConfirm(val.trim());
          }
          if (e.key === "Escape") onCancel();
        }}
        className={`h-6 px-1.5 rounded bg-[var(--ide-surface)] text-[12px] text-[var(--ide-text)] focus:outline-none border ${
          error ? "border-red-500" : "border-violet-500"
        }`}
      />
      {error && (
        <p className="text-[10px] text-red-400 leading-none">{error}</p>
      )}
    </div>
  );
}

/* ========================================================================== *
 *  ContextMenu
 * ========================================================================== */

function ContextMenu({
  x, y, node, onClose,
}: {
  x: number;
  y: number;
  node: WsNode | null;
  onClose: () => void;
}) {
  const api = useTree();
  const { workspaceId, refresh } = api;
  const { localPathLabel, fsHandle, workspaceName } = useWorkspace();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const parentForNew =
    !node ? "" : node.type === "folder" ? node.path : node.parentPath;

  const create = async (type: "file" | "folder") => {
    const name = window.prompt(`New ${type} name:`);
    if (name == null) return onClose();
    const err = nameError(name);
    if (err) { toast("error", err); return onClose(); }
    const trimmed = name.trim();
    const siblings = await getChildren(workspaceId, parentForNew).catch(() => []);
    if (siblings.some((s) => baseName(s.path) === trimmed)) {
      toast("error", `"${trimmed}" already exists in this folder.`);
      return onClose();
    }
    const path = parentForNew ? `${parentForNew}/${trimmed}` : trimmed;
    setBusy(true);
    try {
      await createFile(workspaceId, path, type);
      await enqueueOutbox(workspaceId, { op: "create", path, payload: { type } }).catch(() => {});
      refresh();
    } catch (e) {
      toast("error", `Create failed: ${describeError(e)}`);
    } finally { setBusy(false); onClose(); }
  };

  const doRename = async (next: string) => {
    if (!node) return onClose();
    const newPath = node.parentPath ? `${node.parentPath}/${next}` : next;
    if (newPath === node.path) return onClose();
    const siblings = await getChildren(workspaceId, node.parentPath).catch(() => []);
    if (siblings.some((s) => s.path !== node.path && baseName(s.path) === next)) {
      toast("error", `"${next}" already exists in this folder.`);
      return onClose();
    }
    setBusy(true);
    try {
      if (node.type === "folder") {
        await renameFolder(workspaceId, node.path, newPath);
        api.onRenameFolder?.(node.path, newPath);
      } else {
        await renameFile(workspaceId, node.path, newPath);
        api.onRenameFile?.(node.path, newPath);
      }
      await enqueueOutbox(workspaceId, {
        op: "rename",
        path: node.path,
        payload: { newPath, type: node.type },
      }).catch(() => {});
      refresh();
    } catch (e) {
      toast("error", `Rename failed: ${describeError(e)}`);
    } finally { setBusy(false); onClose(); }
  };

  /* Move a file/folder to a different folder (keyboard/menu alternative to
     drag-and-drop). Move === rename to a new parent, so it reuses the same
     rename plumbing + outbox op the drag path uses. */
  const doMove = async () => {
    if (!node) return onClose();
    const raw = window.prompt(
      `Move "${baseName(node.path)}" to folder (relative path, blank = workspace root):`,
      node.parentPath,
    );
    if (raw == null) return onClose();
    const destFolder = raw.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
    const newPath = destFolder ? `${destFolder}/${baseName(node.path)}` : baseName(node.path);

    if (newPath === node.path) return onClose();
    if (node.type === "folder" && (newPath === node.path || newPath.startsWith(node.path + "/"))) {
      toast("error", "Can't move a folder into itself.");
      return onClose();
    }
    const dest = await getChildren(workspaceId, destFolder).catch(() => []);
    if (dest.some((s) => baseName(s.path) === baseName(node.path))) {
      toast("error", `"${baseName(node.path)}" already exists in that folder.`);
      return onClose();
    }
    setBusy(true);
    try {
      if (node.type === "folder") {
        await renameFolder(workspaceId, node.path, newPath);
        api.onRenameFolder?.(node.path, newPath);
        await enqueueOutbox(workspaceId, { op: "rename", path: node.path, payload: { newPath, type: "folder" } }).catch(() => {});
      } else {
        await renameFile(workspaceId, node.path, newPath);
        api.onRenameFile?.(node.path, newPath);
        await enqueueOutbox(workspaceId, { op: "rename", path: node.path, payload: { newPath, type: "file" } }).catch(() => {});
      }
      refresh();
    } catch (e) {
      toast("error", `Move failed: ${describeError(e)}`);
    } finally { setBusy(false); onClose(); }
  };

  const del = async () => {
    if (!node) return onClose();
    const label =
      node.type === "folder"
        ? `folder "${baseName(node.path)}" and all its contents`
        : `"${baseName(node.path)}"`;
    if (!window.confirm(`Delete ${label}? Files can be recovered from Trash.`))
      return onClose();
    setBusy(true);
    try {
      await deleteFile(workspaceId, node.path);
      await enqueueOutbox(workspaceId, { op: "delete", path: node.path, payload: { type: node.type } }).catch(() => {});
      if (node.type === "folder") api.onCloseTabsUnder?.(node.path);
      else api.onCloseFile?.(node.path);
      refresh();
    } catch (e) {
      toast("error", `Delete failed: ${describeError(e)}`);
    } finally { setBusy(false); onClose(); }
  };

  const Item = ({
    icon, label, onClick, disabled,
  }: {
    icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className="flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] disabled:opacity-40 text-left"
    >
      {icon} {label}
    </button>
  );

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[200]"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        className="fixed z-[201] w-48 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] py-1 shadow-xl"
        style={{ left: x, top: y }}
      >
        <Item icon={<FilePlus2  className="h-3.5 w-3.5" />} label="New File"   onClick={() => create("file")} />
        <Item icon={<FolderPlus className="h-3.5 w-3.5" />} label="New Folder" onClick={() => create("folder")} />
        {node && !renaming && (
          <Item icon={<Pencil className="h-3.5 w-3.5" />} label="Rename" onClick={() => setRenaming(true)} />
        )}
        {node && renaming && (
          <InlineInput initial={baseName(node.path)} onConfirm={doRename} onCancel={onClose} />
        )}
        {node && !renaming && (
          <Item icon={<FolderInput className="h-3.5 w-3.5" />} label="Move to…" onClick={doMove} />
        )}
        {node && (
          <Item icon={<Trash2 className="h-3.5 w-3.5 text-red-400" />} label="Delete" onClick={del} />
        )}
        {node && (
          <>
            <div className="my-1 border-t border-[var(--ide-border)]" />
            <Item
              icon={<Clipboard className="h-3.5 w-3.5" />}
              label="Copy Path"
              onClick={() => {
                // Strip stray wrapping quotes (e.g. pasted from Windows' "Copy as path"),
                // which otherwise breaks the isFullPath check below.
                const root = (localPathLabel || fsHandle?.name || workspaceName || "")
                  .replace(/^["']+|["']+$/g, "")
                  .trim()
                  .replace(/[\\/]+$/, "");
                const isFullPath = /^[A-Za-z]:[\\/]|^\//.test(root);
                if (!isFullPath) {
                  // No full path set yet — copy the relative path and point to the
                  // one place to set the full one (the folder chip in the top bar),
                  // rather than duplicating that flow here with a native prompt.
                  navigator.clipboard.writeText(node.path);
                  toast("info", "Copied relative path. Set the full local path via the folder chip in the top bar to copy full paths.");
                  onClose();
                  return;
                }
                const sep = root.includes("\\") ? "\\" : "/";
                const full = `${root}${sep}${node.path.replace(/\//g, sep)}`;
                navigator.clipboard.writeText(full);
                onClose();
              }}
            />
            <Item
              icon={<ClipboardCopy className="h-3.5 w-3.5" />}
              label="Copy Relative Path"
              onClick={() => { navigator.clipboard.writeText(node.path); onClose(); }}
            />
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

/* ========================================================================== *
 *  ExplorerTree — root
 * ========================================================================== */

export function ExplorerTree({
  workspaceId,
  activePath,
  onOpenFile,
  onCloseFile,
  onCloseTabsUnder,
  onRenameFile,
  onRenameFolder,
  externalRevision = 0,
  fullBasePath: fullBasePathProp,
}: {
  workspaceId: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onCloseFile?: (path: string) => void;
  onCloseTabsUnder?: (prefix: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onRenameFolder?: (oldPath: string, newPath: string) => void;
  externalRevision?: number;
  fullBasePath?: string;
}) {
  const { localPathLabel, fsHandle, workspaceName } = useWorkspace();
  const resolvedBasePath = fullBasePathProp ?? localPathLabel ?? fsHandle?.name ?? workspaceName ?? "";
  const { toast } = useToast();

  const [internalKey, setInternalKey] = useState(0);
  const reloadKey = internalKey + externalRevision;

  const [menu, setMenu] = useState<{ x: number; y: number; node: WsNode | null } | null>(null);

  /* ── Selection ─────────────────────────────────────────────────────────── */
  const [selectedItems, setSelectedItems] = useState<Map<string, boolean>>(new Map());

  const toggleSelect = useCallback(
    (path: string, isFolder: boolean, multi: boolean) => {
      setSelectedItems((prev) => {
        if (multi) {
          const next = new Map(prev);
          if (next.has(path)) next.delete(path);
          else next.set(path, isFolder);
          return next;
        }
        if (prev.size === 1 && prev.has(path)) return prev;
        return new Map([[path, isFolder]]);
      });
    },
    [],
  );

  const clearSelection = useCallback(() => setSelectedItems(new Map()), []);

  /* ── Drag items (ref-backed to avoid stale closures in executeDrop) ──────── */
  const [dragItems, setDragItemsState] = useState<DragItem[] | null>(null);
  const dragItemsRef = useRef<DragItem[] | null>(null);

  const startDrag = useCallback((items: DragItem[]) => {
    setDragItemsState(items);
    dragItemsRef.current = items;
  }, []);

  const endDrag = useCallback(() => {
    setDragItemsState(null);
    dragItemsRef.current = null;
  }, []);

  /* ── Drop target (ref-guarded to skip no-op setState calls) ─────────────── */
  const [dropTarget, _setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

  const setDropTarget = useCallback((t: DropTarget | null) => {
    const prev = dropTargetRef.current;
    if (
      prev?.folder       === t?.folder &&
      prev?.indicatorRow === t?.indicatorRow &&
      prev?.pos          === t?.pos
    ) return; // nothing changed — skip re-render
    dropTargetRef.current = t;
    _setDropTarget(t);
  }, []);

  /* ── Execute the drop ───────────────────────────────────────────────────── */
  const executeDrop = useCallback(
    async (destFolder: string, copy: boolean) => {
      const items = dragItemsRef.current;
      if (!items?.length) return;
      try {
        for (const { path: srcPath, isFolder: srcIsFolder } of items) {
          const name    = baseName(srcPath);
          const newPath = destFolder ? `${destFolder}/${name}` : name;
          if (newPath === srcPath) continue;
          if (srcIsFolder && newPath.startsWith(srcPath + "/")) continue;

          if (srcIsFolder) {
            await renameFolder(workspaceId, srcPath, newPath);
            onRenameFolder?.(srcPath, newPath);
            await enqueueOutbox(workspaceId, {
              op: "rename",
              path: srcPath,
              payload: { newPath, type: "folder" },
            }).catch(() => {});
          } else if (copy) {
            const { content } = await fetchFileContent(workspaceId, srcPath);
            await createFile(workspaceId, newPath, "file", content);
            await enqueueOutbox(workspaceId, { op: "create", path: newPath, payload: { type: "file" } }).catch(() => {});
          } else {
            await renameFile(workspaceId, srcPath, newPath);
            onRenameFile?.(srcPath, newPath);
            await enqueueOutbox(workspaceId, {
              op: "rename",
              path: srcPath,
              payload: { newPath, type: "file" },
            }).catch(() => {});
          }
        }
      } catch (e) {
        toast("error", `Operation failed: ${describeError(e)}`);
      } finally {
        setInternalKey((k) => k + 1);
      }
    },
    [workspaceId, onRenameFile, onRenameFolder, toast],
  );

  const refresh  = useCallback(() => setInternalKey((k) => k + 1), []);
  const openMenu = useCallback(
    (x: number, y: number, node: WsNode | null) => setMenu({ x, y, node }),
    [],
  );

  /* ── Context ─────────────────────────────────────────────────────────────── */
  const api: TreeApi = {
    workspaceId, activePath, reloadKey, fullBasePath: resolvedBasePath, onOpenFile,
    onCloseFile, onCloseTabsUnder, onRenameFile, onRenameFolder,
    refresh, openMenu,
    selectedItems, toggleSelect, clearSelection,
    dragItems, startDrag, endDrag,
    dropTarget, setDropTarget, executeDrop,
  };

  /* Root drop zone: highlighted subtly when drag target is the workspace root */
  const rootIsTarget = dropTarget?.folder === "" && dropTarget?.indicatorRow === null;

  return (
    <TreeCtx.Provider value={api}>
      <div
        className={`h-full overflow-auto py-1 transition-colors ${
          rootIsTarget ? "bg-violet-600/10 ring-1 ring-inset ring-violet-500/30" : ""
        }`}
        onClick={() => clearSelection()}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            openMenu(e.clientX, e.clientY, null);
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(EXPLORER_DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
          setDropTarget({ folder: "", indicatorRow: null, pos: "into" });
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDropTarget(null);
          }
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(EXPLORER_DRAG_MIME)) return;
          e.preventDefault();
          executeDrop("", e.ctrlKey || e.altKey);
          setDropTarget(null);
        }}
      >
        <NodeList parentPath="" depth={0} />
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          onClose={() => setMenu(null)}
        />
      )}
    </TreeCtx.Provider>
  );
}

export default ExplorerTree;
