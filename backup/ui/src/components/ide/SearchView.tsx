"use client";

/**
 * SearchView — filename search over the workspace, reading from IndexedDB
 * (point 8: search files). Instant, offline-capable. Click a result to open it.
 * ISOLATION: new file under components/ide/.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Search, FileCode2 } from "lucide-react";
import { getAllNodes, type WsNode } from "@/lib/db/workspaceStore";

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const dirName = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

/* ========================================================================== *
 *  SearchView — instant filename search over IndexedDB nodes
 * ========================================================================== */
export function SearchView({
  workspaceId,
  onOpenFile,
}: {
  workspaceId: number;
  onOpenFile: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [nodes, setNodes] = useState<WsNode[]>([]);

  useEffect(() => {
    let cancelled = false;
    getAllNodes(workspaceId)
      .then((rows) => !cancelled && setNodes(rows))
      .catch(() => !cancelled && setNodes([]));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return nodes
      .filter((n) => n.type === "file" && n.path.toLowerCase().includes(term))
      .slice(0, 200);
  }, [q, nodes]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-2">
        <div className="flex items-center gap-1.5 h-8 px-2 rounded-md bg-[var(--ide-surface-2)] border border-[var(--ide-border)] focus-within:ring-1 focus-within:ring-violet-500">
          <Search className="h-3.5 w-3.5 text-[var(--ide-muted)] shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files by name…"
            className="flex-1 bg-transparent text-xs text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {q.trim() === "" ? (
          <p className="px-3 py-2 text-[11px] text-[var(--ide-muted)]">Type to search files.</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-[var(--ide-muted)]">No matching files.</p>
        ) : (
          <ul>
            {results.map((n) => (
              <li key={n.path}>
                <button
                  type="button"
                  onClick={() => onOpenFile(n.path)}
                  title={`/${n.path}`}
                  className="flex flex-col items-start w-full px-3 py-1 text-left hover:bg-[var(--ide-hover)]"
                >
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--ide-text)]">
                    <FileCode2 className="h-3.5 w-3.5 text-[var(--ide-muted)] shrink-0" />
                    {baseName(n.path)}
                  </span>
                  <span className="pl-5 text-[10px] text-[var(--ide-muted)] truncate max-w-full">
                    {dirName(n.path) || "/"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default SearchView;
