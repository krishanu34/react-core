"use client";

import { useCallback, useState } from "react";
import {
  Activity,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  Download,
  Eye,
  Clock,
  Rocket,
  Factory,
  GitMerge,
  Bug,
  ArrowRightLeft,
  Brain,
  Boxes,
  RefreshCw,
  ArrowLeft,
  FileText,
  GitCompare,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/store/useCodeBuilderStore";
import {
  downloadPipelineOutput,
  getPipelineStatus,
  getRunReports,
  getRunDiffs,
  readReportFile,
} from "@/lib/code-builder-api";
import { usePipelineRuns, useDeletePipelineRun } from "@/hooks/useCodeBuilderQueries";
import queryKeys from "@/lib/query-keys";
import type { PipelineMode, PipelineRun } from "@/types/code-builder";
import { PIPELINE_LABELS } from "@/types/code-builder";

/* ── Mode icon/color maps ──────────────────────────────── */
const MODE_ICONS: Record<PipelineMode, React.ReactNode> = {
  greenfield:   <Rocket size={14} />,
  brownfield:   <Factory size={14} />,
  hybrid:       <GitMerge size={14} />,
  hotfix:       <Bug size={14} />,
  migration:    <ArrowRightLeft size={14} />,
  code_intel:   <Brain size={14} />,
  microservice: <Boxes size={14} />,
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
  greenfield:   "bg-emerald-500/10",
  brownfield:   "bg-amber-500/10",
  hybrid:       "bg-purple-500/10",
  hotfix:       "bg-red-500/10",
  migration:    "bg-blue-500/10",
  code_intel:   "bg-cyan-500/10",
  microservice: "bg-orange-500/10",
};

const STATUS_BADGE: Record<string, { bg: string; text: string; dot: string }> = {
  running:   { bg: "bg-blue-500/15 border-blue-500/30",   text: "text-blue-300",    dot: "bg-blue-400 animate-pulse" },
  completed: { bg: "bg-emerald-500/15 border-emerald-500/30", text: "text-emerald-300", dot: "bg-emerald-400" },
  failed:    { bg: "bg-red-500/15 border-red-500/30",     text: "text-red-300",     dot: "bg-red-400" },
  pending:   { bg: "bg-yellow-500/15 border-yellow-500/30", text: "text-yellow-300",  dot: "bg-yellow-400 animate-pulse" },
};

function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", year: "numeric" })
      + " " + d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return "—"; }
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/* ═══════════════════════════════════════════════════════════
 * PipelineHistoryTab — Full-width dedicated pipeline history
 * ═══════════════════════════════════════════════════════════ */
