"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { LegacyTab } from "@/types/legacy-modernization";
import {
  X, FileCode, Code2, Save, Circle, Folder, Sparkles, Terminal,
  Keyboard, Pin, Map, Copy, GitCompareArrows,
  ArrowLeftRight, Eye, Code, Loader2,
} from "lucide-react";
import dynamic from "next/dynamic";

// Dynamic import of Monaco to avoid SSR issues
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
      <Code2 className="w-6 h-6 animate-pulse mr-2" />
      Loading editor...
    </div>
  ),
});

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
        <GitCompareArrows className="w-6 h-6 animate-pulse mr-2" />
        Loading diff viewer...
      </div>
    ),
  }
);

const MermaidViewer = dynamic(() => import("./MermaidViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
      <Eye className="w-6 h-6 animate-pulse mr-2" />
      Loading diagram viewer...
    </div>
  ),
});

const DependencyGraphViewer = dynamic(() => import("./DependencyGraphViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
      <Code2 className="w-6 h-6 animate-pulse mr-2" />
      Loading graph viewer...
    </div>
  ),
});

const MarkdownViewer = dynamic(() => import("./MarkdownViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
      <Eye className="w-6 h-6 animate-pulse mr-2" />
      Loading markdown viewer...
    </div>
  ),
});

// ── Tab Context Menu ────────────────────────────────────────────────────

interface TabContextMenuProps {
  x: number;
  y: number;
  tab: LegacyTab;
  tabs: LegacyTab[];
  onClose: () => void;
  onCloseTab: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  onTogglePin: (path: string) => void;
  onCopyPath: (path: string) => void;
  onCompareWith: (path: string, otherPath: string) => void;
  onExitDiff: (path: string) => void;
}

