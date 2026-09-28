"use client";

import React, { useState, useCallback, useMemo } from "react";
import {
  History,
  Download,
  Clock,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Loader2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Archive,
  HardDrive,
  Timer,
  Layers,
  Eye,
  Code2,
  ArrowRightLeft,
  RotateCcw,
  Cloud,
  Search,
  X,
} from "lucide-react";
import { useHistoryPanelRuns } from "@/hooks/useMonitoringQueries";
import { useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import { authFetch } from "@/lib/auth";

const LEGACY_API_BASE = "/lm-api";

/* ── Run Type ─────────────────────────────────────────────────────────── */

export interface LegacyRun {
  id: number;
  run_id: string | null;
  project_id: number | null;
  session_id: number | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  current_phase: string | null;
  error_message: string | null;
  pipeline_type: string;
  project_name: string;
  prompt_description: string;
  output_dir: string | null;
  workspace_root: string | null;
  target_stack: string | null;
  zip_path: string | null;
  zip_size_bytes: number | null;
  files_planned: number;
  files_generated: number;
  files_on_disk: number;
  total_size_bytes: number;
  total_phases: number;
  completed_phases: number;
  error_count: number;
  blob_zip_url: string | null;
  generated_blob_prefix: string | null;
  codegen_run_id?: string | null;
  legacy_modernization_model_id?: number | null;
  legacy_modernization_model_vendor?: string | null;
  legacy_modernization_model_name?: string | null;
  legacy_modernization_model_label?: string | null;
  legacy_modernization_model_active?: boolean | null;
  storage_mode: string;
  summary: Record<string, unknown>;
  created_at: string | null;
}

/* ── Props ────────────────────────────────────────────────────────────── */

interface LegacyHistoryPanelProps {
  projectId?: number | null;
  onViewRun?: (run: LegacyRun) => void;
}

/* ── Status Icon ──────────────────────────────────────────────────────── */

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-4 h-4 text-green-400" />;
    case "running":
      return <Loader2 className="w-4 h-4 text-cbv2-accent animate-spin" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-400" />;
    case "cancelled":
      return <AlertCircle className="w-4 h-4 text-yellow-400" />;
    default:
      return <Clock className="w-4 h-4 text-cbv2-text-dim" />;
  }
}

function getStatusBorderColor(status: string): string {
  switch (status) {
    case "completed": return "border-l-green-500";
    case "running": return "border-l-cbv2-accent";
    case "failed": return "border-l-red-500";
    case "cancelled": return "border-l-yellow-500";
    default: return "border-l-cbv2-text-dim";
  }
}

/* ── Pipeline type badge ──────────────────────────────────────────────── */

function PipelineTypeBadge({ type }: { type: string }) {
  const isCodegen = type === "legacy_codegen";
  const isAnalysisOnly = type === "legacy_modernization";
  // Merged entries or standalone types
  const label = isCodegen ? "Code Gen" : isAnalysisOnly ? "Modernization" : "Modernization";
  const color = isCodegen
    ? "bg-blue-500/15 text-blue-400"
    : "bg-purple-500/15 text-purple-400";
  const Icon = isCodegen ? Code2 : ArrowRightLeft;
  return (
    <span
      className={[
        "inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded",
        color,
      ].join(" ")}
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}

/* ── Storage Mode Badge ───────────────────────────────────────────────── */

function StorageModeBadge({ mode, compact = false }: { mode: string; compact?: boolean }) {
  const isLocal = mode === "local";
  const isAzure = mode === "blob";
  const isBoth = mode === "both";

  if (isBoth) {
    return (
      <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <HardDrive className="w-2.5 h-2.5" />
        {!compact && "Local"}
        <span className="text-emerald-500/50">+</span>
        <Cloud className="w-2.5 h-2.5" />
        {!compact && "Azure"}
      </span>
    );
  }

  if (isAzure) {
    return (
      <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
        <Cloud className="w-2.5 h-2.5" />
        {compact ? "Azure" : "Azure Blob"}
      </span>
    );
  }

  // Default: local
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400 border border-gray-500/20">
      <HardDrive className="w-2.5 h-2.5" />
      {compact ? "Local" : "Local Disk"}
    </span>
  );
}

