"use client";

/**
 * EditorTabs — VS Code-style tab strip with drag-and-drop.
 *
 * Supports:
 *  - Tab reordering: drag a tab left/right, vertical indicator shows insert position
 *  - Explorer → tab drop: dragging a file from the Explorer tree opens it
 *  - Middle-click to close
 *  - Active highlight, dirty dot
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, FileCode2, Circle } from "lucide-react";
import type { WsTab } from "@/lib/db/workspaceStore";
import { EXPLORER_DRAG_MIME } from "@/components/ide/ExplorerTree";

/* ========================================================================== *
 *  TabContextMenu — Close / Close Others / Close All
 * ========================================================================== */
function TabContextMenu({
  x, y, path, hasOthers, onClose, onCloseTab, onCloseOthers, onCloseAll,
}: {
  x: number;
  y: number;
  path: string;
  /** False when this is the only open tab — Close Others has nothing to do. */
  hasOthers: boolean;
  onClose: () => void;
  onCloseTab: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
}) {
  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-[201] w-44 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] py-1 shadow-xl"
        style={{ left: x, top: y }}
      >
        <button
          type="button"
          onClick={() => { onClose(); onCloseTab(path); }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] text-left"
        >
          <X className="h-3.5 w-3.5" /> Close
        </button>
        <button
          type="button"
          disabled={!hasOthers}
          onClick={() => { onClose(); onCloseOthers(path); }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed text-left"
        >
          <X className="h-3.5 w-3.5" /> Close Others
        </button>
        <button
          type="button"
          onClick={() => { onClose(); onCloseAll(); }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] text-left"
        >
          <X className="h-3.5 w-3.5" /> Close All
        </button>
      </div>
    </>,
    document.body,
  );
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const extOf = (p: string) => p.split(".").pop()?.toLowerCase() ?? "";

const LANG_COLORS: Record<string, { accent: string; bg: string }> = {
  py:    { accent: "text-sky-400",    bg: "bg-sky-500/10" },
  ts:    { accent: "text-blue-400",   bg: "bg-blue-500/10" },
  tsx:   { accent: "text-cyan-400",   bg: "bg-cyan-500/10" },
  js:    { accent: "text-yellow-400", bg: "bg-yellow-500/10" },
  jsx:   { accent: "text-amber-400",  bg: "bg-amber-500/10" },
  java:  { accent: "text-orange-400", bg: "bg-orange-500/10" },
  go:    { accent: "text-teal-400",   bg: "bg-teal-500/10" },
  rs:    { accent: "text-rose-400",   bg: "bg-rose-500/10" },
  rb:    { accent: "text-red-400",    bg: "bg-red-500/10" },
  html:  { accent: "text-orange-400", bg: "bg-orange-500/10" },
  css:   { accent: "text-pink-400",   bg: "bg-pink-500/10" },
  scss:  { accent: "text-pink-400",   bg: "bg-pink-500/10" },
  json:  { accent: "text-emerald-400",bg: "bg-emerald-500/10" },
  yml:   { accent: "text-purple-400", bg: "bg-purple-500/10" },
  yaml:  { accent: "text-purple-400", bg: "bg-purple-500/10" },
  md:    { accent: "text-slate-400",  bg: "bg-slate-500/10" },
  sql:   { accent: "text-indigo-400", bg: "bg-indigo-500/10" },
  sh:    { accent: "text-lime-400",   bg: "bg-lime-500/10" },
  cs:    { accent: "text-green-400",  bg: "bg-green-500/10" },
  php:   { accent: "text-violet-400", bg: "bg-violet-500/10" },
};
const DEFAULT_COLOR = { accent: "text-[var(--ide-muted)]", bg: "bg-[var(--ide-surface-2)]" };
const langColor = (path: string) => LANG_COLORS[extOf(path)] ?? DEFAULT_COLOR;

const TAB_DRAG_MIME = "application/vnd.devaccel.tab";

interface DropState {
  targetPath: string;
  side: "before" | "after";
}

/* ========================================================================== *
 *  EditorTabs
 * ========================================================================== */
