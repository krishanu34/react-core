"use client";

/**
 * EditorPane — Monaco editor for the active file. Uses @monaco-editor/react
 * (already a project dependency) loaded dynamically to avoid SSR issues.
 * ISOLATION: new file; does not reuse the coupled code-builder-v2/Editor.tsx.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2, FileCode2, Clock, FolderTree, FolderOpen } from "lucide-react";
import type { OpenFile } from "@/hooks/useEditorTabs";
import type { WsTab } from "@/lib/db/workspaceStore";
import { EXPLORER_DRAG_MIME } from "@/components/ide/ExplorerTree";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-[11px] text-[var(--ide-muted)]">
      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading editor…
    </div>
  ),
});

/* ========================================================================== *
 *  EditorPane — Monaco editor for the active file (Cmd/Ctrl+S to save)
 * ========================================================================== */
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const SHORTCUTS = [
  { keys: "Ctrl+P", label: "Quick Open" },
  { keys: "Ctrl+B", label: "Toggle Sidebar" },
  { keys: "Ctrl+\\", label: "Split Editor" },
  { keys: "Ctrl+S", label: "Save File" },
];

export interface EditorPaneProps {
  file: OpenFile | null;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
  theme?: "dark" | "light";
  onOpenFile?: (path: string) => void;
  tabs?: WsTab[];
  workspaceName?: string;
  /** Debounced cursor/scroll-position updates for the active file (AC: scroll position retention). */
  onViewStateChange?: (path: string, viewState: { cursor?: { line: number; column: number }; scrollTop?: number }) => void;
}

/**
 * EditorPane — dispatcher. Renders either the empty-state placeholder or the
 * Monaco-backed FileEditor. Splitting these keeps every hook inside FileEditor
 * unconditional: an early `return` above hooks (the previous shape) violated the
 * Rules of Hooks and crashed React when the active file toggled null↔set
 * (open first file / close last tab).
 */
export function EditorPane(props: EditorPaneProps) {
  if (!props.file) {
    return (
      <EmptyEditorState
        onOpenFile={props.onOpenFile}
        tabs={props.tabs}
        workspaceName={props.workspaceName}
      />
    );
  }
  // file is non-null past this point — FileEditor's hooks always run.
  return <FileEditor {...props} file={props.file} />;
}

/* ========================================================================== *
 *  EmptyEditorState — welcome screen shown when no file is open
 * ========================================================================== */
