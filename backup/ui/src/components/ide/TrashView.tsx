"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, RotateCcw, X as XIcon, Loader2, FileIcon, Folder } from "lucide-react";
import { getTrash, type WsNode } from "@/lib/db/workspaceStore";
import { restoreFile, hardDeleteFile } from "@/lib/workspace-api";

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function TrashView({
  workspaceId,
  onRestore,
}: {
  workspaceId: number;
  /** Called after a successful restore so the caller can refresh the Explorer. */
  onRestore: () => void;
}) {
  const [items, setItems]   = useState<WsNode[] | null>(null);
  const [busy,  setBusy]    = useState<string | null>(null);

  const load = useCallback(() => {
    getTrash(workspaceId).then(setItems).catch(() => setItems([]));
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const restore = async (node: WsNode) => {
    setBusy(node.path);
    try {
      await restoreFile(workspaceId, node.path);
      load();
      onRestore();
    } catch (e) {
      window.alert(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const permaDelete = async (node: WsNode) => {
    if (!window.confirm(`Permanently delete "${baseName(node.path)}"? This cannot be undone.`)) return;
    setBusy(node.path);
    try {
      await hardDeleteFile(workspaceId, node.path);
      load();
    } catch (e) {
      window.alert(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const emptyTrash = async () => {
    if (!items?.length) return;
    if (!window.confirm(`Permanently delete all ${items.length} item(s)? This cannot be undone.`)) return;
    setBusy("__all__");
    try {
      await Promise.all(items.map((n) => hardDeleteFile(workspaceId, n.path).catch(() => {})));
      load();
    } finally {
      setBusy(null);
    }
  };

  if (items === null) {
    return (
      <div className="flex items-center justify-center h-24">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--ide-muted)]" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Trash2 className="h-7 w-7 text-[var(--ide-muted)]" />
        <p className="text-[11px] text-[var(--ide-muted)]">Trash is empty</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Empty-all action */}
      <div className="flex items-center justify-end px-2 py-1 shrink-0 border-b border-[var(--ide-border)]">
        <button
          type="button"
          onClick={emptyTrash}
          disabled={busy === "__all__"}
          className="text-[10px] text-red-400 hover:text-red-300 disabled:opacity-40 transition-colors"
        >
          {busy === "__all__"
            ? <Loader2 className="h-3 w-3 animate-spin inline" />
            : "Empty Trash"}
        </button>
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-auto">
        {items.map((node) => {
          const isBusy = busy === node.path;
          return (
            <div
              key={node.path}
              className="group flex items-center gap-1.5 h-8 px-2 text-[12px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
            >
              {node.type === "folder"
                ? <Folder   className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
                : <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ide-muted)]" />
              }
              <span className="flex-1 truncate" title={node.path}>
                {baseName(node.path)}
              </span>
              <span className="text-[10px] text-[var(--ide-muted)] shrink-0 mr-0.5">
                {relativeTime(node.deletedAt)}
              </span>

              {/* Restore */}
              <button
                type="button"
                onClick={() => restore(node)}
                disabled={isBusy}
                title={`Restore ${baseName(node.path)}`}
                className="h-5 w-5 inline-flex items-center justify-center rounded text-emerald-400 hover:bg-emerald-900/40 opacity-0 group-hover:opacity-100 disabled:opacity-40 transition-all"
              >
                {isBusy
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RotateCcw className="h-3 w-3" />}
              </button>

              {/* Permanently delete */}
              <button
                type="button"
                onClick={() => permaDelete(node)}
                disabled={isBusy}
                title="Delete permanently"
                className="h-5 w-5 inline-flex items-center justify-center rounded text-red-400 hover:bg-red-900/40 opacity-0 group-hover:opacity-100 disabled:opacity-40 transition-all"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TrashView;