export default function PipelineHistoryTab() {
  const {
    setMainView,
    setOutputRunId,
    setActiveSidebarTab,
    setCurrentRun,
    setViewerReport,
    setViewerRunId,
    setDiffFiles,
    setDiffRunId,
  } = useStore();

  const runsQuery = usePipelineRuns();
  const runs = runsQuery.data ?? [];
  const loading = runsQuery.isLoading;
  const deleteMutation = useDeletePipelineRun();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const queryClient = useQueryClient();

  /* Delete a run */
  const handleDelete = useCallback((runId: string) => {
    deleteMutation.mutate(runId);
  }, [deleteMutation]);

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
  const handleExplore = useCallback(async (runId: string) => {
    try {
      const status = await queryClient.fetchQuery({
        queryKey: queryKeys.codeBuilder.runStatus(runId),
        queryFn: () => getPipelineStatus(runId),
      });
      setCurrentRun(status as PipelineRun);
      setOutputRunId(runId);
      setActiveSidebarTab("output");
      setMainView("editor");
    } catch (err) {
      console.error("Failed to explore:", err);
    }
  }, [queryClient, setCurrentRun, setOutputRunId, setActiveSidebarTab, setMainView]);

  /* View reports */
  const handleViewReports = useCallback(async (runId: string) => {
    try {
      const { reports } = await getRunReports(runId);
      if (reports.length > 0) {
        // Open the first .md report
        const mdReport = reports.find(r => r.name.endsWith(".md")) || reports[0];
        const data = await readReportFile(runId, mdReport.path);
        setViewerReport({
          path: mdReport.path,
          content: data.content,
          language: data.language,
          size: data.size,
        });
        setViewerRunId(runId);
        setMainView("report-viewer");
      }
    } catch (err) {
      console.error("Failed to load reports:", err);
    }
  }, [setViewerReport, setViewerRunId, setMainView]);

  /* View diffs */
  const handleViewDiffs = useCallback(async (runId: string) => {
    try {
      const diffs = await getRunDiffs(runId);
      setDiffFiles(diffs);
      setDiffRunId(runId);
      setMainView("diff-viewer");
    } catch (err) {
      console.error("Failed to load diffs:", err);
    }
  }, [setDiffFiles, setDiffRunId, setMainView]);

  /* Filtered and paginated runs */
  const filtered = runs.filter(r => {
    if (filterMode !== "all" && r.mode !== filterMode) return false;
    if (filterStatus !== "all" && r.status !== filterStatus) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        r.run_id?.toLowerCase().includes(q) ||
        r.project_name?.toLowerCase().includes(q) ||
        r.request?.toLowerCase().includes(q) ||
        r.mode?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const MODES: PipelineMode[] = ["greenfield", "brownfield", "hybrid", "hotfix", "migration", "code_intel", "microservice"];

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      {/* ── Header bar ─── */}
      <div className="flex items-center gap-3 px-5 py-3 bg-editor-sidebar border-b border-editor-border shrink-0">
        <button
          onClick={() => setMainView("editor")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                     bg-editor-input border border-editor-border hover:bg-editor-active
                     text-gray-300 hover:text-white transition-colors"
        >
          <ArrowLeft size={13} /> Back to Editor
        </button>

        <div className="flex items-center gap-2 ml-2">
          <Activity size={16} className="text-editor-accent" />
          <h1 className="text-sm font-semibold text-white">Pipeline History</h1>
          <span className="text-xs text-gray-500">({filtered.length} runs)</span>
        </div>

        <div className="flex-1" />

        {/* filters */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search runs..."
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
              className="pl-7 pr-3 py-1.5 rounded-md text-xs bg-editor-input border border-editor-border
                         text-gray-300 placeholder-gray-500 focus:outline-none focus:border-editor-accent w-[200px]"
            />
          </div>

          <select
            value={filterMode}
            onChange={e => { setFilterMode(e.target.value); setPage(1); }}
            className="px-2 py-1.5 rounded-md text-xs bg-editor-input border border-editor-border text-gray-300
                       focus:outline-none focus:border-editor-accent"
          >
            <option value="all">All Types</option>
            {MODES.map(m => (
              <option key={m} value={m}>{PIPELINE_LABELS[m]}</option>
            ))}
          </select>

          <select
            value={filterStatus}
            onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
            className="px-2 py-1.5 rounded-md text-xs bg-editor-input border border-editor-border text-gray-300
                       focus:outline-none focus:border-editor-accent"
          >
            <option value="all">All Status</option>
            <option value="completed">Completed</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
          </select>

          <button
            onClick={() => runsQuery.refetch()}
            disabled={runsQuery.isFetching}
            className="p-1.5 rounded-md hover:bg-editor-active transition-colors text-gray-400 hover:text-white border border-editor-border"
            title="Refresh"
          >
            <RefreshCw size={13} className={runsQuery.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* ── Table ─── */}
      <div className="flex-1 overflow-auto px-5 py-3">
        {loading && runs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 size={28} className="animate-spin text-editor-accent mx-auto mb-3" />
              <p className="text-sm text-gray-400">Loading pipeline history...</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Activity size={36} className="text-gray-600 mx-auto mb-3" />
              <p className="text-sm text-gray-400 mb-1">No pipeline runs found</p>
              <p className="text-xs text-gray-600">Run a pipeline from the Code Builder to see history here</p>
            </div>
          </div>
        ) : (
          <div className="min-w-[1000px]">
            {/* Table header */}
            <div className="grid grid-cols-[60px_1fr_120px_140px_100px_130px_220px_180px] gap-2 px-4 py-2.5
                            bg-editor-sidebar rounded-t-lg border border-editor-border text-[10px] font-bold uppercase tracking-wider text-gray-500">
              <span>S.No</span>
              <span>Project Name</span>
              <span>Pipeline ID</span>
              <span>Pipeline Type</span>
              <span>Status</span>
              <span>Duration</span>
              <span>Actions</span>
              <span>Date & Time</span>
            </div>

            {/* Table body */}
            <div className="border-x border-b border-editor-border rounded-b-lg divide-y divide-editor-border">
              {paginated.map((run, idx) => {
                const mode = run.mode as PipelineMode;
                const sno = (page - 1) * pageSize + idx + 1;
                const statusStyle = STATUS_BADGE[run.status] || STATUS_BADGE.pending;
                const isCompleted = run.status === "completed";
                const isBrownfieldLike = ["brownfield", "hybrid", "hotfix", "migration"].includes(mode);

                return (
                  <div
                    key={run.run_id}
                    className="grid grid-cols-[60px_1fr_120px_140px_100px_130px_220px_180px] gap-2 px-4 py-3
                               hover:bg-editor-active/40 transition-colors items-center group"
                  >
                    {/* S.No */}
                    <span className="text-xs text-gray-500 font-mono">{sno}</span>

                    {/* Project Name */}
                    <div className="min-w-0">
                      <span className="text-xs text-gray-200 font-medium truncate block">
                        {run.project_name || "Unnamed"}
                      </span>
                      {run.request && (
                        <span className="text-[10px] text-gray-500 truncate block mt-0.5">
                          {run.request}
                        </span>
                      )}
                    </div>

                    {/* Pipeline ID */}
                    <span className="text-[11px] font-mono text-gray-400 truncate" title={run.run_id}>
                      {run.run_id}
                    </span>

                    {/* Pipeline Type */}
                    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium
                                    ${MODE_BG[mode]} ${MODE_COLORS[mode]} w-fit`}>
                      {MODE_ICONS[mode]}
                      <span>{PIPELINE_LABELS[mode]}</span>
                    </div>

                    {/* Status */}
                    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-semibold border w-fit
                                    ${statusStyle.bg} ${statusStyle.text}`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${statusStyle.dot}`} />
                      {run.status}
                    </div>

                    {/* Duration */}
                    <div className="flex items-center gap-1 text-[11px] text-gray-400">
                      <Clock size={11} />
                      <span>{formatDuration(run.duration_ms)}</span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5">
                      {isCompleted && (
                        <>
                          <button
                            onClick={() => handleDownload(run.run_id)}
                            disabled={downloading === run.run_id}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                                       bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 transition-colors
                                       disabled:opacity-40"
                            title="Download ZIP"
                          >
                            {downloading === run.run_id
                              ? <Loader2 size={10} className="animate-spin" />
                              : <Download size={10} />}
                            ZIP
                          </button>
                          <button
                            onClick={() => handleExplore(run.run_id)}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                                       bg-blue-500/20 hover:bg-blue-500/40 text-blue-300 transition-colors"
                            title="Explore files"
                          >
                            <Eye size={10} /> Explore
                          </button>
                          <button
                            onClick={() => handleViewReports(run.run_id)}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                                       bg-purple-500/20 hover:bg-purple-500/40 text-purple-300 transition-colors"
                            title="View Reports"
                          >
                            <FileText size={10} /> Report
                          </button>
                          {isBrownfieldLike && (
                            <button
                              onClick={() => handleViewDiffs(run.run_id)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium
                                         bg-orange-500/20 hover:bg-orange-500/40 text-orange-300 transition-colors"
                              title="View Code Diff"
                            >
                              <GitCompare size={10} /> Diff
                            </button>
                          )}
                        </>
                      )}
                      {run.status !== "running" && (
                        <button
                          onClick={() => handleDelete(run.run_id)}
                          disabled={deleteMutation.isPending && deleteMutation.variables === run.run_id}
                          className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px]
                                     bg-red-600/10 hover:bg-red-600/30 text-red-400 transition-colors
                                     disabled:opacity-40 opacity-0 group-hover:opacity-100"
                          title="Delete"
                        >
                          {(deleteMutation.isPending && deleteMutation.variables === run.run_id)
                            ? <Loader2 size={9} className="animate-spin" />
                            : <Trash2 size={9} />}
                        </button>
                      )}
                    </div>

                    {/* Date & Time */}
                    <span className="text-[11px] text-gray-400">
                      {formatDateTime(run.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Pagination ─── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-5 py-2.5 border-t border-editor-border bg-editor-sidebar shrink-0">
          <span className="text-xs text-gray-500">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1.5 rounded hover:bg-editor-active disabled:opacity-30 transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .map((p, idx, arr) => (
                <span key={p}>
                  {idx > 0 && arr[idx - 1] !== p - 1 && <span className="text-gray-600 px-1">…</span>}
                  <button
                    onClick={() => setPage(p)}
                    className={`w-7 h-7 rounded text-xs font-medium transition-colors
                      ${p === page ? "bg-editor-accent text-white" : "hover:bg-editor-active text-gray-400"}`}
                  >
                    {p}
                  </button>
                </span>
              ))}
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-1.5 rounded hover:bg-editor-active disabled:opacity-30 transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
