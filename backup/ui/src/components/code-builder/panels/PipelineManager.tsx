"use client";

import { useCallback, useState } from "react";
import {
  Activity,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  Download,
  FolderOpen,
  Clock,
  Rocket,
  Factory,
  GitMerge,
  Bug,
  ArrowRightLeft,
  Brain,
  Boxes,
  RefreshCw,
  Eye,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/store/useCodeBuilderStore";
import {
  downloadPipelineOutput,
  getPipelineStatus,
} from "@/lib/code-builder-api";
import { usePipelineRuns, useDeletePipelineRun } from "@/hooks/useCodeBuilderQueries";
import queryKeys from "@/lib/query-keys";
import type { PipelineMode, PipelineRun } from "@/types/code-builder";
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

const STATUS_BADGE: Record<string, string> = {
  running:   "bg-blue-500/20 text-blue-300",
  completed: "bg-emerald-500/20 text-emerald-300",
  failed:    "bg-red-500/20 text-red-300",
  pending:   "bg-yellow-500/20 text-yellow-300",
};

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/* ═══════════════════════════════════════════════════════
 * PipelineManager — Sidebar panel listing all pipeline runs
 * ═══════════════════════════════════════════════════════ */
export default function PipelineManager() {
  const {
    setOutputRunId,
    setActiveSidebarTab,
    setCurrentRun,
    currentRun,
  } = useStore();

  const runsQuery = usePipelineRuns();
  const runs = runsQuery.data ?? [];
  const loading = runsQuery.isLoading;
  const deleteMutation = useDeletePipelineRun();
  const [downloading, setDownloading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /* Delete a run */
  const handleDelete = useCallback((runId: string) => {
    deleteMutation.mutate(runId, {
      onSuccess: () => {
        if (currentRun?.run_id === runId) setCurrentRun(null);
      },
    });
  }, [currentRun, setCurrentRun, deleteMutation]);

  /* Download output zip */
  const handleDownload = useCallback(async (runId: string) => {
    setDownloading(runId);
    try {
      await downloadPipelineOutput(runId);
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(null);
    }
  }, []);

  /* View output tree in sidebar */
  const handleViewOutput = useCallback((runId: string) => {
    setOutputRunId(runId);
    setActiveSidebarTab("output");
  }, [setOutputRunId, setActiveSidebarTab]);

  /* Load full status as current run */
  const handleSetActive = useCallback(async (runId: string) => {
    try {
      const status = await queryClient.fetchQuery({
        queryKey: queryKeys.codeBuilder.runStatus(runId),
        queryFn: () => getPipelineStatus(runId),
      });
      setCurrentRun(status as PipelineRun);
    } catch (err) {
      console.error("Failed to load run status:", err);
    }
  }, [queryClient, setCurrentRun]);

  return (
    <div className="h-full flex flex-col bg-editor-sidebar">
      {/* Header */}
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <Activity size={13} className="text-editor-accent" />
          <span>Pipelines</span>
          <span className="text-[10px] text-gray-500 ml-1">({runs.length})</span>
        </div>
        <button
          onClick={() => runsQuery.refetch()}
          disabled={runsQuery.isFetching}
          className="p-1 rounded hover:bg-editor-active transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} className={runsQuery.isFetching ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {runs.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <Activity size={28} className="opacity-20 mb-2" />
            <p className="text-[12px]">No pipeline runs yet</p>
            <p className="text-[10px] opacity-60 mt-0.5">Start a build from the Code Builder</p>
          </div>
        )}

        {loading && runs.length === 0 && (
          <div className="flex items-center justify-center h-24">
            <Loader2 size={18} className="animate-spin text-editor-accent" />
          </div>
        )}

        <div className="space-y-0.5 p-1">
          {runs.map((run) => {
            const mode = run.mode as PipelineMode;
            const isActive = currentRun?.run_id === run.run_id;
            const isRunning = run.status === "running";
            const isCompleted = run.status === "completed";

            return (
              <div
                key={run.run_id}
                className={`group rounded-md border transition-colors cursor-pointer
                  ${isActive
                    ? "bg-editor-active/60 border-editor-accent/40"
                    : "bg-editor-bg/50 border-editor-border hover:bg-editor-active/30 hover:border-editor-border"
                  }`}
                onClick={() => handleSetActive(run.run_id)}
              >
                {/* Top row: mode + status */}
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className={`shrink-0 ${MODE_COLORS[mode]}`}>
                    {MODE_ICONS[mode]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium text-gray-200 truncate">
                        {PIPELINE_LABELS[mode]}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                        STATUS_BADGE[run.status] || "bg-gray-500/20 text-gray-400"
                      }`}>
                        {isRunning && <Loader2 size={8} className="inline animate-spin mr-0.5" />}
                        {run.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-gray-500 mt-0.5">
                      <span className="flex items-center gap-0.5">
                        <Clock size={9} />
                        {formatTime(run.created_at)}
                      </span>
                      {run.duration_ms > 0 && (
                        <span>{formatDuration(run.duration_ms)}</span>
                      )}
                      <span className="text-gray-600 truncate">{run.run_id}</span>
                    </div>
                  </div>
                </div>

                {/* Action buttons (visible on hover / when active) */}
                <div className={`flex items-center gap-1 px-2.5 pb-1.5 ${
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                } transition-opacity`}>
                  {isCompleted && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleViewOutput(run.run_id); }}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]
                                   bg-editor-input hover:bg-editor-border text-gray-300 transition-colors"
                        title="View output files"
                      >
                        <FolderOpen size={10} /> Output
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownload(run.run_id); }}
                        disabled={downloading === run.run_id}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]
                                   bg-editor-input hover:bg-editor-border text-gray-300 transition-colors
                                   disabled:opacity-50"
                        title="Download output ZIP"
                      >
                        {downloading === run.run_id
                          ? <Loader2 size={10} className="animate-spin" />
                          : <Download size={10} />}
                        ZIP
                      </button>
                    </>
                  )}
                  {!isRunning && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(run.run_id); }}
                      disabled={deleteMutation.isPending && deleteMutation.variables === run.run_id}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]
                                 bg-red-600/10 hover:bg-red-600/20 text-red-400 transition-colors
                                 disabled:opacity-50 ml-auto"
                      title="Delete run"
                    >
                      {(deleteMutation.isPending && deleteMutation.variables === run.run_id)
                        ? <Loader2 size={10} className="animate-spin" />
                        : <Trash2 size={10} />}
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
