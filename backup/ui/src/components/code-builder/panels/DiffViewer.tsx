"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  GitCompare,
  FilePlus,
  FileEdit,
  FileX,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
} from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";
import type { FileDiff } from "@/types/code-builder";

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then(mod => mod.DiffEditor),
  { ssr: false }
);
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

function ChangeIcon({ type }: { type: string }) {
  switch (type) {
    case "added":    return <FilePlus size={13} className="text-emerald-400 shrink-0" />;
    case "modified": return <FileEdit size={13} className="text-amber-400 shrink-0" />;
    case "deleted":  return <FileX size={13} className="text-red-400 shrink-0" />;
    default:         return <FileEdit size={13} className="text-gray-400 shrink-0" />;
  }
}

function changeColor(type: string): string {
  switch (type) {
    case "added":    return "text-emerald-400";
    case "modified": return "text-amber-400";
    case "deleted":  return "text-red-400";
    default: return "text-gray-400";
  }
}

function changeBg(type: string): string {
  switch (type) {
    case "added":    return "bg-emerald-500/10";
    case "modified": return "bg-amber-500/10";
    case "deleted":  return "bg-red-500/10";
    default: return "bg-gray-500/10";
  }
}

/* ═══════════════════════════════════════════════════════════
 * DiffViewer — Side-by-side diff for brownfield/hybrid pipelines
 * ═══════════════════════════════════════════════════════════ */
export default function DiffViewer() {
  const {
    diffFiles,
    diffRunId,
    setMainView,
  } = useStore();

  const [selectedFile, setSelectedFile] = useState<FileDiff | null>(
    diffFiles.length > 0 ? diffFiles[0] : null
  );
  const [viewMode, setViewMode] = useState<"inline" | "side-by-side">("side-by-side");

  /* Stats */
  const addedCount = diffFiles.filter(f => f.change_type === "added").length;
  const modifiedCount = diffFiles.filter(f => f.change_type === "modified").length;
  const deletedCount = diffFiles.filter(f => f.change_type === "deleted").length;

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-editor-sidebar border-b border-editor-border shrink-0">
        <button
          onClick={() => setMainView("pipeline-history")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                     bg-editor-input border border-editor-border hover:bg-editor-active
                     text-gray-300 hover:text-white transition-colors"
        >
          <ArrowLeft size={13} /> Back
        </button>
        <GitCompare size={15} className="text-orange-400" />
        <span className="text-sm font-semibold text-white">Code Diff Viewer</span>
        {diffRunId && (
          <span className="text-[10px] text-gray-500 font-mono">Run: {diffRunId}</span>
        )}
        <div className="flex-1" />

        {/* Stats */}
        <div className="flex items-center gap-3 mr-3">
          {addedCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
              <FilePlus size={11} /> {addedCount} added
            </span>
          )}
          {modifiedCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-400">
              <FileEdit size={11} /> {modifiedCount} modified
            </span>
          )}
          {deletedCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-red-400">
              <FileX size={11} /> {deletedCount} deleted
            </span>
          )}
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 p-0.5 rounded bg-editor-input border border-editor-border">
          <button
            onClick={() => setViewMode("side-by-side")}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors
              ${viewMode === "side-by-side" ? "bg-editor-accent text-white" : "text-gray-400 hover:text-white"}`}
          >
            Side by Side
          </button>
          <button
            onClick={() => setViewMode("inline")}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors
              ${viewMode === "inline" ? "bg-editor-accent text-white" : "text-gray-400 hover:text-white"}`}
          >
            Inline
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        {/* Left: file list */}
        <div className="w-[260px] shrink-0 bg-editor-sidebar border-r border-editor-border overflow-y-auto">
          <div className="px-3 py-2 border-b border-editor-border">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
              Changed Files ({diffFiles.length})
            </span>
          </div>
          <div className="py-1">
            {diffFiles.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-gray-500">
                <GitCompare size={20} className="mx-auto mb-2 opacity-20" />
                <p>No file changes detected</p>
              </div>
            ) : (
              diffFiles.map((diff) => (
                <button
                  key={diff.file_path}
                  onClick={() => setSelectedFile(diff)}
                  className={`flex items-center gap-2 w-full text-left px-3 py-2 text-[11px]
                    hover:bg-editor-active transition-colors
                    ${selectedFile?.file_path === diff.file_path
                      ? "bg-editor-highlight text-white"
                      : "text-gray-300"
                    }`}
                >
                  <ChangeIcon type={diff.change_type} />
                  <div className="min-w-0 flex-1">
                    <span className="truncate block text-[11px]">{diff.file_path.split("/").pop()}</span>
                    <span className="text-[9px] text-gray-500 truncate block">{diff.file_path}</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0
                    ${changeBg(diff.change_type)} ${changeColor(diff.change_type)}`}>
                    {diff.change_type}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: diff editor */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedFile ? (
            <>
              {/* File header */}
              <div className="flex items-center gap-3 px-4 py-2 bg-editor-sidebar/50 border-b border-editor-border shrink-0">
                <ChangeIcon type={selectedFile.change_type} />
                <span className="text-xs font-medium text-gray-200">{selectedFile.file_path}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold
                  ${changeBg(selectedFile.change_type)} ${changeColor(selectedFile.change_type)}`}>
                  {selectedFile.change_type.toUpperCase()}
                </span>
                <span className="text-[10px] text-gray-500">{selectedFile.language}</span>
              </div>

              {/* Diff content */}
              <div className="flex-1 min-h-0">
                {selectedFile.change_type === "added" || !selectedFile.old_content ? (
                  /* New file — show with green highlight label */
                  <div className="h-full relative">
                    <div className="absolute top-2 right-4 z-10 px-2 py-1 rounded bg-emerald-600/30 text-emerald-300 text-[10px] font-semibold">
                      NEW FILE
                    </div>
                    <Editor
                      key={selectedFile.file_path + "-new"}
                      defaultValue={selectedFile.new_content}
                      language={selectedFile.language}
                      theme="vs-dark"
                      options={{
                        readOnly: true,
                        fontSize: 12,
                        fontFamily: '"Cascadia Code", Consolas, monospace',
                        minimap: { enabled: false },
                        wordWrap: "on",
                        scrollBeyondLastLine: false,
                        padding: { top: 8 },
                      }}
                    />
                  </div>
                ) : (
                  /* Modified file — diff view */
                  <DiffEditor
                    key={selectedFile.file_path + "-diff-" + viewMode}
                    original={selectedFile.old_content}
                    modified={selectedFile.new_content}
                    language={selectedFile.language}
                    theme="vs-dark"
                    options={{
                      readOnly: true,
                      fontSize: 12,
                      fontFamily: '"Cascadia Code", Consolas, monospace',
                      renderSideBySide: viewMode === "side-by-side",
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      padding: { top: 8 },
                      originalEditable: false,
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <GitCompare size={36} className="mx-auto mb-3 opacity-20" />
                <p className="text-sm">Select a file to view changes</p>
                <p className="text-xs opacity-60 mt-1">Old code (left) vs New code (right)</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
