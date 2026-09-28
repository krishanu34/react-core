"use client";

import { useCallback, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  SkipForward,
  Clock,
  Activity,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  ChevronDown,
  ChevronUp,
  Rocket,
  Factory,
  GitMerge,
  Bug,
  ArrowRightLeft,
  Brain,
  Boxes,
  FileText,
  Eye,
  Terminal,
  Network,
  TreeDeciduous,
  Scan,
  Shield,
  GitCompare,
  FileCode,
  Database,
} from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";
import { respondToGate, getGateReport, getRunReports, readReportFile, getRunDiffs } from "@/lib/code-builder-api";
import type { StepStatus, PipelineStep, PipelineMode, HitlGate } from "@/types/code-builder";
import { PIPELINE_LABELS } from "@/types/code-builder";

/* ── Mode icon/color maps ──────────────────────────────── */
const MODE_ICONS: Record<PipelineMode, React.ReactNode> = {
  greenfield:   <Rocket size={13} />,
  brownfield:   <Factory size={13} />,
  hybrid:       <GitMerge size={13} />,
  hotfix:       <Bug size={13} />,
  migration:    <ArrowRightLeft size={13} />,
  code_intel:   <Brain size={13} />,
  microservice: <Boxes size={13} />,
};

const MODE_COLORS: Record<PipelineMode, string> = {
  greenfield:   "text-emerald-400",
  brownfield:   "text-amber-400",
  hybrid:       "text-purple-400",
  hotfix:       "text-red-400",
  migration:    "text-blue-400",
  code_intel:   "text-cyan-400",
  microservice: "text-orange-400",
};

const MODE_BG: Record<PipelineMode, string> = {
  greenfield:   "bg-emerald-500/20",
  brownfield:   "bg-amber-500/20",
  hybrid:       "bg-purple-500/20",
  hotfix:       "bg-red-500/20",
  migration:    "bg-blue-500/20",
  code_intel:   "bg-cyan-500/20",
  microservice: "bg-orange-500/20",
};