function EmptyEditorState({
  onOpenFile,
  tabs,
  workspaceName,
}: {
  onOpenFile?: (path: string) => void;
  tabs?: WsTab[];
  workspaceName?: string;
}) {
  return (
    <div
      className="flex items-center justify-center h-full"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(EXPLORER_DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData(EXPLORER_DRAG_MIME);
        if (!raw) return;
        try {
          (JSON.parse(raw) as string[]).forEach((p) => onOpenFile?.(p));
        } catch {
          onOpenFile?.(raw);
        }
      }}
    >
      <div className="flex flex-col items-center gap-6 max-w-md px-6">
          {/* Logo + title */}
          <div className="flex flex-col items-center gap-2">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <FolderTree className="h-7 w-7 text-white" />
            </div>
            <h2 className="text-lg font-semibold text-[var(--ide-text)]">
              {workspaceName || "Code Studio"}
            </h2>
            <p className="text-[12px] text-[var(--ide-muted)]">
              Open a file from the explorer or drag one here
            </p>
          </div>

          {/* Recent files */}
          {tabs && tabs.length > 0 && (
            <div className="w-full">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock className="h-3.5 w-3.5 text-[var(--ide-muted)]" />
                <span className="text-[11px] uppercase tracking-wider text-[var(--ide-muted)] font-medium">Recent Files</span>
              </div>
              <div className="space-y-0.5">
                {tabs.slice(0, 5).map((t) => (
                  <button
                    key={t.path}
                    type="button"
                    onClick={() => onOpenFile?.(t.path)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 rounded-lg text-left hover:bg-[var(--ide-hover)] transition-colors group"
                  >
                    <FileCode2 className="h-3.5 w-3.5 text-[var(--ide-muted)] group-hover:text-violet-400 transition-colors shrink-0" />
                    <span className="text-[12px] text-[var(--ide-text)] truncate">{baseName(t.path)}</span>
                    <span className="text-[10px] text-[var(--ide-muted)] truncate ml-auto max-w-[40%]">
                      {t.path.split("/").slice(0, -1).join("/")}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quick start actions */}
          <div className="w-full">
            <div className="flex items-center gap-1.5 mb-2">
              <FolderOpen className="h-3.5 w-3.5 text-[var(--ide-muted)]" />
              <span className="text-[11px] uppercase tracking-wider text-[var(--ide-muted)] font-medium">Shortcuts</span>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {SHORTCUTS.map((s) => (
                <div
                  key={s.keys}
                  className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[var(--ide-surface-2)]/50 text-[11px]"
                >
                  <span className="text-[var(--ide-muted)]">{s.label}</span>
                  <kbd className="px-1.5 py-px rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] text-[10px] text-[var(--ide-muted)] font-mono">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
  );
}

/* ========================================================================== *
 *  FileEditor — Monaco editor bound to a non-null open file
 * ========================================================================== */
function FileEditor({
  file,
  onChange,
  onSave,
  theme = "dark",
  tabs,
  onViewStateChange,
}: EditorPaneProps & { file: OpenFile }) {
  /* ── Go to Line dialog state ─────────────────────────────────────────── */
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const lineCount = editorRef.current?.getModel?.()?.getLineCount?.() ?? 0;

  /* ── Scroll/cursor position retention (debounced write, applied on tab switch) ── */
  const viewStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleViewStateSave = useCallback(() => {
    if (!onViewStateChange) return;
    if (viewStateTimerRef.current) clearTimeout(viewStateTimerRef.current);
    viewStateTimerRef.current = setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const pos = editor.getPosition?.();
      onViewStateChange(file.path, {
        cursor: pos ? { line: pos.lineNumber, column: pos.column } : undefined,
        scrollTop: editor.getScrollTop?.(),
      });
    }, 400);
  }, [onViewStateChange, file.path]);

  const applyStoredViewState = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (editor: any) => {
      const tab = tabs?.find((t) => t.path === file.path);
      if (!tab) return;
      if (tab.cursor) editor.setPosition({ lineNumber: tab.cursor.line, column: tab.cursor.column });
      if (tab.scrollTop != null) editor.setScrollTop(tab.scrollTop);
    },
    [tabs, file.path],
  );

  const handleEditorMount = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (editor: any) => {
      editorRef.current = editor;
      editor.addAction({
        id: "custom-goto-line",
        label: "Go to Line...",
        keybindings: [2048 + 37], // Ctrl+G (KeyMod.CtrlCmd | KeyCode.KeyG)
        run: () => {
          setGoToLineValue("");
          setGoToLineOpen(true);
          setTimeout(() => goToLineInputRef.current?.focus(), 50);
        },
      });
      editor.onDidChangeCursorPosition(scheduleViewStateSave);
      editor.onDidScrollChange(scheduleViewStateSave);
      applyStoredViewState(editor);
    },
    [scheduleViewStateSave, applyStoredViewState],
  );

  /* Monaco reuses the same editor instance across tabs (only `path`/model swap),
     so re-apply the stored view state whenever the active file changes. */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Small delay lets Monaco finish swapping to the new model before we seek.
    const id = setTimeout(() => applyStoredViewState(editor), 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  const executeGoToLine = useCallback(() => {
    const line = parseInt(goToLineValue, 10);
    if (!Number.isFinite(line) || !editorRef.current) return;
    const max = editorRef.current.getModel()?.getLineCount() ?? 1;
    const clamped = Math.max(1, Math.min(line, max));
    editorRef.current.setPosition({ lineNumber: clamped, column: 1 });
    editorRef.current.revealLineInCenter(clamped);
    editorRef.current.focus();
    setGoToLineOpen(false);
  }, [goToLineValue]);

  return (
    <div className="relative h-full" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
    }}>
      <Monaco
        path={file.path}
        language={file.lang}
        value={file.content}
        theme={theme === "light" ? "vs" : "vs-dark"}
        onChange={(v) => onChange(file.path, v ?? "")}
        onMount={handleEditorMount}
        options={{
          fontSize: 13,
          fontFamily: "Consolas, 'Fira Code', monospace",
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
        }}
      />

      {/* Go to Line — VS Code-style, same position/look as Quick Access */}
      {goToLineOpen && (
        <>
          <div className="fixed inset-0 z-[100] bg-black/20" onClick={() => { setGoToLineOpen(false); editorRef.current?.focus(); }} />
          <div className="fixed left-1/2 top-[56px] z-[101] -translate-x-1/2 w-[560px] max-w-[calc(100%-32px)] rounded-lg border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden">
            <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--ide-border)]">
              <span className="text-sm text-[var(--ide-muted)] shrink-0">:</span>
              <input
                ref={goToLineInputRef}
                type="text"
                value={goToLineValue}
                onChange={(e) => setGoToLineValue(e.target.value.replace(/[^0-9:,]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); executeGoToLine(); }
                  if (e.key === "Escape") { e.preventDefault(); setGoToLineOpen(false); editorRef.current?.focus(); }
                }}
                placeholder="Go to Line..."
                className="flex-1 bg-transparent text-sm text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] outline-none"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="px-3 py-2 text-[12px] text-[var(--ide-muted)]">
              Type a line number between 1 and {lineCount || "…"} to go to.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default EditorPane;
