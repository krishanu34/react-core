"use client";

import { useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { X, Circle } from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";
import { writeFile } from "@/lib/code-builder-api";

/* lazy-load Monaco to avoid SSR issues */
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

/* ── Tab bar ───────────────────────────────────────────── */
function TabBar() {
  const { tabs, activeTab, setActiveTab, closeTab } = useStore();

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center bg-editor-sidebar border-b border-editor-border overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.path === activeTab;
        return (
          <button
            key={tab.path}
            onClick={() => setActiveTab(tab.path)}
            className={`
              group flex items-center gap-1.5 px-3 py-1.5 text-[13px] min-w-0
              border-r border-editor-border transition-colors shrink-0
              ${isActive
                ? "bg-editor-bg text-editor-fg border-t-2 border-t-editor-accent"
                : "bg-editor-sidebar text-gray-400 hover:bg-editor-active border-t-2 border-t-transparent"
              }
            `}
            title={tab.path}
          >
            {tab.isDirty && (
              <Circle size={8} className="fill-current text-editor-warning shrink-0" />
            )}
            {tab.source === "output" && (
              <span className="text-[8px] px-1 py-0 rounded bg-emerald-600/30 text-emerald-400 font-bold uppercase shrink-0">gen</span>
            )}
            <span className="truncate max-w-[140px]">{tab.name}</span>
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
              className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-editor-input transition-opacity"
            >
              <X size={12} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Monaco editor panel ───────────────────────────────── */
export default function MonacoEditorPanel() {
  const { tabs, activeTab, updateTabContent, markTabClean, currentProject } =
    useStore();
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const activeFile = tabs.find((t) => t.path === activeTab);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activeTab || value === undefined) return;
      updateTabContent(activeTab, value);

      /* debounced auto-save — only for project files, not output */
      const tab = useStore.getState().tabs.find((t) => t.path === activeTab);
      if (tab?.source === "output") return; // output files are read-only view

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          const projectId = useStore.getState().currentProject?.project_id;
          if (!projectId) return;
          await writeFile(projectId, activeTab, value);
          markTabClean(activeTab);
        } catch (e) {
          console.error("Auto-save failed:", e);
        }
      }, 1500);
    },
    [activeTab, updateTabContent, markTabClean]
  );

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      <TabBar />

      {activeFile ? (
        <div className="flex-1 min-h-0">
          <Editor
            key={activeFile.path}
            defaultValue={activeFile.content}
            language={activeFile.language}
            theme="vs-dark"
            onChange={handleChange}
            options={{
              fontSize: 13,
              fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
              fontLigatures: true,
              minimap: { enabled: true, scale: 1 },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
              renderLineHighlight: "line",
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "on",
              smoothScrolling: true,
              tabSize: 2,
              formatOnPaste: true,
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              padding: { top: 8 },
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
          />
        </div>
      ) : (
        /* empty state */
        <div className="flex-1 flex items-center justify-center text-gray-500">
          <div className="text-center">
            <div className="text-5xl mb-4 opacity-20">{ "{}" }</div>
            <p className="text-sm mb-1">No file open</p>
            <p className="text-xs opacity-60">
              Select a file from the explorer or run a pipeline to generate code
            </p>
          </div>
        </div>
      )}

      {/* status bar */}
      {activeFile && (
        <div className="flex items-center justify-between px-3 py-0.5 bg-editor-statusbar text-white text-[11px]">
          <div className="flex items-center gap-3">
            <span>{activeFile.language}</span>
            <span>UTF-8</span>
          </div>
          <div className="flex items-center gap-3">
            <span>{activeFile.isDirty ? "Modified" : "Saved"}</span>
            <span className="truncate max-w-[300px]">{activeFile.path}</span>
          </div>
        </div>
      )}
    </div>
  );
}