function StepIcon({ status, size = 16 }: { status: StepStatus; size?: number }) {
  switch (status) {
    case "completed": return <CheckCircle2 size={size} className="text-emerald-400" />;
    case "running":   return <Loader2 size={size} className="text-editor-accent animate-spin" />;
    case "failed":    return <XCircle size={size} className="text-red-400" />;
    case "skipped":   return <SkipForward size={size} className="text-gray-500" />;
    default:          return <Circle size={size} className="text-gray-600" />;
  }
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/* ── Horizontal step chip ──────────────────────────────── */

/* Stage-specific icon map for visual enhancement */
const STAGE_ICONS: Record<string, React.ReactNode> = {
  "Input Processing":    <Scan size={10} />,
  "Codebase Scan":       <Scan size={10} />,
  "AST Analysis":        <TreeDeciduous size={10} />,
  "Dependency Mapping":  <Network size={10} />,
  "Tech Stack Detection":<Database size={10} />,
  "Impact Analysis":     <GitCompare size={10} />,
  "Code Modification":   <FileCode size={10} />,
  "Security Scan":       <Shield size={10} />,
  "CI Pipeline":         <Terminal size={10} />,
  "Deploy Simulation":   <Rocket size={10} />,
  "Code Generation":     <FileCode size={10} />,
  "Test Generation":     <CheckCircle2 size={10} />,
  "Source Analysis":     <Scan size={10} />,
  "Target Specification":<FileText size={10} />,
  "Code Transformation": <ArrowRightLeft size={10} />,
  "Service Discovery":   <Network size={10} />,
  "Service Design":      <Boxes size={10} />,
  "Project Scan":        <Scan size={10} />,
  "Structure Analysis":  <TreeDeciduous size={10} />,
  "Code Analysis":       <Brain size={10} />,
  "API Analysis":        <Network size={10} />,
};

function StepChip({ step, index, isLast }: { step: PipelineStep; index: number; isLast: boolean }) {
  const stageIcon = STAGE_ICONS[step.name];
  
  return (
    <div className="flex items-center shrink-0">
      <div className="group relative flex flex-col items-center">
        {/* icon + badge */}
        <div className={`
          flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all
          ${step.status === "running"
            ? "bg-editor-accent/15 text-editor-accent ring-1 ring-editor-accent/40"
            : step.status === "completed"
            ? "bg-emerald-500/10 text-emerald-400"
            : step.status === "failed"
            ? "bg-red-500/10 text-red-400"
            : "bg-editor-border/40 text-gray-500"
          }
        `}>
          <StepIcon status={step.status} size={12} />
          {stageIcon && <span className="opacity-70">{stageIcon}</span>}
          <span>{step.name}</span>
          {step.duration_ms !== undefined && step.duration_ms > 0 && (
            <span className="text-[9px] opacity-60 flex items-center gap-0.5">
              <Clock size={8} />{formatDuration(step.duration_ms)}
            </span>
          )}
        </div>
        {/* error tooltip */}
        {step.error && (
          <div className="absolute top-full mt-1 left-0 z-50 max-w-[260px] bg-red-900/90 border border-red-500/30 text-red-200 text-[10px] px-2.5 py-1.5 rounded shadow-lg
                          opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
            {step.error}
          </div>
        )}
      </div>
      {/* connector between steps */}
      {!isLast && (
        <div className={`w-5 h-[2px] mx-0.5 shrink-0 rounded transition-colors
          ${step.status === "completed" ? "bg-emerald-400/50" : "bg-editor-border"}
        `} />
      )}
    </div>
  );
}

/* ── HITL Gate Card (inline) ───────────────────────────── */
function HitlGateCard({ gate }: { gate: HitlGate }) {
  const { currentRun, updateGate, setViewerReport, setViewerRunId, setMainView } = useStore();
  const [loadingReport, setLoadingReport] = useState(false);

  const handleRespond = useCallback(async (approved: boolean) => {
    if (!currentRun?.run_id) return;
    updateGate(gate.gate_id, approved ? "approved" : "rejected");
    try {
      await respondToGate(currentRun.run_id, gate.gate_id, approved);
    } catch (err) {
      console.error("Gate response failed:", err);
    }
  }, [currentRun, gate.gate_id, updateGate]);

  /* Open the report in the dedicated Report Viewer */
  const handleViewReport = useCallback(async () => {
    if (!currentRun?.run_id || !gate.report_file) return;
    setLoadingReport(true);
    try {
      const data = await getGateReport(currentRun.run_id, gate.report_file);
      setViewerReport({
        path: gate.report_file,
        content: data.content,
        language: data.language || "markdown",
        size: data.size,
      });
      setViewerRunId(currentRun.run_id);
      setMainView("report-viewer");
    } catch (err) {
      console.error("Failed to load gate report:", err);
      // Fallback: try to read as output file
      try {
        const data = await readReportFile(currentRun.run_id, gate.report_file);
        setViewerReport({
          path: gate.report_file,
          content: data.content,
          language: data.language || "markdown",
          size: data.size,
        });
        setViewerRunId(currentRun.run_id);
        setMainView("report-viewer");
      } catch (err2) {
        console.error("Fallback report load also failed:", err2);
      }
    } finally {
      setLoadingReport(false);
    }
  }, [currentRun, gate.gate_id, gate.report_file, setViewerReport, setViewerRunId, setMainView]);

  const isPending = gate.status === "pending";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 animate-fade-in shrink-0">
      {gate.status === "approved" ? (
        <ShieldCheck size={14} className="text-emerald-400 shrink-0" />
      ) : gate.status === "rejected" ? (
        <ShieldX size={14} className="text-red-400 shrink-0" />
      ) : (
        <ShieldAlert size={14} className="text-amber-400 animate-pulse shrink-0" />
      )}
      <span className="text-[11px] font-semibold text-amber-300 whitespace-nowrap">
        {gate.label}
      </span>

      {/* View Report button — opens the .md in the editor */}
      {gate.report_file && (
        <button
          onClick={handleViewReport}
          disabled={loadingReport}
          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium
                     bg-editor-active hover:bg-editor-input text-gray-300 hover:text-white transition-colors"
          title={`Preview ${gate.report_file}`}
        >
          {loadingReport ? <Loader2 size={10} className="animate-spin" /> : <Eye size={10} />}
          View Report
        </button>
      )}

      {isPending ? (
        <div className="flex items-center gap-1 ml-1">
          <button
            onClick={() => handleRespond(true)}
            className="flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            <CheckCircle2 size={10} /> Approve
          </button>
          <button
            onClick={() => handleRespond(false)}
            className="flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            <XCircle size={10} /> Reject
          </button>
        </div>
      ) : (
        <span className={`text-[10px] font-medium ml-1 ${
          gate.status === "approved" ? "text-emerald-400" : "text-red-400"
        }`}>
          {gate.status === "approved" ? "Approved" : "Rejected"}
        </span>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
 * PipelineTracker — Horizontal, collapsible panel
 *
 * Sits above the editor area in the dashboard.
 * Collapsed = single thin bar with mode badge + progress.
 * Expanded  = full horizontal step timeline + HITL gates.
 * ══════════════════════════════════════════════════════════ */
export default function PipelineTracker() {
  const { currentRun, pendingGates, runHistory, setMainView, setViewerRunId, setDiffFiles, setDiffRunId } = useStore();
  const [expanded, setExpanded] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const progress = currentRun?.progress ?? 0;
  const mode = currentRun?.mode;
  const hasRun = !!currentRun;

  /* Open report viewer for current run */
  const handleViewReports = useCallback(() => {
    if (!currentRun?.run_id) return;
    setViewerRunId(currentRun.run_id);
    setMainView("report-viewer");
  }, [currentRun, setViewerRunId, setMainView]);

  /* Open diff viewer for current run */
  const handleViewDiffs = useCallback(async () => {
    if (!currentRun?.run_id) return;
    setLoadingDiff(true);
    try {
      const diffs = await getRunDiffs(currentRun.run_id);
      setDiffFiles(diffs);
      setDiffRunId(currentRun.run_id);
      setMainView("diff-viewer");
    } catch (err) {
      console.error("Failed to load diffs:", err);
    } finally {
      setLoadingDiff(false);
    }
  }, [currentRun, setDiffFiles, setDiffRunId, setMainView]);

  /* nothing to show */
  if (!hasRun && runHistory.length === 0) return null;

  return (
    <div className="shrink-0 bg-editor-sidebar border-b border-editor-border animate-fade-in">
      {/* ─── Collapsed / always-visible bar ─── */}
      <div
        className="flex items-center gap-2 px-3 h-[32px] cursor-pointer hover:bg-editor-active/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Activity size={13} className="text-editor-accent shrink-0" />

        {mode && (
          <span className={`flex items-center gap-1 text-[11px] font-semibold shrink-0 ${MODE_COLORS[mode]}`}>
            {MODE_ICONS[mode]}
            {PIPELINE_LABELS[mode]}
          </span>
        )}

        {/* mini progress bar */}
        {hasRun && (
          <div className="flex-1 max-w-[300px] h-[4px] bg-editor-border rounded-full overflow-hidden mx-2">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                currentRun.status === "failed" ? "bg-red-400"
                : currentRun.status === "completed" ? "bg-emerald-400"
                : "bg-editor-accent"
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {hasRun && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
            currentRun.status === "running"    ? "bg-blue-500/20 text-blue-300"
            : currentRun.status === "completed" ? "bg-emerald-500/20 text-emerald-300"
            : currentRun.status === "failed"    ? "bg-red-500/20 text-red-300"
            : "bg-yellow-500/20 text-yellow-300"
          }`}>
            {currentRun.status} {currentRun.status === "running" ? `${Math.round(progress)}%` : ""}
          </span>
        )}

        {/* Quick action buttons when completed */}
        {currentRun?.status === "completed" && (
          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleViewReports}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium
                         bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 transition-colors"
              title="View all pipeline reports"
            >
              <FileText size={10} /> Reports
            </button>
            {(mode === "brownfield" || mode === "hybrid" || mode === "migration" || mode === "hotfix") && (
              <button
                onClick={handleViewDiffs}
                disabled={loadingDiff}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium
                           bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 transition-colors disabled:opacity-50"
                title="View code changes (old vs new)"
              >
                {loadingDiff ? <Loader2 size={10} className="animate-spin" /> : <GitCompare size={10} />} Diff
              </button>
            )}
          </div>
        )}

        {/* pending gate count */}
        {pendingGates.filter(g => g.status === "pending").length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium shrink-0 flex items-center gap-0.5">
            <ShieldAlert size={10} />
            {pendingGates.filter(g => g.status === "pending").length} gate{pendingGates.filter(g => g.status === "pending").length > 1 ? "s" : ""}
          </span>
        )}

        {/* last run history badge when idle */}
        {!hasRun && runHistory.length > 0 && (
          <span className="text-[11px] text-gray-400 flex items-center gap-1.5">
            <span className={MODE_COLORS[runHistory[0].mode]}>{MODE_ICONS[runHistory[0].mode]}</span>
            {PIPELINE_LABELS[runHistory[0].mode]}
            <span className={runHistory[0].status === "completed" ? "text-emerald-400" : "text-red-400"}>
              {runHistory[0].status}
            </span>
          </span>
        )}

        <div className="ml-auto shrink-0">
          {expanded ? <ChevronUp size={13} className="text-gray-500" /> : <ChevronDown size={13} className="text-gray-500" />}
        </div>
      </div>

      {/* ─── Expanded: horizontal timeline ─── */}
      {expanded && hasRun && (
        <div className="px-3 pb-2 space-y-2">
          {/* step chips — horizontal scrollable */}
          <div className="flex items-center overflow-x-auto pb-1 scrollbar-thin gap-0">
            {currentRun.steps.map((step, i) => (
              <StepChip key={step.name} step={step} index={i} isLast={i === currentRun.steps.length - 1} />
            ))}
          </div>

          {/* HITL gates, also horizontal */}
          {pendingGates.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
              <span className="text-[10px] text-amber-400 uppercase tracking-wider font-semibold shrink-0">Review:</span>
              {pendingGates.map((gate) => (
                <HitlGateCard key={gate.gate_id} gate={gate} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Expanded: run history when idle ─── */}
      {expanded && !hasRun && runHistory.length > 0 && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 overflow-x-auto">
            {runHistory.slice(0, 8).map((run) => (
              <div key={run.run_id} className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] shrink-0
                ${MODE_BG[run.mode]} ${MODE_COLORS[run.mode]}`}>
                {MODE_ICONS[run.mode]}
                <span className="text-gray-300">{PIPELINE_LABELS[run.mode]}</span>
                <span className={run.status === "completed" ? "text-emerald-400" : "text-red-400"}>
                  {run.status === "completed" ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
