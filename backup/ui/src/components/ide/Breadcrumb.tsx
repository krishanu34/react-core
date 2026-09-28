"use client";

/**
 * Breadcrumb — always-on path bar above the editor (AC5).
 *
 * Clicking any folder segment opens a dropdown (picker) showing that folder's
 * children. Clicking a file in the picker opens it; clicking a sub-folder drills
 * into it. This mirrors VS Code's breadcrumb navigation behaviour.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChevronRight, File as FileIcon, FileCode2, Folder } from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import { getChildren, type WsNode } from "@/lib/db/workspaceStore";

/* ========================================================================== *
 *  BreadcrumbPicker — dropdown showing a folder's children
 * ========================================================================== */

function BreadcrumbPicker({
  workspaceId,
  startPath,
  anchorX,
  anchorY,
  onPick,
  onClose,
}: {
  workspaceId: number;
  startPath: string;
  anchorX: number;
  anchorY: number;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState(startPath);
  const [nodes, setNodes] = useState<WsNode[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /* Reload children whenever the user drills into a sub-folder */
  useEffect(() => {
    let cancelled = false;
    setNodes(null);
    getChildren(workspaceId, currentPath)
      .then((rows) => !cancelled && setNodes(rows))
      .catch(() => !cancelled && setNodes([]));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentPath]);

  /* Close on outside click or Escape */
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const label = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

  /* Keep the picker inside the viewport horizontally */
  const left = Math.min(anchorX, (typeof window !== "undefined" ? window.innerWidth : 800) - 240);

  return (
    <div
      ref={ref}
      role="listbox"
      className="fixed z-50 w-56 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] shadow-xl py-1 overflow-auto max-h-64"
      style={{ left, top: anchorY + 2 }}
    >
      {nodes === null && (
        <div className="px-3 py-2 text-[11px] text-[var(--ide-muted)]">Loading…</div>
      )}
      {nodes?.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-[var(--ide-muted)] italic">
          Empty folder
        </div>
      )}
      {nodes?.map((node) => (
        <button
          key={node.path}
          type="button"
          role="option"
          onClick={() => {
            if (node.type === "folder") {
              setCurrentPath(node.path);
            } else {
              onPick(node.path);
              onClose();
            }
          }}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-[11px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] text-left"
        >
          {node.type === "folder" ? (
            <Folder className="h-3 w-3 shrink-0 text-amber-400" />
          ) : (
            <FileIcon className="h-3 w-3 shrink-0 text-[var(--ide-muted)]" />
          )}
          <span className="flex-1 truncate">{label(node.path)}</span>
          {node.type === "folder" && (
            <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ide-muted)]" />
          )}
        </button>
      ))}
    </div>
  );
}

/* ========================================================================== *
 *  Breadcrumb — always-on editor path bar (Workspace > … > file)
 * ========================================================================== */

export function Breadcrumb({
  path,
  workspaceId,
  onOpenFile,
}: {
  path: string | null;
  /** Provide workspaceId to enable click-to-navigate on folder segments. */
  workspaceId?: number | null;
  onOpenFile?: (path: string) => void;
}) {
  const { workspaceName } = useWorkspace();
  const segments = path ? path.split("/").filter(Boolean) : [];

  /* picker = { folderPath, x, y } or null */
  const [picker, setPicker] = useState<{
    folderPath: string;
    x: number;
    y: number;
  } | null>(null);

  const openPicker = useCallback(
    (folderPath: string, e: React.MouseEvent<HTMLButtonElement>) => {
      if (!workspaceId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      setPicker((prev) =>
        prev?.folderPath === folderPath
          ? null // toggle off if already open
          : { folderPath, x: rect.left, y: rect.bottom },
      );
    },
    [workspaceId],
  );

  const closePicker = useCallback(() => setPicker(null), []);

  return (
    <div className="relative flex items-center gap-0.5 h-7 px-2 text-[11px] text-[var(--ide-muted)] bg-[var(--ide-surface)] border-b border-[var(--ide-border)] overflow-hidden shrink-0">

      {/* Workspace root — clickable to browse root-level items */}
      {workspaceId ? (
        <button
          type="button"
          onClick={(e) => openPicker("", e)}
          className={`font-medium shrink-0 px-0.5 rounded hover:bg-[var(--ide-hover)] transition-colors ${
            picker?.folderPath === ""
              ? "text-violet-300 bg-violet-600/20"
              : "text-[var(--ide-text)]"
          }`}
        >
          {workspaceName || "Workspace"}
        </button>
      ) : (
        <span className="text-[var(--ide-text)] font-medium shrink-0">
          {workspaceName || "Workspace"}
        </span>
      )}

      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const segPath = segments.slice(0, i + 1).join("/");
        const isActive = picker?.folderPath === segPath;

        return (
          <span key={i} className="flex items-center gap-0.5 min-w-0 shrink-0">
            <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ide-muted)]" />

            {isLast ? (
              /* Last segment = the open file — show with file icon, not clickable */
              <>
                <FileCode2 className="h-3 w-3 shrink-0 text-violet-400" />
                <span className="truncate text-[var(--ide-text)]">{seg}</span>
              </>
            ) : workspaceId ? (
              /* Folder segments — clickable when workspaceId is available */
              <button
                type="button"
                onClick={(e) => openPicker(segPath, e)}
                className={`truncate px-0.5 rounded hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)] transition-colors max-w-[120px] ${
                  isActive
                    ? "text-violet-300 bg-violet-600/20"
                    : "text-[var(--ide-muted)]"
                }`}
              >
                {seg}
              </button>
            ) : (
              <span className="truncate text-[var(--ide-muted)] max-w-[120px]">{seg}</span>
            )}
          </span>
        );
      })}

      {segments.length === 0 && (
        <span className="text-[var(--ide-muted)] italic ml-1">no file open</span>
      )}

      {/* Dropdown picker */}
      {picker && workspaceId && (
        <BreadcrumbPicker
          workspaceId={workspaceId}
          startPath={picker.folderPath}
          anchorX={picker.x}
          anchorY={picker.y}
          onPick={(filePath) => {
            onOpenFile?.(filePath);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </div>
  );
}

export default Breadcrumb;
