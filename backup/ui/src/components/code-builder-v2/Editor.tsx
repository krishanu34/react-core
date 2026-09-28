"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CBv2Tab } from "@/types/code-builder-v2";
import { X, FileCode, Code2, Save, Circle, Keyboard, Terminal, Sparkles, GitCompare, FilePlus2, FilePen } from "lucide-react";
import dynamic from "next/dynamic";
import { useCbv2Theme } from "@/components/code-builder-v2/theme-store";

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
        <Code2 className="w-6 h-6 animate-pulse mr-2" />
        Loading diff editor...
      </div>
    ),
  }
);

// ── Tab Bar ─────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: CBv2Tab[];
  activeTab: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
}

function TabBar({ tabs, activeTab, onTabClick, onTabClose }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex bg-cbv2-tab border-b border-cbv2-border overflow-x-auto cbv2-scrollbar-none">
      {tabs.map((tab) => {
        const isActive = tab.path === activeTab;
        const isDiff = tab.originalContent !== undefined;
        const actionColor = tab.fileAction === "create"
          ? "text-green-400"
          : tab.fileAction === "modify"
            ? "text-amber-400"
            : tab.fileAction === "delete"
              ? "text-red-400"
            : "";
        const TabIcon = isDiff ? GitCompare : tab.fileAction === "create" ? FilePlus2 : tab.fileAction === "modify" ? FilePen : FileCode;
        return (
          <div
            key={tab.path}
            className={["flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-[12px] border-r border-cbv2-border min-w-0 max-w-[200px] group", isActive ? "bg-cbv2-tab-active text-cbv2-text border-t-2 border-t-cbv2-accent font-medium" : "text-cbv2-text-dim hover:bg-cbv2-hover"].join(" ")}
            onClick={() => onTabClick(tab.path)}
          >
            <TabIcon className={`w-3.5 h-3.5 flex-shrink-0 ${actionColor}`} />
            <span className="truncate">{tab.name}</span>
            {tab.fileAction && (
              <span className={`text-[9px] font-bold ${actionColor} flex-shrink-0`}>
                {tab.fileAction === "create" ? "N" : tab.fileAction === "delete" ? "D" : "M"}
              </span>
            )}
            {tab.isDirty ? (
              <Circle className="w-2 h-2 flex-shrink-0 fill-cbv2-accent text-cbv2-accent ml-auto" />
            ) : (
              <button
                className={["ml-auto flex-shrink-0 rounded p-0.5 hover:bg-white/10 transition-colors", isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"].join(" ")}
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.path);
                }}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Breadcrumb ──────────────────────────────────────────────────────────

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <div className="flex items-center gap-1 px-4 py-1 bg-cbv2-editor border-b border-cbv2-border text-[11px] text-cbv2-text-dim">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-cbv2-text-dim/50">›</span>}
          <span className={i === parts.length - 1 ? "text-cbv2-text" : ""}>
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Welcome Screen ──────────────────────────────────────────────────────

function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full bg-cbv2-editor text-cbv2-text-dim">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cbv2-accent/15 to-purple-500/15 flex items-center justify-center mb-5 ring-1 ring-cbv2-accent/20">
        <Code2 className="w-8 h-8 text-cbv2-accent/60" />
      </div>
      <h2 className="text-[16px] font-semibold text-cbv2-text/70 mb-2">
        Code Builder Editor
      </h2>
      <p className="text-[12px] text-center max-w-md leading-relaxed mb-6 text-cbv2-text-dim">
        Select a file from the explorer to view its contents here.
        Generated files will appear as the code builder pipeline runs.
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

// ── Editor Panel ────────────────────────────────────────────────────────

interface CBv2EditorProps {
  tabs: CBv2Tab[];
  activeTab: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
  onContentChange?: (path: string, content: string) => void;
  onSave?: (path: string) => void;
  saving?: boolean;
}

export default function CBv2Editor({
  tabs,
  activeTab,
  onTabClick,
  onTabClose,
  onContentChange,
  onSave,
  saving,
}: CBv2EditorProps) {
  const activeFile = tabs.find((t) => t.path === activeTab);
  const isRepoFile = activeFile?.path.startsWith("repo:");
  const isDiffMode = activeFile?.originalContent !== undefined;
  const { theme: cbvMode } = useCbv2Theme();
  const monacoTheme = cbvMode === "light" ? "vs" : "vs-dark";

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

  return (
    <div className="h-full flex flex-col bg-cbv2-editor">
      {/* Tab Bar */}
      <TabBar
        tabs={tabs}
        activeTab={activeTab}
        onTabClick={onTabClick}
        onTabClose={onTabClose}
      />

      {/* Breadcrumb + Save */}
      {activeFile && (
        <div className="flex items-center justify-between bg-cbv2-editor border-b border-cbv2-border">
          <Breadcrumb path={activeFile.path.replace(/^repo:/, "")} />
          <div className="flex items-center gap-1.5 pr-3">
            {isDiffMode && (
              <span className="flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                <GitCompare className="w-3 h-3" />
                Diff View
              </span>
            )}
            {isRepoFile && activeFile.isDirty && onSave && (
              <button
                className="flex items-center gap-1 h-6 px-2 rounded text-[10px] bg-cbv2-accent text-white hover:bg-cbv2-accent/80 disabled:opacity-40 transition-colors"
                onClick={() => onSave(activeFile.path)}
                disabled={saving}
                title="Save (Ctrl+S)"
              >
                <Save className="w-3 h-3" />
                Save
              </button>
            )}
            {isRepoFile && !activeFile.isDirty && (
              <span className="text-[10px] text-cbv2-text-dim">Saved</span>
            )}
            {!isRepoFile && (
              <span className="text-[10px] text-cbv2-text-dim">Read-only</span>
            )}
          </div>
        </div>
      )}

      {/* Editor Content */}
      <div className="flex-1 overflow-hidden">
        {activeFile ? (
          isDiffMode ? (
            <MonacoDiffEditor
              height="100%"
              language={activeFile.language}
              original={activeFile.originalContent}
              modified={activeFile.content}
              theme={monacoTheme}
              options={{
                readOnly: true,
                fontSize: 13,
                fontFamily:
                  "'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderSideBySide: true,
                lineNumbers: "on",
                folding: true,
                padding: { top: 8 },
                smoothScrolling: true,
                automaticLayout: true,
              }}
            />
          ) : (
            <MonacoEditor
              height="100%"
              language={activeFile.language}
              value={activeFile.content}
              theme={monacoTheme}
              onChange={(value) => {
                if (isRepoFile && onContentChange && value !== undefined) {
                  onContentChange(activeFile.path, value);
                }
              }}
              options={{
                readOnly: !isRepoFile,
                fontSize: 13,
                fontFamily:
                  "'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace",
                minimap: { enabled: true, scale: 1 },
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
          )
        ) : (
          <WelcomeScreen />
        )}
      </div>
    </div>
  );
}