/* ── Format helpers ───────────────────────────────────────────────────── */

function formatDuration(seconds?: number | null): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatSize(bytes?: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isCompletedRun(run: LegacyRun): boolean {
  return getVisibleStatus(run) === "completed";
}

function isInterruptedRun(run: LegacyRun): boolean {
  return ["failed", "cancelled", "waiting_approval", "waiting_confirmation", "pending"].includes(getVisibleStatus(run));
}

function hasRestorableLocation(run: LegacyRun): boolean {
  return Boolean(run.run_id || run.workspace_root || run.output_dir || run.generated_blob_prefix || run.blob_zip_url);
}

function hasViewableFiles(run: LegacyRun): boolean {
  return Boolean(
    run.run_id ||
    run.codegen_run_id ||
    run.workspace_root ||
    run.output_dir ||
    run.generated_blob_prefix ||
    run.blob_zip_url ||
    run.files_generated > 0 ||
    run.files_on_disk > 0
  );
}

function getLegacyModelLabel(run: LegacyRun): string {
  const summary = run.summary ?? {};
  const configuredLabel = String(run.legacy_modernization_model_label ?? summary.legacy_modernization_model_label ?? "").trim();
  const modelName = String(run.legacy_modernization_model_name ?? summary.legacy_modernization_model_name ?? "").trim();
  const vendor = String(run.legacy_modernization_model_vendor ?? summary.legacy_modernization_model_vendor ?? "").trim();
  if (configuredLabel) return configuredLabel;
  if (modelName && vendor) return `${modelName} (${vendor})`;
  return modelName || vendor || "Model details unavailable";
}

function isRecoveryInterruptionMessage(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("server restarted") ||
    lower.includes("run interrupted") ||
    lower.includes("lost connection before completion") ||
    lower.includes("timed out")
  );
}

function getVisibleStatus(run: LegacyRun): string {
  if (run.status === "failed" && isRecoveryInterruptionMessage(run.error_message)) {
    return "cancelled";
  }
  return run.status;
}

function getVisibleErrorMessage(run: LegacyRun): string | null {
  const message = run.error_message?.trim();
  if (!message) return null;
  if (isRecoveryInterruptionMessage(message)) {
    return null;
  }
  return message;
}

/* ── Run Detail (expanded) ────────────────────────────────────────────── */