export function EditorTabs({
  tabs,
  activePath,
  dirtyPaths,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onReorder,
  onOpenFile,
}: {
  tabs: WsTab[];
  activePath: string | null;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers?: (path: string) => void;
  onCloseAll?: () => void;
  onReorder?: (fromPath: string, targetPath: string, side: "before" | "after") => void;
  onOpenFile?: (path: string) => void;
}) {
  const [dropState, _setDropState] = useState<DropState | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const dropStateRef = useRef<DropState | null>(null);

  // Sliding pill indicator
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  // Ref-guarded setter — avoids re-renders when nothing changed
  const setDropState = useCallback((s: DropState | null) => {
    const prev = dropStateRef.current;
    if (prev?.targetPath === s?.targetPath && prev?.side === s?.side) return;
    dropStateRef.current = s;
    _setDropState(s);
  }, []);

  const clearDropState = useCallback(() => {
    if (dropStateRef.current === null) return;
    dropStateRef.current = null;
    _setDropState(null);
  }, []);

  // ── Tab drag handlers ────────────────────────────────────────────────────

  const handleTabDragStart = useCallback(
    (path: string, e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(TAB_DRAG_MIME, path);
    },
    [],
  );

  const handleTabDragOver = useCallback(
    (path: string, e: React.DragEvent<HTMLDivElement>) => {
      const isTab  = e.dataTransfer.types.includes(TAB_DRAG_MIME);
      const isFile = e.dataTransfer.types.includes(EXPLORER_DRAG_MIME);
      if (!isTab && !isFile) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isTab ? "move" : "copy";
      if (isTab) {
        const rect = e.currentTarget.getBoundingClientRect();
        const side: "before" | "after" =
          e.clientX < rect.left + rect.width / 2 ? "before" : "after";
        setDropState({ targetPath: path, side });
      }
    },
    [setDropState],
  );

  const handleTabDrop = useCallback(
    (path: string, e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation(); // don't bubble to strip handler
      clearDropState();

      const tabFrom = e.dataTransfer.getData(TAB_DRAG_MIME);
      if (tabFrom) {
        if (tabFrom !== path) {
          const rect = e.currentTarget.getBoundingClientRect();
          const side: "before" | "after" =
            e.clientX < rect.left + rect.width / 2 ? "before" : "after";
          onReorder?.(tabFrom, path, side);
        }
        return;
      }

      // Explorer file drop onto an existing tab → open the file(s)
      const rawPaths = e.dataTransfer.getData(EXPLORER_DRAG_MIME);
      if (rawPaths) {
        try {
          (JSON.parse(rawPaths) as string[]).forEach((p) => onOpenFile?.(p));
        } catch {
          onOpenFile?.(rawPaths);
        }
      }
    },
    [clearDropState, onReorder, onOpenFile],
  );

  // ── Strip-level handlers (drops on empty tab-bar space) ──────────────────

  const handleStripDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(EXPLORER_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleStripDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      clearDropState();
      const rawPaths = e.dataTransfer.getData(EXPLORER_DRAG_MIME);
      if (!rawPaths) return;
      try {
        (JSON.parse(rawPaths) as string[]).forEach((p) => onOpenFile?.(p));
      } catch {
        onOpenFile?.(rawPaths);
      }
    },
    [clearDropState, onOpenFile],
  );

  // Measure sliding pill position whenever active tab changes
  useEffect(() => {
    if (!activePath || !containerRef.current) { setPill(null); return; }
    const el = tabRefs.current.get(activePath);
    if (!el) { setPill(null); return; }
    const cRect = containerRef.current.getBoundingClientRect();
    const tRect = el.getBoundingClientRect();
    setPill({
      left: tRect.left - cRect.left + containerRef.current.scrollLeft,
      width: tRect.width,
    });
  }, [activePath, tabs]);

  return (
    <div
      ref={containerRef}
      className="relative flex items-center h-9 shrink-0 px-1 gap-1 bg-[var(--ide-surface)] overflow-x-auto"
      onDragOver={handleStripDragOver}
      onDrop={handleStripDrop}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          clearDropState();
        }
      }}
    >
      {/* Sliding pill indicator */}
      {pill && (
        <div
          className="absolute top-1 bottom-1 rounded-lg pointer-events-none z-0 ide-tab-pill"
          style={{
            left: pill.left,
            width: pill.width,
            background: 'linear-gradient(135deg, rgba(124,58,237,0.18), rgba(79,70,229,0.13))',
            border: '1px solid rgba(124,58,237,0.25)',
            boxShadow: '0 0 10px rgba(124,58,237,0.08)',
          }}
        />
      )}
      {tabs.map((t) => {
        const active = t.path === activePath;
        const dirty  = dirtyPaths.has(t.path);
        const ds     = dropState;
        const showBefore = ds?.targetPath === t.path && ds.side === "before";
        const showAfter  = ds?.targetPath === t.path && ds.side === "after";
        const lc = langColor(t.path);

        return (
          <div
            key={t.path}
            ref={(el) => { if (el) tabRefs.current.set(t.path, el); else tabRefs.current.delete(t.path); }}
            className="relative shrink-0 z-[1]"
            draggable
            onDragStart={(e) => handleTabDragStart(t.path, e)}
            onDragEnd={clearDropState}
            onDragOver={(e) => handleTabDragOver(t.path, e)}
            onDrop={(e) => handleTabDrop(t.path, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabMenu({ x: e.clientX, y: e.clientY, path: t.path });
            }}
          >
            {showBefore && (
              <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-violet-500 z-20 pointer-events-none" />
            )}
            {showAfter && (
              <div className="absolute right-0 top-1 bottom-1 w-0.5 rounded-full bg-violet-500 z-20 pointer-events-none" />
            )}

            <div
              onClick={() => onSelect(t.path)}
              onMouseDown={(e) => e.button === 1 && onClose(t.path)}
              title={`/${t.path}`}
              className={`group flex items-center gap-1.5 px-3 max-w-[200px] h-7 cursor-pointer rounded-lg text-[12px] select-none transition-all duration-150 ${
                active
                  ? "text-[var(--ide-text)]"
                  : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)]"
              }`}
            >
              <FileCode2 className={`h-3.5 w-3.5 shrink-0 ${active ? lc.accent : "text-[var(--ide-muted)]"}`} />
              <span className="truncate">{baseName(t.path)}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.path);
                }}
                className="ml-0.5 shrink-0 rounded-full p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--ide-hover)] transition-opacity"
                title="Close"
              >
                {dirty ? (
                  <Circle className="h-2.5 w-2.5 fill-current text-amber-400" />
                ) : (
                  <X className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>
        );
      })}

      {tabMenu && (
        <TabContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          path={tabMenu.path}
          hasOthers={tabs.length > 1}
          onClose={() => setTabMenu(null)}
          onCloseTab={onClose}
          onCloseOthers={(path) => onCloseOthers?.(path)}
          onCloseAll={() => onCloseAll?.()}
        />
      )}
    </div>
  );
}

export default EditorTabs;
