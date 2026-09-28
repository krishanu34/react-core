"use client";

import React, { useState, useCallback } from "react";
import type { CBv2PipelineRun } from "@/types/code-builder-v2";
import {
  History,
  Download,
  Clock,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Loader2,
  XCircle,
  Play,
  ChevronDown,
  ChevronRight,
  Archive,
  HardDrive,
  Timer,
  Layers,
  Eye,
} from "lucide-react";
import { useHistoryPanelRuns } from "@/hooks/useMonitoringQueries";

const CODEBUILDER_API_BASE = "/cb-api";
const LEGACY_API_BASE = "/lm-api";

/* ── Props ────────────────────────────────────────────────────────────── */

interface HistoryPanelProps {
  projectId?: number | null;
  sessionId?: number | null;
  mode?: "codebuilder" | "legacy-modernization";
  title?: string;
  emptyText?: string;
  onViewRun?: (run: CBv2PipelineRun) => void;
}

/* ── Status Icon ──────────────────────────────────────────────────────── */

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />;
    case "running":
      return <Loader2 className="w-3.5 h-3.5 text-cbv2-accent animate-spin" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    case "cancelled":
      return <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />;
    default:
      return <Clock className="w-3.5 h-3.5 text-cbv2-text-dim" />;
  }
}

/* ── Format helpers ───────────────────────────────────────────────────── */

function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseServerDate(dateStr: string): Date {
  // Server may emit:
  //   - naive UTC ISO  "2026-05-21T10:30:00"           (DB rows)
  //   - UTC with Z     "2026-05-21T10:30:00Z"
  //   - UTC with off   "2026-05-21T10:30:00+00:00"     (in-memory v3 runs)
  // Treat anything without an explicit timezone marker as UTC.
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(dateStr);
  return new Date(hasTz ? dateStr : dateStr + "Z");
}

function formatDate(dateStr: string): string {
  const d = parseServerDate(dateStr);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Run Detail (expanded) ────────────────────────────────────────────── */

function RunDetail({ run, onDownload, onView }: { run: CBv2PipelineRun; onDownload: (run: CBv2PipelineRun) => void; onView?: (run: CBv2PipelineRun) => void }) {
  return (
    <div className="px-3 pb-3 space-y-2">
      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-cbv2-text-dim bg-cbv2-input rounded px-2 py-1.5">
          <FileCode className="w-3 h-3" />
          <span>{run.files_generated}/{run.files_planned} files</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-cbv2-text-dim bg-cbv2-input rounded px-2 py-1.5">
          <Timer className="w-3 h-3" />
          <span>{formatDuration(run.duration_seconds)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-cbv2-text-dim bg-cbv2-input rounded px-2 py-1.5">
          <HardDrive className="w-3 h-3" />
          <span>{formatSize(run.total_size_bytes)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-cbv2-text-dim bg-cbv2-input rounded px-2 py-1.5">
          <Layers className="w-3 h-3" />
          <span>{run.pipeline_type}</span>
        </div>
      </div>

      {/* Error */}
      {run.error_message && (
        <div className={`flex items-start gap-1.5 text-[10px] rounded px-2 py-1.5 ${
          run.error_message.includes("Server restarted")
            ? "text-yellow-400 bg-yellow-500/10"
            : "text-red-400 bg-red-500/10"
        }`}>
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          <span className="break-words">{run.error_message}</span>
        </div>
      )}

      {/* Prompt preview */}
      <div className="text-[10px] text-cbv2-text-dim bg-cbv2-input rounded px-2 py-1.5">
        <span className="text-cbv2-text font-medium">Prompt: </span>
        {run.prompt_description.length > 120
          ? run.prompt_description.slice(0, 120) + "..."
          : run.prompt_description}
      </div>

      {/* Actions */}
      <div className="flex gap-1.5">
        {(run.status === "completed" || run.status === "failed") && (
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded bg-cbv2-accent/15 text-cbv2-accent text-[11px] hover:bg-cbv2-accent/25 transition-colors"
            onClick={() => onDownload(run)}
          >
            <Download className="w-3 h-3" />
            Download ZIP
          </button>
        )}
        {onView && (run.status === "completed" || run.status === "failed") && (
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded bg-cbv2-input text-cbv2-text text-[11px] hover:bg-cbv2-hover transition-colors"
            onClick={() => onView(run)}
          >
            <Eye className="w-3 h-3" />
            View Files
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Main HistoryPanel ────────────────────────────────────────────────── */

export default function HistoryPanel({
  projectId,
  sessionId,
  mode = "codebuilder",
  title = "Pipeline History",
  emptyText = "Generate code to see history here.",
  onViewRun,
}: HistoryPanelProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: runs = [], isLoading: loading, refetch } = useHistoryPanelRuns(mode, projectId, sessionId);

  const handleDownload = useCallback(async (run: CBv2PipelineRun) => {
    try {
      const base = mode === "legacy-modernization" ? LEGACY_API_BASE : CODEBUILDER_API_BASE;
      const path = mode === "legacy-modernization"
        ? `${base}/legacy-modernization/runs/${run.run_id}/download`
        : `${base}/runs/${run.run_id}/download`;
      const res = await fetch(path);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${run.project_name || "code"}-${run.run_id.slice(0, 8)}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // silent
    }
  }, []);

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-cbv2-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-cbv2-accent" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">
            {title}
          </span>
        </div>
        <button
          className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
          onClick={() => refetch()}
          title="Refresh"
        >
          <Loader2 className={["w-3.5 h-3.5", loading ? "animate-spin" : ""].join(" ")} />
        </button>
      </div>

      {/* Run List */}
      <div className="flex-1 overflow-y-auto cbv2-scrollbar">
        {loading && runs.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-cbv2-text-dim text-[11px]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading history...
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-cbv2-text-dim">
            <Archive className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-[11px]">No pipeline runs yet.</p>
            <p className="text-[10px] mt-1">{emptyText}</p>
          </div>
        ) : (
          <div className="py-1">
            {runs.map((run) => {
              const isExpanded = expandedId === run.id;
              return (
                <div key={run.id} className="border-b border-cbv2-border last:border-b-0">
                  {/* Summary row */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="w-full text-left flex items-center gap-2 px-4 py-2.5 hover:bg-cbv2-hover transition-colors cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : run.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedId(isExpanded ? null : run.id);
                      }
                    }}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3 text-cbv2-text-dim shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-cbv2-text-dim shrink-0" />
                    )}
                    <StatusIcon status={run.status} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium truncate">
                        {run.project_name}
                      </div>
                      <div className="text-[10px] text-cbv2-text-dim flex items-center gap-2 mt-0.5">
                        <span>{formatDate(run.started_at)}</span>
                        <span>·</span>
                        <span>{run.files_generated} files</span>
                        {run.zip_size_bytes && (
                          <>
                            <span>·</span>
                            <span>{formatSize(run.zip_size_bytes)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {(run.status === "completed" || run.status === "failed") && (
                      <button
                        className="p-1 rounded hover:bg-cbv2-accent/20 text-cbv2-text-dim hover:text-cbv2-accent transition-colors shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(run);
                        }}
                        title="Download ZIP"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <RunDetail run={run} onDownload={handleDownload} onView={onViewRun} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer — summary */}
      {runs.length > 0 && (
        <div className="px-4 py-2 border-t border-cbv2-border text-[10px] text-cbv2-text-dim shrink-0">
          {runs.length} run(s) · {runs.filter((r) => r.status === "completed").length} completed · {runs.filter((r) => r.status === "failed").length} failed
        </div>
      )}
    </div>
  );
}