function TabContextMenu({
  x, y, tab, tabs, onClose, onCloseTab, onCloseOthers,
  onCloseAll, onTogglePin, onCopyPath, onCompareWith, onExitDiff,
}: TabContextMenuProps) {
  const [showCompareSubmenu, setShowCompareSubmenu] = useState(false);
  const otherTabs = tabs.filter((t) => t.path !== tab.path);

  useEffect(() => {
    const handleClick = () => onClose();
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 min-w-[180px] py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md cbv2-card-elevated cbv2-animate-scale-in"
        style={{ left: x, top: y }}
      >
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { onClose(); onCloseTab(tab.path); }}>
          <X className="w-3.5 h-3.5" /> Close
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { onClose(); onCloseOthers(tab.path); }}>
          <X className="w-3.5 h-3.5" /> Close Others
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { onClose(); onCloseAll(); }}>
          <X className="w-3.5 h-3.5" /> Close All
        </button>
        <div className="my-1 border-t border-cbv2-border" />
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { onClose(); onTogglePin(tab.path); }}>
          <Pin className="w-3.5 h-3.5" /> {tab.isPinned ? "Unpin" : "Pin Tab"}
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { onClose(); onCopyPath(tab.path); }}>
          <Copy className="w-3.5 h-3.5" /> Copy Path
        </button>
        {tab.diffOriginalContent != null ? (
          <>
            <div className="my-1 border-t border-cbv2-border" />
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => { onClose(); onExitDiff(tab.path); }}>
              <FileCode className="w-3.5 h-3.5" /> Exit Diff View
            </button>
          </>
        ) : otherTabs.length > 0 ? (
          <>
            <div className="my-1 border-t border-cbv2-border" />
            <div className="relative">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors"
                onClick={(e) => { e.stopPropagation(); setShowCompareSubmenu((v) => !v); }}
              >
                <ArrowLeftRight className="w-3.5 h-3.5" /> Compare with…
              </button>
              {showCompareSubmenu && (
                <div className="ml-2 mt-0.5 py-1 bg-cbv2-sidebar border border-cbv2-border rounded-md cbv2-card-elevated max-h-[200px] overflow-y-auto cbv2-scrollbar">
                  {otherTabs.map((other) => (
                    <button
                      key={other.path}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left text-cbv2-text hover:bg-cbv2-hover transition-colors truncate"
                      onClick={() => { onClose(); onCompareWith(tab.path, other.path); }}
                    >
                      <FileCode className="w-3 h-3 flex-shrink-0 text-cbv2-accent" />
                      <span className="truncate">{other.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

// ── Tab Bar ─────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: LegacyTab[];
  activeTab: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  onTogglePin: (path: string) => void;
  onCompareWith: (path: string, otherPath: string) => void;
  onExitDiff: (path: string) => void;
}

function TabBar({
  tabs, activeTab, onTabClick, onTabClose, onCloseOthers,
  onCloseAll, onTogglePin, onCompareWith, onExitDiff,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tab: LegacyTab } | null>(null);

  if (tabs.length === 0) return null;

  // Sort: pinned tabs first, then unpinned in original order
  const sortedTabs = [...tabs].sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return 0;
  });

  const handleCopyPath = (path: string) => {
    navigator.clipboard.writeText(path.replace(/^repo:/, "")).catch(() => {});
  };

  return (
    <>
      <div className="flex bg-cbv2-tab border-b border-cbv2-border overflow-x-auto cbv2-scrollbar-none">
        {sortedTabs.map((tab) => {
          const isActive = tab.path === activeTab;
          return (
            <div
              key={tab.path}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-[12px] border-r border-cbv2-border min-w-0 group transition-all duration-150 relative",
                tab.isPinned ? "max-w-[120px]" : "max-w-[200px]",
                isActive
                  ? "bg-cbv2-tab-active text-cbv2-text font-medium"
                  : "text-cbv2-text-dim hover:bg-cbv2-hover hover:text-cbv2-text",
              ].join(" ")}
              onClick={() => onTabClick(tab.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tab });
              }}
            >
              {isActive && (
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-cbv2-accent" />
              )}
              {tab.isPinned && (
                <Pin className="w-2.5 h-2.5 flex-shrink-0 text-cbv2-accent rotate-45" />
              )}
              {tab.diffOriginalContent != null ? (
                <ArrowLeftRight className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-orange-400" : "text-orange-400/60"}`} />
              ) : (
                <FileCode className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-cbv2-accent" : ""}`} />
              )}
              <span className="truncate">{tab.diffOriginalContent != null ? `↔ ${tab.name}` : tab.name}</span>
              {tab.isDirty ? (
                <Circle className="w-2.5 h-2.5 flex-shrink-0 fill-cbv2-accent text-cbv2-accent ml-auto animate-pulse" />
              ) : !tab.isPinned ? (
                <button
                  className={[
                    "ml-auto flex-shrink-0 rounded p-0.5 hover:bg-white/10 transition-all",
                    isActive ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
                  ].join(" ")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.path);
                  }}
                >
                  <X className="w-3 h-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tab={contextMenu.tab}
          tabs={tabs}
          onClose={() => setContextMenu(null)}
          onCloseTab={onTabClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onTogglePin={onTogglePin}
          onCopyPath={handleCopyPath}
          onCompareWith={onCompareWith}
          onExitDiff={onExitDiff}
        />
      )}
    </>
  );
}

// ── Breadcrumb ──────────────────────────────────────────────────────────

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate?: (folderPath: string) => void }) {
  const parts = path.split("/");
  const visibleParts = parts.length > 4
    ? [parts[0], "...", ...parts.slice(-2)]
    : parts;
  const hiddenCount = Math.max(0, parts.length - visibleParts.length + (visibleParts.includes("...") ? 1 : 0));

  const folderPathForVisibleIndex = (visibleIndex: number) => {
    if (parts.length <= 4) return parts.slice(0, visibleIndex + 1).join("/");
    if (visibleIndex === 0) return parts[0];
    if (visibleParts[visibleIndex] === "...") return "";
    const originalIndex = parts.length - (visibleParts.length - visibleIndex);
    return parts.slice(0, originalIndex + 1).join("/");
  };

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden px-4 py-1.5 bg-cbv2-editor text-[11px] text-cbv2-text-dim" title={path}>
      {visibleParts.map((part, i) => {
        const isEllipsis = part === "...";
        const isLast = i === visibleParts.length - 1;
        const folderPath = folderPathForVisibleIndex(i);
        return (
          <React.Fragment key={`${part}-${i}`}>
            {i > 0 && <span className="text-cbv2-text-dim/30 mx-0.5">/</span>}
            {isEllipsis ? (
              <span className="flex-shrink-0 rounded px-1 py-0.5 text-cbv2-text-dim/70" title={`${hiddenCount} hidden folder${hiddenCount === 1 ? "" : "s"}`}>
                ...
              </span>
            ) : (
              <button
                className={[
                  "flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors",
                  isLast ? "max-w-[220px] text-cbv2-text font-medium" : "max-w-[140px] hover:bg-cbv2-hover hover:text-cbv2-text cursor-pointer",
                ].join(" ")}
                onClick={() => !isLast && onNavigate?.(folderPath)}
                disabled={isLast}
                title={folderPath || part}
              >
                {!isLast && <Folder className="w-3 h-3 flex-shrink-0 text-yellow-500/70" />}
                {isLast && <FileCode className="w-3 h-3 flex-shrink-0 text-cbv2-accent" />}
                <span className="min-w-0 truncate">{part}</span>
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function isEditableFilePath(path?: string | null): boolean {
  if (!path) return false;
  if (path.startsWith("proposal:")) return false;
  if (path.startsWith("repo-preview:")) return false;
  if (path.startsWith("repo:")) return true;

  const normalized = path.replace(/^\/+/, "").toLowerCase();
  return !(
    normalized.startsWith("src/") ||
    normalized.startsWith("source/") ||
    normalized.startsWith("analysis/") ||
    normalized.startsWith("ana/")
  );
}

function isGeneratedEditablePath(path?: string | null): boolean {
  if (!path || path.startsWith("proposal:") || path.startsWith("repo:") || path.startsWith("repo-preview:")) return false;
  return isEditableFilePath(path);
}

// ── Welcome Screen ──────────────────────────────────────────────────────

function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cbv2-accent/15 to-purple-500/15 flex items-center justify-center mb-5 ring-1 ring-cbv2-accent/20">
        <Code2 className="w-8 h-8 text-cbv2-accent/60" />
      </div>
      <h2 className="text-[16px] font-semibold text-cbv2-text/70 mb-2">
        Legacy Modernization Editor
      </h2>
      <p className="text-[12px] text-center max-w-md leading-relaxed mb-6 text-cbv2-text-dim">
        Select a file from the explorer to view its contents here.
        Generated and analysis files will appear as the pipeline runs.
      </p>
      <div className="flex items-center gap-6 text-[10px] text-cbv2-text-dim">
        <div className="flex items-center gap-1.5">
          <Keyboard className="w-3.5 h-3.5" />
          <span><kbd className="px-1 py-0.5 rounded bg-cbv2-input text-[9px] font-mono">Ctrl+S</kbd> Save</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5" />
          <span>Monaco Editor</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          <span>AI-Powered</span>
        </div>
      </div>
    </div>
  );
}

// ── Legacy Editor Panel ─────────────────────────────────────────────────

export interface LegacyEditorProps {
  tabs: LegacyTab[];
  activeTab: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
  onContentChange?: (path: string, content: string) => void;
  onSave?: (path: string) => void;
  onAIChange?: (path: string, instruction: string, symbolName?: string) => Promise<boolean>;
  saving?: boolean;
  aiChanging?: boolean;
  onCloseOthers?: (path: string) => void;
  onCloseAll?: () => void;
  onTogglePin?: (path: string) => void;
  onBreadcrumbNavigate?: (folderPath: string) => void;
  onCompareWith?: (path: string, otherPath: string) => void;
  onExitDiff?: (path: string) => void;
}

export default function LegacyEditor({
  tabs,
  activeTab,
  onTabClick,
  onTabClose,
  onContentChange,
  onSave,
  onAIChange,
  saving,
  aiChanging,
  onCloseOthers,
  onCloseAll,
  onTogglePin,
  onBreadcrumbNavigate,
  onCompareWith,
  onExitDiff,
}: LegacyEditorProps) {
  const activeFile = tabs.find((t) => t.path === activeTab);
  const canEditActiveFile = isEditableFilePath(activeFile?.path);
  const canAIChangeActiveFile = isGeneratedEditablePath(activeFile?.path);
  const [showMinimap, setShowMinimap] = useState(true);
  const [visualPreview, setVisualPreview] = useState(true);
  const [showAIChange, setShowAIChange] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiSymbolName, setAiSymbolName] = useState("");
  const [aiError, setAiError] = useState("");

  const isMermaidFile = activeFile?.path.endsWith(".mmd") ?? false;
  const isDependencyJson =
    (activeFile?.path.endsWith(".json") &&
      activeFile.path.includes("dependency_graph")) ??
    false;
  const isMarkdownFile = activeFile?.path.endsWith(".md") ?? false;
  const hasVisualViewer = isMermaidFile || isDependencyJson || isMarkdownFile;

  // Ctrl+S handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeFile?.isDirty && onSave) {
          onSave(activeFile.path);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeFile, onSave]);

  const handleCloseOthers = useCallback((path: string) => {
    onCloseOthers?.(path);
  }, [onCloseOthers]);

  const handleCloseAll = useCallback(() => {
    onCloseAll?.();
  }, [onCloseAll]);

  const handleTogglePin = useCallback((path: string) => {
    onTogglePin?.(path);
  }, [onTogglePin]);

  const handleCompareWith = useCallback((path: string, otherPath: string) => {
    onCompareWith?.(path, otherPath);
  }, [onCompareWith]);

  const handleExitDiff = useCallback((path: string) => {
    onExitDiff?.(path);
  }, [onExitDiff]);

  const isDiffMode = activeFile?.diffOriginalContent != null;

  const handleSubmitAIChange = useCallback(async () => {
    if (!activeFile || !onAIChange) return;
    const instruction = aiInstruction.trim();
    if (!instruction) {
      setAiError("Describe the change first.");
      return;
    }
    setAiError("");
    const applied = await onAIChange(activeFile.path, instruction, aiSymbolName.trim() || undefined);
    if (!applied) {
      setAiError("AI change could not be applied.");
      return;
    }
    setAiInstruction("");
    setAiSymbolName("");
    setShowAIChange(false);
  }, [activeFile, aiInstruction, aiSymbolName, onAIChange, setAiError, setAiInstruction, setAiSymbolName, setShowAIChange]);

  return (
    <div className="h-full flex flex-col bg-cbv2-editor">
      {showAIChange && activeFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm px-4" onClick={() => !aiChanging && setShowAIChange(false)}>
          <div className="w-full max-w-lg rounded-lg border border-cbv2-border bg-cbv2-sidebar cbv2-card-elevated" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-cbv2-border">
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="w-4 h-4 text-cbv2-accent flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-cbv2-text">AI Change</div>
                  <div className="text-[10px] text-cbv2-text-dim truncate font-mono">{activeFile.path.replace(/^repo:/, "")}</div>
                </div>
              </div>
              <button
                className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-text disabled:opacity-40"
                onClick={() => setShowAIChange(false)}
                disabled={aiChanging}
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-3 space-y-3">
              <input
                className="w-full h-8 rounded-md border border-cbv2-border bg-cbv2-input px-2.5 text-[12px] text-cbv2-text placeholder-cbv2-text-dim outline-none focus:border-cbv2-accent focus:ring-1 focus:ring-cbv2-accent/30"
                value={aiSymbolName}
                onChange={(e) => setAiSymbolName(e.target.value)}
                placeholder="Class, method, or component"
                disabled={aiChanging}
              />
              <textarea
                className="w-full min-h-[120px] resize-y rounded-md border border-cbv2-border bg-cbv2-input px-2.5 py-2 text-[12px] leading-relaxed text-cbv2-text placeholder-cbv2-text-dim outline-none focus:border-cbv2-accent focus:ring-1 focus:ring-cbv2-accent/30"
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder="Describe the change to apply"
                disabled={aiChanging}
              />
              {aiError && <div className="text-[11px] text-red-300">{aiError}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-cbv2-border">
              <button
                className="h-8 px-3 rounded-md border border-cbv2-border text-[12px] text-cbv2-text-dim hover:bg-cbv2-hover hover:text-cbv2-text disabled:opacity-40"
                onClick={() => setShowAIChange(false)}
                disabled={aiChanging}
              >
                Cancel
              </button>
              <button
                className="h-8 px-3 rounded-md bg-cbv2-accent text-[12px] font-medium text-white hover:bg-cbv2-accent/85 disabled:opacity-40 flex items-center gap-1.5"
                onClick={handleSubmitAIChange}
                disabled={aiChanging || !aiInstruction.trim()}
              >
                {aiChanging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {aiChanging ? "Applying..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <TabBar
        tabs={tabs}
        activeTab={activeTab}
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        onCloseOthers={handleCloseOthers}
        onCloseAll={handleCloseAll}
        onTogglePin={handleTogglePin}
        onCompareWith={handleCompareWith}
        onExitDiff={handleExitDiff}
      />

      {/* Breadcrumb + Save + Minimap Toggle */}
      {activeFile && (
        <div className="flex min-w-0 items-center justify-between overflow-hidden bg-cbv2-editor border-b border-cbv2-border">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {isDiffMode ? (
              <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden px-4 py-1.5 text-[11px] text-cbv2-text-dim">
                <ArrowLeftRight className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                <span className="text-orange-400 font-medium flex-shrink-0">Diff:</span>
                <span className="min-w-0 truncate text-cbv2-text-dim">{activeFile.diffOriginalLabel || "Original"}</span>
                <span className="text-cbv2-text-dim/40 flex-shrink-0">↔</span>
                <span className="min-w-0 truncate text-cbv2-text">{activeFile.name}</span>
                <button
                  className="ml-2 flex-shrink-0 px-2 py-0.5 rounded text-[10px] bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-input transition-colors"
                  onClick={() => onExitDiff?.(activeFile.path)}
                >
                  Exit Diff
                </button>
              </div>
            ) : (
              <Breadcrumb path={activeFile.path.replace(/^repo:/, "")} onNavigate={onBreadcrumbNavigate} />
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5 pr-3">
            {!isDiffMode && hasVisualViewer && (
              <div className="flex items-center rounded-md border border-cbv2-border overflow-hidden mr-1">
                <button
                  className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    visualPreview
                      ? "bg-cbv2-accent/15 text-cbv2-accent"
                      : "text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover"
                  }`}
                  onClick={() => setVisualPreview(true)}
                  title="Visual preview"
                >
                  <Eye className="w-3 h-3" />
                  Preview
                </button>
                <div className="w-px h-4 bg-cbv2-border" />
                <button
                  className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    !visualPreview
                      ? "bg-cbv2-accent/15 text-cbv2-accent"
                      : "text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover"
                  }`}
                  onClick={() => setVisualPreview(false)}
                  title="Source code"
                >
                  <Code className="w-3 h-3" />
                  Code
                </button>
              </div>
            )}
            {!isDiffMode && !hasVisualViewer && (
              <button
                className={`p-1 rounded transition-colors ${showMinimap ? "text-cbv2-accent bg-cbv2-accent/10" : "text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover"}`}
                onClick={() => setShowMinimap((v) => !v)}
                title={showMinimap ? "Hide Minimap" : "Show Minimap"}
              >
                <Map className="w-3.5 h-3.5" />
              </button>
            )}
            {!isDiffMode && canAIChangeActiveFile && onAIChange && (
              <button
                className="flex items-center gap-1 h-6 px-2.5 rounded-md text-[10px] border border-cbv2-accent/30 bg-cbv2-accent/10 text-cbv2-accent hover:bg-cbv2-accent/20 disabled:opacity-40 transition-colors font-medium"
                onClick={() => {
                  setAiError("");
                  setShowAIChange(true);
                }}
                disabled={aiChanging}
                title="AI change"
              >
                {aiChanging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                AI Change
              </button>
            )}
            {!isDiffMode && canEditActiveFile && activeFile.isDirty && onSave && (
              <button
                className="flex items-center gap-1 h-6 px-2.5 rounded-md text-[10px] bg-cbv2-accent text-white hover:bg-cbv2-accent/80 disabled:opacity-40 transition-all shadow-sm shadow-cbv2-accent/20 font-medium"
                onClick={() => onSave(activeFile.path)}
                disabled={saving}
                title="Save (Ctrl+S)"
              >
                <Save className="w-3 h-3" />
                {saving ? "Saving..." : "Save"}
              </button>
            )}
            {!isDiffMode && canEditActiveFile && !activeFile.isDirty && (
              <span className="text-[10px] text-green-400/70 flex items-center gap-1">
                <Circle className="w-1.5 h-1.5 fill-green-400 text-green-400" />
                Saved
              </span>
            )}
            {!isDiffMode && !canEditActiveFile && (
              <span className="text-[10px] text-cbv2-text-dim bg-cbv2-input px-2 py-0.5 rounded">Read-only</span>
            )}
          </div>
        </div>
      )}

      {/* Editor Content */}
      <div className="flex-1 overflow-hidden">
        {!activeFile ? (
          <WelcomeScreen />
        ) : isDiffMode ? (
          <MonacoDiffEditor
            height="100%"
            language={activeFile.language}
            original={activeFile.diffOriginalContent}
            modified={activeFile.content}
            theme="vs-dark"
            options={{
              readOnly: true,
              fontSize: 13,
              fontFamily: "'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace",
              renderSideBySide: true,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 8 },
              smoothScrolling: true,
            }}
          />
        ) : hasVisualViewer && visualPreview ? (
          isMermaidFile ? (
            <MermaidViewer
              code={activeFile.content}
              className="h-full bg-cbv2-editor overflow-auto"
              title={activeFile.name}
            />
          ) : isMarkdownFile ? (
            <MarkdownViewer
              content={activeFile.content}
              className="h-full bg-cbv2-editor overflow-auto"
              title={activeFile.name}
            />
          ) : (
            <DependencyGraphViewer
              json={(() => {
                try {
                  return JSON.parse(activeFile.content);
                } catch {
                  return { error: "Invalid JSON" };
                }
              })()}
              className="h-full bg-cbv2-editor overflow-auto"
            />
          )
        ) : (
          <MonacoEditor
            height="100%"
            language={activeFile.language}
            value={activeFile.content}
            theme="vs-dark"
            onChange={(value) => {
              if (canEditActiveFile && onContentChange && value !== undefined) {
                onContentChange(activeFile.path, value);
              }
            }}
            options={{
              readOnly: !canEditActiveFile,
              fontSize: 13,
              fontFamily:
                "'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace",
              minimap: { enabled: showMinimap, scale: 1 },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
              renderLineHighlight: "line",
              folding: true,
              bracketPairColorization: { enabled: true },
              padding: { top: 8 },
              smoothScrolling: true,
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "on",
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