function RunDetail({
  run,
  onDownload,
  onView,
}: {
  run: LegacyRun;
  onDownload: (run: LegacyRun) => void;
  onView?: (run: LegacyRun) => void;
}) {
  const canViewFiles = Boolean(onView && isCompletedRun(run) && hasViewableFiles(run));
  const canRestore = Boolean(onView && isInterruptedRun(run) && hasRestorableLocation(run));
  const modelLabel = getLegacyModelLabel(run);
  const errorMessage = getVisibleErrorMessage(run);
  const visibleStatus = getVisibleStatus(run);

  return (
    <div className="px-3 pb-3 space-y-2.5 animate-fade-in">
      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-2 text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
          <FileCode className="w-3.5 h-3.5 text-blue-400" />
          <div>
            <div className="text-cbv2-text font-medium text-[11px]">{run.files_generated}/{run.files_planned}</div>
            <div className="text-[9px]">files</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
          <Timer className="w-3.5 h-3.5 text-amber-400" />
          <div>
            <div className="text-cbv2-text font-medium text-[11px]">{formatDuration(run.duration_seconds)}</div>
            <div className="text-[9px]">duration</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
          <HardDrive className="w-3.5 h-3.5 text-green-400" />
          <div>
            <div className="text-cbv2-text font-medium text-[11px]">{formatSize(run.total_size_bytes)}</div>
            <div className="text-[9px]">size</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
          <Layers className="w-3.5 h-3.5 text-purple-400" />
          <PipelineTypeBadge type={run.pipeline_type} />
        </div>
      </div>

      {/* Target stack */}
      {run.target_stack && (
        <div className="text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
          <span className="text-cbv2-text font-medium">Target: </span>
          {run.target_stack}
        </div>
      )}

      <div className="text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
        <span className="text-cbv2-text font-medium">Model: </span>
        {modelLabel}
      </div>

      {/* Error */}
      {errorMessage && (
        <div className="flex items-start gap-2 text-[10px] text-red-400 bg-red-500/10 rounded-lg px-2.5 py-2 border border-red-500/20">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="break-words">{errorMessage}</span>
        </div>
      )}

      {/* Goal / prompt preview */}
      {run.prompt_description && (
        <div className="text-[10px] text-cbv2-text-dim bg-cbv2-input/70 rounded-lg px-2.5 py-2 border border-cbv2-border/50">
          <span className="text-cbv2-text font-medium">Goal: </span>
          {run.prompt_description.length > 150
            ? run.prompt_description.slice(0, 150) + "..."
            : run.prompt_description}
        </div>
      )}

      {/* Current phase (if running) */}
      {run.status === "running" && run.current_phase && (
        <div className="flex items-center gap-2 text-[10px] text-cbv2-accent bg-cbv2-accent/10 rounded-lg px-2.5 py-2 border border-cbv2-accent/20">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="font-medium">{run.current_phase}</span>
        </div>
      )}

      {/* Storage mode + language info from summary */}
      <div className="flex items-center gap-2 flex-wrap">
        {run.storage_mode && (
          <StorageModeBadge mode={run.storage_mode} />
        )}
        {Boolean(run.summary?.primary_language) && (
          <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
            {String(run.summary.primary_language)}
          </span>
        )}
        {Boolean(run.summary?.analysis_mode) && (
          <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
            {String(run.summary.analysis_mode) === "generic_llm" ? "AI Analysis" : "Heuristic"}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {(run.zip_path || run.blob_zip_url) && visibleStatus === "completed" && (
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-cbv2-accent/15 text-cbv2-accent text-[11px] font-medium hover:bg-cbv2-accent/25 border border-cbv2-accent/20 transition-colors"
            onClick={() => onDownload(run)}
          >
            <Download className="w-3.5 h-3.5" />
            Download ZIP
          </button>
        )}
        {canViewFiles && (
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-cbv2-input text-cbv2-text text-[11px] font-medium hover:bg-cbv2-hover border border-cbv2-border transition-colors"
            onClick={() => onView?.(run)}
          >
            <Eye className="w-3.5 h-3.5" />
            View Files
          </button>
        )}
        {canRestore && (
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-[11px] font-medium hover:bg-emerald-500/25 border border-emerald-500/20 transition-colors"
            onClick={() => onView?.(run)}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restore Session
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Main Panel ───────────────────────────────────────────────────────── */

export default function LegacyHistoryPanel({
  projectId,
  onViewRun,
}: LegacyHistoryPanelProps) {
  const qc = useQueryClient();
  const {
    data: queryRuns,
    isLoading,
    isFetching,
    refetch: loadRuns,
  } = useHistoryPanelRuns("legacy-modernization", projectId);
  // Show the spinner for both the initial load and subsequent manual refreshes
  // so the user gets visual feedback when they click the refresh button.
  const loading = isLoading || isFetching;
  const handleRefresh = useCallback(async () => {
    try {
      await qc.invalidateQueries({
        queryKey: queryKeys.historyPanel("legacy-modernization", projectId),
      });
    } catch {
      // invalidate may throw if the query isn't mounted yet; ignore.
    }
    await loadRuns();
  }, [qc, loadRuns, projectId]);
  const runs = (queryRuns ?? []) as unknown as LegacyRun[];
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const DEFAULT_VISIBLE = 10;

  const filteredRuns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => {
      const haystack = [
        r.project_name,
        r.target_stack,
        r.run_id,
        r.pipeline_type,
        r.status,
        r.current_phase,
        r.prompt_description,
        getLegacyModelLabel(r),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [runs, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const visibleRuns = useMemo(() => {
    if (isSearching || showAll) return filteredRuns;
    return filteredRuns.slice(0, DEFAULT_VISIBLE);
  }, [filteredRuns, isSearching, showAll]);
  const hiddenCount = Math.max(0, filteredRuns.length - visibleRuns.length);

  const handleDownload = useCallback(async (run: LegacyRun) => {
    try {
      if (run.run_id) {
        const res = await authFetch(
          `${LEGACY_API_BASE}/legacy-modernization/runs/${run.run_id}/download`
        );
        if (res.ok) {
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await res.json();
            if (data.blob_zip_url) {
              window.open(data.blob_zip_url, "_blank");
              return;
            }
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${run.project_name || "legacy"}-${(run.run_id || "").slice(0, 8)}.zip`;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      // silent
    }
  }, []);

  const completed = runs.filter((r) => getVisibleStatus(r) === "completed").length;
  const failed = runs.filter((r) => getVisibleStatus(r) === "failed").length;
  const running = runs.filter((r) => getVisibleStatus(r) === "running").length;

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text overflow-hidden">
      {/* Header */}
      <div className="border-b border-cbv2-border shrink-0 cbv2-header-gradient">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-cbv2-accent/15 flex items-center justify-center">
              <History className="w-4 h-4 text-cbv2-accent" />
            </div>
            <div>
              <span className="text-[12px] font-semibold block">
                Modernization History
              </span>
              {runs.length > 0 && (
                <span className="text-[10px] text-cbv2-text-dim">
                  {isSearching
                    ? `${filteredRuns.length} match${filteredRuns.length === 1 ? "" : "es"} of ${runs.length}`
                    : runs.length > DEFAULT_VISIBLE && !showAll
                      ? `Showing top ${DEFAULT_VISIBLE} of ${runs.length}`
                      : `${runs.length} run${runs.length !== 1 ? "s" : ""}`}
                </span>
              )}
            </div>
          </div>
          <button
            className="p-1.5 rounded-lg hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors disabled:opacity-50"
            onClick={() => void handleRefresh()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh modernization history"
          >
            <Loader2
              className={[
                "w-3.5 h-3.5",
                loading ? "animate-spin" : "",
              ].join(" ")}
            />
          </button>
        </div>
        {runs.length > 0 && (
          <div className="px-4 pb-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-cbv2-text-dim absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects, target stack, run id..."
                className="w-full pl-8 pr-7 py-1.5 text-[11px] rounded-md bg-cbv2-input border border-cbv2-border focus:border-cbv2-accent/60 focus:outline-none text-cbv2-text placeholder:text-cbv2-text-dim"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
                  title="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Run List */}
      <div className="flex-1 overflow-y-auto cbv2-scrollbar">
        {loading && runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-cbv2-text-dim">
            <Loader2 className="w-6 h-6 animate-spin mb-3 text-cbv2-accent" />
            <p className="text-[11px]">Loading history...</p>
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-cbv2-text-dim">
            <div className="w-12 h-12 rounded-2xl bg-cbv2-input flex items-center justify-center mb-3">
              <Archive className="w-6 h-6 opacity-40" />
            </div>
            <p className="text-[12px] font-medium text-cbv2-text">No runs yet</p>
            <p className="text-[10px] mt-1 text-center max-w-[200px]">
              Run a legacy modernization pipeline to see history here.
            </p>
          </div>
        ) : (
          <div className="py-2 px-2 space-y-1">
            {visibleRuns.length === 0 && isSearching && (
              <div className="flex flex-col items-center justify-center py-10 text-cbv2-text-dim">
                <Search className="w-5 h-5 mb-2 opacity-40" />
                <p className="text-[11px]">No runs match &quot;{searchQuery}&quot;.</p>
              </div>
            )}
            {visibleRuns.map((run) => {
              const isExpanded = expandedId === run.id;
              const modelLabel = getLegacyModelLabel(run);
              const visibleStatus = getVisibleStatus(run);
              return (
                <div
                  key={run.id}
                  className={[
                    "rounded-lg border overflow-hidden transition-all duration-200 cbv2-interactive",
                    isExpanded ? "border-cbv2-accent/30 bg-cbv2-bg/50" : "border-cbv2-border/50 hover:border-cbv2-border",
                    `border-l-[3px] ${getStatusBorderColor(visibleStatus)}`,
                  ].join(" ")}
                >
                  {/* Summary row */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="w-full text-left flex items-center gap-2.5 px-3 py-2.5 hover:bg-cbv2-hover/50 transition-colors cursor-pointer"
                    onClick={() =>
                      setExpandedId(isExpanded ? null : run.id)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedId(isExpanded ? null : run.id);
                      }
                    }}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-cbv2-text-dim shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-cbv2-text-dim shrink-0" />
                    )}
                    <StatusIcon status={visibleStatus} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-semibold truncate">
                          {run.project_name}
                        </span>
                        <PipelineTypeBadge type={run.pipeline_type} />
                        {run.storage_mode && <StorageModeBadge mode={run.storage_mode} compact />}
                      </div>
                      <div className="text-[10px] text-cbv2-text-dim flex items-center gap-2 mt-0.5">
                        <span>
                          {run.started_at ? formatDate(run.started_at) : "—"}
                        </span>
                        {run.target_stack && (
                          <>
                            <span className="text-cbv2-border">·</span>
                            <span className="truncate max-w-[100px]">
                              {run.target_stack}
                            </span>
                          </>
                        )}
                        {run.files_generated > 0 && (
                          <>
                            <span className="text-cbv2-border">·</span>
                            <span className="text-cbv2-text">{run.files_generated} files</span>
                          </>
                        )}
                        {modelLabel && (
                          <>
                            <span className="text-cbv2-border">·</span>
                            <span className="truncate max-w-[130px] text-cbv2-text-dim">{modelLabel}</span>
                          </>
                        )}
                        {run.total_size_bytes > 0 && (
                          <>
                            <span className="text-cbv2-border">·</span>
                            <span>{formatSize(run.total_size_bytes)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {(run.zip_path || run.blob_zip_url) &&
                      visibleStatus === "completed" && (
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
                    <RunDetail
                      run={run}
                      onDownload={handleDownload}
                      onView={onViewRun}
                    />
                  )}
                </div>
              );
            })}
            {!isSearching && !showAll && hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full text-[11px] font-medium px-3 py-2 mt-1 rounded-lg border border-cbv2-border/60 text-cbv2-text-dim hover:text-cbv2-accent hover:border-cbv2-accent/40 hover:bg-cbv2-hover/40 transition-colors"
              >
                Show {hiddenCount} more run{hiddenCount === 1 ? "" : "s"}
              </button>
            )}
            {!isSearching && showAll && filteredRuns.length > DEFAULT_VISIBLE && (
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className="w-full text-[11px] font-medium px-3 py-2 mt-1 rounded-lg border border-cbv2-border/60 text-cbv2-text-dim hover:text-cbv2-accent hover:border-cbv2-accent/40 hover:bg-cbv2-hover/40 transition-colors"
              >
                Show only top {DEFAULT_VISIBLE}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      {runs.length > 0 && (
        <div className="px-4 py-2.5 border-t border-cbv2-border text-[10px] text-cbv2-text-dim shrink-0 flex items-center gap-3 bg-cbv2-bg/50">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span>{completed} completed</span>
          </div>
          {running > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cbv2-accent animate-pulse" />
              <span>{running} running</span>
            </div>
          )}
          {failed > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span>{failed} failed</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
