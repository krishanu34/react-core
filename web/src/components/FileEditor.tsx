"use client";

import { AlertCircle, Check, FileWarning, Save, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  FileValidationError,
  type FileContent,
  type FileEntry,
  type ValidationIssue,
  readFile,
  writeFile,
} from "@/lib/files";

/** Monaco is client-only and heavyweight — lazy-load with SSR disabled. */
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-xs text-bell-muted">
      Loading editor…
    </div>
  ),
});

interface FileEditorProps {
  threadId: string;
  path: string;
  onSaved?: (entry: FileEntry) => void;
  onClose?: () => void;
}

type Status =
  | { kind: "loading" }
  | { kind: "loaded"; file: FileContent }
  | { kind: "error"; message: string };

export function FileEditor({ threadId, path, onSaved, onClose }: FileEditorProps) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [buffer, setBuffer] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    setIssues([]);
    setSaveError(null);
    setDirty(false);
    readFile(threadId, path)
      .then((file) => {
        if (cancelled) return;
        setStatus({ kind: "loaded", file });
        setBuffer(file.content);
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({ kind: "error", message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, path]);

  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(false), 1500);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  async function handleSave() {
    if (status.kind !== "loaded" || saving) return;
    setSaving(true);
    setSaveError(null);
    setIssues([]);
    try {
      const updated = await writeFile(threadId, path, buffer);
      setStatus({
        kind: "loaded",
        file: { ...status.file, ...updated, content: buffer },
      });
      setDirty(false);
      setSavedFlash(true);
      onSaved?.(updated);
    } catch (e) {
      if (e instanceof FileValidationError) {
        setIssues(e.issues);
      } else {
        setSaveError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        handleSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, path, buffer, saving, status.kind]);

  const language = languageForPath(path);

  return (
    <div className="flex h-full min-h-0 w-full flex-col border-l border-bell-border bg-white">
      <header className="flex items-center justify-between border-b border-bell-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-mono text-bell-slate" title={path}>
            {path}
          </p>
          <p className="text-[10px] text-bell-muted">
            {language.toUpperCase()}
            {dirty && <span className="ml-1 text-amber-600">• unsaved</span>}
            {savedFlash && !dirty && (
              <span className="ml-1 text-emerald-600">• saved</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving || status.kind !== "loaded"}
            className="inline-flex items-center gap-1 rounded-[var(--radius-bell)] bg-bell-blue px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-bell-blue-dark disabled:opacity-40"
            title="Save (Ctrl/⌘ + S)"
          >
            {saving ? (
              <Save size={12} className="animate-pulse" aria-hidden />
            ) : savedFlash ? (
              <Check size={12} aria-hidden />
            ) : (
              <Save size={12} aria-hidden />
            )}
            Save
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-bell-muted transition-colors hover:bg-bell-blue-soft hover:text-bell-blue"
              title="Close"
              aria-label="Close editor"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
      </header>

      {status.kind === "loading" && (
        <p className="p-6 text-center text-xs text-bell-muted">Loading…</p>
      )}
      {status.kind === "error" && (
        <p className="m-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {status.message}
        </p>
      )}
      {status.kind === "loaded" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <MonacoEditor
              height="100%"
              language={language}
              value={buffer}
              onChange={(v) => {
                setBuffer(v ?? "");
                setDirty((v ?? "") !== status.file.content);
                if (issues.length > 0) setIssues([]);
                if (saveError) setSaveError(null);
              }}
              options={{
                minimap: { enabled: false },
                wordWrap: "on",
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                fontSize: 13,
                automaticLayout: true,
                tabSize: 2,
              }}
            />
          </div>

          {(issues.length > 0 || saveError) && (
            <div className="max-h-48 overflow-y-auto border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="mb-1 inline-flex items-center gap-1 font-semibold">
                {saveError ? (
                  <AlertCircle size={12} aria-hidden />
                ) : (
                  <FileWarning size={12} aria-hidden />
                )}
                {saveError ? "Save failed" : "Validation errors — not saved"}
              </p>
              {saveError && <p>{saveError}</p>}
              {issues.length > 0 && (
                <ul className="ml-4 list-disc space-y-0.5">
                  {issues.map((i, idx) => (
                    <li key={idx}>
                      {i.line != null && (
                        <code className="mr-1 rounded bg-amber-100 px-1 text-[10px]">
                          line {i.line}
                        </code>
                      )}
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function languageForPath(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".feature")) return "gherkin";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx")) return "javascript";
  if (p.endsWith(".py")) return "python";
  return "plaintext";
}
