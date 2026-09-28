"use client";

import {
  FileCode,
  FileJson,
  FileText,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type FileEntry, listFiles } from "@/lib/files";

interface FileExplorerProps {
  threadId: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Bumped externally to force a refresh (e.g. after each agent `final`). */
  refreshKey: number;
}

interface TreeNode {
  name: string;
  path: string;
  kind: FileEntry["kind"] | "dir";
  children: TreeNode[];
  size?: number;
}

export function FileExplorer({
  threadId,
  selectedPath,
  onSelect,
  refreshKey,
}: FileExplorerProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await listFiles(threadId);
      setFiles(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <aside
      className="flex h-full min-h-0 w-64 flex-col border-r border-bell-border bg-bell-surface"
      aria-label="Generated files"
    >
      <header className="flex items-center justify-between border-b border-bell-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-bell-slate">
        <span className="inline-flex items-center gap-1.5">
          <FolderOpen size={14} aria-hidden />
          Artefacts
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !threadId}
          className="rounded p-1 text-bell-muted transition-colors hover:bg-white hover:text-bell-blue disabled:opacity-40"
          title="Refresh"
          aria-label="Refresh file list"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
        </button>
      </header>
      <div className="bell-scroll min-h-0 flex-1 overflow-y-auto py-2 text-sm">
        {!threadId && (
          <p className="px-3 py-4 text-xs text-bell-muted">
            Start a conversation to generate files.
          </p>
        )}
        {threadId && !loading && files.length === 0 && !error && (
          <p className="px-3 py-4 text-xs text-bell-muted">
            No files yet. The agent will write to
            <code className="mx-1 rounded bg-bell-blue-soft px-1 py-0.5 text-[10px]">
              features/{threadId.slice(0, 6)}…/docs/
            </code>
            on the next run.
          </p>
        )}
        {error && (
          <p className="mx-3 my-2 rounded border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-800">
            {error}
          </p>
        )}
        {tree.map((n) => (
          <TreeItem
            key={n.path || n.name}
            node={n}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${8 + depth * 12}px` };

  if (node.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 py-1 text-left text-bell-slate transition-colors hover:bg-bell-blue-soft"
          style={pad}
        >
          <span aria-hidden className="text-xs">
            {open ? "▾" : "▸"}
          </span>
          <FolderOpen size={13} className="text-bell-muted" aria-hidden />
          <span className="truncate text-xs">{node.name}</span>
        </button>
        {open &&
          node.children.map((c) => (
            <TreeItem
              key={c.path || `${node.path}/${c.name}`}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </div>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={
        "flex w-full items-center gap-1.5 py-1 text-left transition-colors " +
        (isSelected
          ? "bg-bell-blue-soft text-bell-blue"
          : "text-bell-slate hover:bg-white")
      }
      style={pad}
      title={node.path}
    >
      <FileIcon kind={node.kind as FileEntry["kind"]} />
      <span className="truncate text-xs">{node.name}</span>
    </button>
  );
}

function FileIcon({ kind }: { kind: FileEntry["kind"] }) {
  if (kind === "json") return <FileJson size={13} className="text-amber-500" aria-hidden />;
  if (kind === "feature")
    return <FileCode size={13} className="text-emerald-600" aria-hidden />;
  if (kind === "markdown") return <FileText size={13} className="text-sky-600" aria-hidden />;
  return <FileText size={13} className="text-bell-muted" aria-hidden />;
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let next = cur.children.find(
        (c) => c.kind === "dir" && c.name === dirName,
      );
      if (!next) {
        next = {
          name: dirName,
          path: parts.slice(0, i + 1).join("/"),
          kind: "dir",
          children: [],
        };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({
      name: parts[parts.length - 1],
      path: f.path,
      kind: f.kind,
      children: [],
      size: f.size,
    });
  }
  // Sort each level: dirs first, then files alphabetically.
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (b.kind === "dir" && a.kind !== "dir") return 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) if (c.kind === "dir") sort(c);
  };
  sort(root);
  return root.children;
}
