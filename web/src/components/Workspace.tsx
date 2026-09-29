"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadProjectId, saveProjectId } from "@/lib/project";
import { Chat } from "./Chat";
import { FileEditor } from "./FileEditor";
import { FileExplorer } from "./FileExplorer";
import { ProjectSwitcher } from "./ProjectSwitcher";

const LEFT_KEY = "react-core.panel.left";
const RIGHT_KEY = "react-core.panel.right";
const LEFT = { def: 256, min: 200, max: 480 };
const RIGHT = { def: 520, min: 360, max: 780 };

function loadWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function Workspace() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(LEFT.def);
  const [rightWidth, setRightWidth] = useState(RIGHT.def);
  const hydrated = useRef(false);

  useEffect(() => {
    setProjectId(loadProjectId());
    setLeftWidth(loadWidth(LEFT_KEY, LEFT.def));
    setRightWidth(loadWidth(RIGHT_KEY, RIGHT.def));
    hydrated.current = true;
  }, []);

  // Persist panel widths after hydration (never overwrite stored values on mount).
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(LEFT_KEY, String(leftWidth));
    } catch {
      // no-op
    }
  }, [leftWidth]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(RIGHT_KEY, String(rightWidth));
    } catch {
      // no-op
    }
  }, [rightWidth]);

  const handleThreadIdChange = useCallback((tid: string | null) => {
    setThreadId(tid);
  }, []);

  const handleRunFinished = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleProjectChange = useCallback((pid: string | null) => {
    setProjectId(pid);
    saveProjectId(pid);
  }, []);

  const editorOpen = !!(selectedPath && threadId);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div
        style={{ width: leftWidth }}
        className="flex min-h-0 shrink-0 flex-col"
      >
        <FileExplorer
          threadId={threadId}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          refreshKey={refreshKey}
        />
      </div>

      <ResizeHandle
        ariaLabel="Resize artefacts panel"
        width={leftWidth}
        min={LEFT.min}
        max={LEFT.max}
        sign={1}
        onChange={setLeftWidth}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="bell-glass sticky top-0 z-10 flex items-center gap-3 border-b border-bell-border px-4 py-2.5 sm:px-6">
          <span className="text-xs font-semibold uppercase tracking-wide text-bell-muted">
            Project
          </span>
          <ProjectSwitcher projectId={projectId} onChange={handleProjectChange} />
        </div>
        <Chat
          projectId={projectId}
          onThreadIdChange={handleThreadIdChange}
          onRunFinished={handleRunFinished}
          onOpenArtefact={setSelectedPath}
        />
      </div>

      {editorOpen && (
        <>
          <ResizeHandle
            ariaLabel="Resize editor panel"
            width={rightWidth}
            min={RIGHT.min}
            max={RIGHT.max}
            sign={-1}
            onChange={setRightWidth}
          />
          <div
            style={{ width: rightWidth }}
            className="flex min-h-0 shrink-0 flex-col"
          >
            <FileEditor
              key={`${threadId}:${selectedPath}`}
              threadId={threadId}
              path={selectedPath}
              onClose={() => setSelectedPath(null)}
              onSaved={() => setRefreshKey((k) => k + 1)}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface ResizeHandleProps {
  width: number;
  min: number;
  max: number;
  /** +1 when the panel is left of the handle (drag right = grow); -1 when right of it. */
  sign: 1 | -1;
  onChange: (w: number) => void;
  ariaLabel: string;
}

function ResizeHandle({
  width,
  min,
  max,
  sign,
  onChange,
  ariaLabel,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(width);

  const clamp = useCallback(
    (w: number) => Math.max(min, Math.min(max, w)),
    [min, max],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = width;
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX.current) * sign;
      onChange(clamp(startW.current + dx));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false); // the effect below persists the settled width
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const nudge = (delta: number) => onChange(clamp(width + delta * sign));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") nudge(-16);
        else if (e.key === "ArrowRight") nudge(16);
      }}
      className={
        "group relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center " +
        (dragging ? "bg-bell-blue/20" : "hover:bg-bell-blue/10")
      }
    >
      <span
        aria-hidden
        className={
          "h-10 w-0.5 rounded-full transition-colors " +
          (dragging ? "bg-bell-blue" : "bg-bell-border group-hover:bg-bell-blue/60")
        }
      />
    </div>
  );
}
