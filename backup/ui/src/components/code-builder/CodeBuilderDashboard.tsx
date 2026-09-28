"use client";

import { useCallback, useRef } from "react";
import {
  Files,
  FolderArchive,
  Sparkles,
  PanelRightClose,
  PanelRightOpen,
  Activity,
  History,
  Brain,
} from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";
import FileExplorer, { OutputExplorer } from "@/components/code-builder/panels/FileExplorer";
import MonacoEditorPanel from "@/components/code-builder/panels/MonacoEditorPanel";
import AICodeBuilderPanel from "@/components/code-builder/panels/AICodeBuilderPanel";
import PipelineTracker from "@/components/code-builder/panels/PipelineTracker";
import PipelineManager from "@/components/code-builder/panels/PipelineManager";
import PipelineHistoryTab from "@/components/code-builder/panels/PipelineHistoryTab";
import ReportViewer from "@/components/code-builder/panels/ReportViewer";
import DiffViewer from "@/components/code-builder/panels/DiffViewer";
import TerminalView from "@/components/code-builder/panels/TerminalView";
import CodeIntelligencePanel from "@/components/code-builder/panels/CodeIntelligencePanel";

/* ────────────────────────────────────────────────────────
 * Resizable vertical divider
 * ──────────────────────────────────────────────────────── */
function VDivider({ onDrag }: { onDrag: (dx: number) => void }) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        onDrag(ev.clientX - lastX.current);
        lastX.current = ev.clientX;
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onDrag]
  );

  return (
    <div onMouseDown={onMouseDown}
      className="w-[3px] min-w-[3px] bg-editor-border hover:bg-editor-accent/60 active:bg-editor-accent cursor-col-resize transition-colors" />
  );
}

/* ────────────────────────────────────────────────────────
 * Activity bar icon button
 * ──────────────────────────────────────────────────────── */
