"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, FileCode2, ChevronRight, X } from "lucide-react";
import { getAllNodes, type WsNode, type WsTab } from "@/lib/db/workspaceStore";

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const dirName = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

/* ── Command palette entries ──────────────────────────────────────────── */
const COMMANDS = [
  { id: "toggle-explorer",  label: "View: Toggle Primary Sidebar",   hint: "Ctrl+B",     category: "View"        },
  { id: "toggle-chat",      label: "View: Toggle Secondary Sidebar", hint: "Ctrl+Alt+B", category: "View"        },
  { id: "toggle-theme",     label: "Preferences: Toggle Color Theme",hint: "",            category: "Preferences" },
  { id: "toggle-split",     label: "View: Toggle Split Editor",     hint: "Ctrl+\\",    category: "View"        },
  { id: "layout-default",   label: "Layout: Default",               hint: "",            category: "Layout"      },
  { id: "layout-editor",    label: "Layout: Editor Only",           hint: "",            category: "Layout"      },
  { id: "layout-code-chat", label: "Layout: Code + Chat",           hint: "",            category: "Layout"      },
  { id: "layout-sidebar",   label: "Layout: Sidebar + Code",        hint: "",            category: "Layout"      },
  { id: "layout-all",       label: "Layout: All Panels",            hint: "",            category: "Layout"      },
] as const;

type ResultItem =
  | { kind: "file"; path: string; name: string; dir: string }
  | { kind: "command"; id: string; label: string; hint: string; category: string };

/* ====================================================================== *
 *  QuickAccess — VS Code-style Ctrl+P / Command Palette
 * ====================================================================== */
export function QuickAccess({
  open,
  onClose,
  workspaceId,
  tabs,
  onOpenFile,
  onCommand,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: number;
  tabs: WsTab[];
  onOpenFile: (path: string) => void;
  onCommand: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [nodes, setNodes] = useState<WsNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load workspace files when opened
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    let cancelled = false;
    getAllNodes(workspaceId)
      .then((rows) => !cancelled && setNodes(rows))
      .catch(() => !cancelled && setNodes([]));
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => { cancelled = true; };
  }, [open, workspaceId]);

  // Derive mode & search term
  const isCommandMode = query.startsWith(">");
  const searchTerm = (isCommandMode ? query.slice(1) : query).trim().toLowerCase();

  // Build filtered results
  const results: ResultItem[] = useMemo(() => {
    if (isCommandMode) {
      return COMMANDS
        .filter((c) => !searchTerm || c.label.toLowerCase().includes(searchTerm))
        .map((c) => ({ kind: "command" as const, id: c.id, label: c.label, hint: c.hint, category: c.category }));
    }

    const files = nodes.filter((n) => n.type === "file");

    if (!searchTerm) {
      // No query: show open tabs first, then recent files
      const tabPaths = new Set(tabs.map((t) => t.path));
      const tabFiles = files.filter((f) => tabPaths.has(f.path));
      const otherFiles = files.filter((f) => !tabPaths.has(f.path));
      return [...tabFiles, ...otherFiles]
        .slice(0, 50)
        .map((f) => ({ kind: "file" as const, path: f.path, name: baseName(f.path), dir: dirName(f.path) }));
    }

    // Prioritize filename matches over full-path matches
    const nameMatches: WsNode[] = [];
    const pathMatches: WsNode[] = [];
    for (const f of files) {
      if (baseName(f.path).toLowerCase().includes(searchTerm)) {
        nameMatches.push(f);
      } else if (f.path.toLowerCase().includes(searchTerm)) {
        pathMatches.push(f);
      }
    }
    return [...nameMatches, ...pathMatches]
      .slice(0, 50)
      .map((f) => ({ kind: "file" as const, path: f.path, name: baseName(f.path), dir: dirName(f.path) }));
  }, [isCommandMode, searchTerm, nodes, tabs]);

  // Reset selection when results change
  useEffect(() => { setSelectedIndex(0); }, [results.length, searchTerm]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const executeItem = useCallback(
    (item: ResultItem) => {
      if (item.kind === "file") onOpenFile(item.path);
      else onCommand(item.id);
      onClose();
    },
    [onOpenFile, onCommand, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) executeItem(results[selectedIndex]);
          break;
      }
    },
    [onClose, results, selectedIndex, executeItem],
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop — covers the full viewport for click-to-close */}
      <div className="fixed inset-0 z-[100] bg-black/20" onClick={onClose} />

      {/* Panel — fixed to viewport, centered horizontally, below TopBar */}
      <div className="fixed left-1/2 top-[56px] z-[101] -translate-x-1/2 w-[560px] max-w-[calc(100%-32px)] rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* Input row */}
        <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--ide-border)]">
          <Search className="h-4 w-4 text-[var(--ide-muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isCommandMode ? "Type a command…" : "Search files by name (type > for commands)"}
            className="flex-1 bg-transparent text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-[var(--ide-muted)]">
              {isCommandMode ? "No matching commands" : "No files found"}
            </p>
          ) : (
            results.map((item, idx) => {
              const selected = idx === selectedIndex;
              if (item.kind === "file") {
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                      selected ? "bg-violet-600/20" : "hover:bg-[var(--ide-hover)]"
                    }`}
                  >
                    <FileCode2 className="h-4 w-4 shrink-0 text-[var(--ide-muted)]" />
                    <span className="text-sm truncate font-medium text-[var(--ide-text)]">{item.name}</span>
                    {item.dir && (
                      <span className="text-xs text-[var(--ide-muted)] truncate ml-auto shrink-0 max-w-[45%] text-right">
                        {item.dir}
                      </span>
                    )}
                  </button>
                );
              }
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => executeItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                    selected ? "bg-violet-600/20" : "hover:bg-[var(--ide-hover)]"
                  }`}
                >
                  <ChevronRight className="h-4 w-4 shrink-0 text-violet-400" />
                  <span className="text-sm truncate text-[var(--ide-text)]">{item.label}</span>
                  {item.hint && (
                    <kbd className="shrink-0 text-[10px] px-1.5 py-px rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] text-[var(--ide-muted)] font-mono ml-auto">
                      {item.hint}
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 px-3 py-1.5 border-t border-[var(--ide-border)] text-[10px] text-[var(--ide-muted)]">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>esc Close</span>
          {!isCommandMode && <span className="ml-auto">Type <kbd className="px-1 rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] font-mono">{">"}</kbd> for commands</span>}
        </div>
      </div>
    </>
  );
}

export default QuickAccess;