function ActivityIcon({
  icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative w-full flex items-center justify-center py-2.5 transition-colors
        ${active ? "text-white border-l-2 border-editor-accent bg-editor-active/50" : "text-gray-500 hover:text-gray-300 border-l-2 border-transparent"}`}
      title={label}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-1.5 right-2 w-4 h-4 rounded-full bg-amber-500 text-[9px] text-white flex items-center justify-center font-bold">
          {badge}
        </span>
      )}
    </button>
  );
}

/* ────────────────────────────────────────────────────────
 * MAIN DASHBOARD
 *
 * Layout:
 * ┌──────────────────────────────────────────────────────┐
 * │ Title bar                                            │
 * ├────┬─────────────────────────────────────────────────┤
 * │    │ Pipeline Tracker (horizontal, collapsible)      │
 * │    ├──────────┬──────────────────┬───────────────────┤
 * │ A  │          │                  │                   │
 * │ B  │ Sidebar  │  Monaco Editor   │ AI Code Builder   │
 * │    │(explore/ │                  │                   │
 * │    │ output/  │                  │                   │
 * │    │ pipes)   │                  │                   │
 * ├────┴──────────┴──────────────────┴───────────────────┤
 * │ Status Bar                                           │
 * └──────────────────────────────────────────────────────┘
 * ──────────────────────────────────────────────────────── */
export default function CodeBuilderDashboard() {
  const {
    sidebarWidth,
    setSidebarWidth,
    rightPanelWidth,
    setRightPanelWidth,
    isSidebarOpen,
    isRightPanelOpen,
    activeSidebarTab,
    setActiveSidebarTab,
    toggleSidebar,
    toggleRightPanel,
    pendingGates,
    currentRun,
    isPipelineRunning,
    mainView,
    setMainView,
  } = useStore();

  const handleSidebarDrag = useCallback(
    (dx: number) => setSidebarWidth(Math.max(200, Math.min(500, sidebarWidth + dx))),
    [sidebarWidth, setSidebarWidth]
  );

  const handleRightDrag = useCallback(
    (dx: number) => setRightPanelWidth(Math.max(280, Math.min(600, rightPanelWidth - dx))),
    [rightPanelWidth, setRightPanelWidth]
  );

  const handleSidebarTabClick = (tab: "explorer" | "output" | "pipelines") => {
    if (tab === "pipelines") {
      // Open full-width pipeline history view
      setMainView("pipeline-history");
      return;
    }
    if (activeSidebarTab === tab && isSidebarOpen) {
      toggleSidebar();
    } else {
      setActiveSidebarTab(tab);
      if (!isSidebarOpen) toggleSidebar();
    }
    // If user clicks explorer/output while in a full-screen view, go back to editor
    if (mainView !== "editor") {
      setMainView("editor");
    }
  };

  const pendingCount = pendingGates.filter((g) => g.status === "pending").length;

  return (
    <div className="h-screen w-screen flex flex-col bg-editor-bg overflow-hidden select-none">
      {/* ── Title bar ──────────────────────────────── */}
      <header className="flex items-center justify-between px-4 h-[34px] bg-editor-sidebar border-b border-editor-border shrink-0">
        <div className="flex items-center gap-2.5">
          <Sparkles size={16} className="text-editor-accent" />
          <span className="text-[12px] font-semibold tracking-tight">MFA Code Builder</span>
          <span className="text-[10px] text-gray-500 border-l border-editor-border pl-2.5">
            Multi-Agent Framework IDE
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isPipelineRunning && (
            <div className="flex items-center gap-1.5 mr-3 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-[10px] text-blue-300 font-medium">Pipeline Running</span>
            </div>
          )}
          <button
            onClick={toggleRightPanel}
            className="p-1.5 rounded hover:bg-editor-active transition-colors text-gray-400 hover:text-gray-200"
            title={isRightPanelOpen ? "Hide Right Panel" : "Show Right Panel"}
          >
            {isRightPanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
      </header>

      {/* ── Main area ────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* Activity bar */}
        <div className="w-[48px] shrink-0 bg-[#333333] border-r border-editor-border flex flex-col items-center pt-1">
          <ActivityIcon
            icon={<Files size={20} />}
            label="Explorer"
            active={activeSidebarTab === "explorer" && isSidebarOpen && mainView === "editor"}
            onClick={() => handleSidebarTabClick("explorer")}
          />
          <ActivityIcon
            icon={<FolderArchive size={20} />}
            label="Generated Output"
            active={activeSidebarTab === "output" && isSidebarOpen && mainView === "editor"}
            onClick={() => handleSidebarTabClick("output")}
          />
          <ActivityIcon
            icon={<History size={20} />}
            label="Pipeline History"
            active={mainView === "pipeline-history"}
            onClick={() => handleSidebarTabClick("pipelines")}
            badge={pendingCount > 0 ? pendingCount : undefined}
          />
          <ActivityIcon
            icon={<Brain size={20} />}
            label="Code Intelligence"
            active={mainView === "code-intelligence"}
            onClick={() => setMainView("code-intelligence")}
          />
        </div>

        {/* Sidebar panel */}
        {isSidebarOpen && mainView === "editor" && (
          <>
            <div style={{ width: sidebarWidth }} className="shrink-0 overflow-hidden bg-editor-sidebar">
              {activeSidebarTab === "explorer" && <FileExplorer />}
              {activeSidebarTab === "output" && <OutputExplorer />}
              {activeSidebarTab === "pipelines" && <PipelineManager />}
            </div>
            <VDivider onDrag={handleSidebarDrag} />
          </>
        )}

        {/* Center column — switches between views */}
        <div className="flex-1 min-w-0 flex flex-col">
          {mainView === "pipeline-history" ? (
            <PipelineHistoryTab />
          ) : mainView === "report-viewer" ? (
            <ReportViewer />
          ) : mainView === "diff-viewer" ? (
            <DiffViewer />
          ) : mainView === "code-intelligence" ? (
            <CodeIntelligencePanel />
          ) : (
            <>
              {/* Horizontal pipeline tracker (above editor) */}
              <PipelineTracker />

              {/* Monaco editor (fills remaining space) */}
              <div className="flex-1 min-h-0">
                <MonacoEditorPanel />
              </div>

              {/* Terminal view — shows during active/completed pipeline */}
              <TerminalView />
            </>
          )}
        </div>

        {/* Right panel: Builder */}
        {isRightPanelOpen && mainView === "editor" && (
          <>
            <VDivider onDrag={handleRightDrag} />
            <div style={{ width: rightPanelWidth }} className="shrink-0 flex flex-col overflow-hidden bg-editor-sidebar">
              {/* AI Code Builder (fills entire right panel) */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <AICodeBuilderPanel />
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Status bar ───────────────────────────────── */}
      <footer className="flex items-center justify-between px-3 h-[22px] bg-editor-statusbar text-white text-[11px] shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            Connected
          </span>
          <span>MFA v1.0</span>
          {currentRun && (
            <span className="flex items-center gap-1">
              <Activity size={10} />
              {currentRun.mode} — {currentRun.status}
              {currentRun.progress > 0 && currentRun.status === "running" && (
                <span className="ml-1">{Math.round(currentRun.progress)}%</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <span className="flex items-center gap-1 text-amber-300">
              <Activity size={10} />
              {pendingCount} gate{pendingCount > 1 ? "s" : ""} pending
            </span>
          )}
          <span>FastAPI :8000</span>
          <span>Next.js :3000</span>
        </div>
      </footer>
    </div>
  );
}
