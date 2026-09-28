"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  listCBSessions,
  listSessionRuns,
  deleteCBRun,
  type CBSession,
  type CBSessionRun,
} from "@/lib/code-builder-api";
import {
  X,
  Search,
  Plus,
  MessageSquare,
  Check,
  Loader2,
  FolderOpen,
  Clock,
  ChevronRight,
  ChevronDown,
  Play,
  AlertCircle,
  CheckCircle2,
  Trash2,
} from "lucide-react";

/* ── Props ────────────────────────────────────────────────────────────── */
interface SessionPickerModalProps {
  projectId: number;
  projectName: string;
  currentSessionId: number | null;
  currentRunId?: string | null;
  /** Called when user selects a session + run, or creates a new session */
  onSelect: (
    session: CBSession | null,
    newSessionName?: string,
    selectedRun?: CBSessionRun | null,
  ) => void;
  onClose: () => void;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */
function parseServerDate(iso: string): Date {
  // Treat naive ISO strings as UTC (matches backend serialisation).
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasTz ? iso : iso + "Z");
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = parseServerDate(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = parseServerDate(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(secs: number | null): string {
  if (!secs) return "";
  if (secs < 60) return `${Math.round(secs)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

function runStatusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3 h-3 text-green-400" />;
    case "running":
      return <Play className="w-3 h-3 text-cbv2-accent animate-pulse" />;
    case "failed":
      return <AlertCircle className="w-3 h-3 text-red-400" />;
    default:
      return <Clock className="w-3 h-3 text-cbv2-text-dim" />;
  }
}

/* ── Component ────────────────────────────────────────────────────────── */
export default function SessionPickerModal({
  projectId,
  projectName,
  currentSessionId,
  currentRunId,
  onSelect,
  onClose,
}: SessionPickerModalProps) {
  const [sessions, setSessions] = useState<CBSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expanded session → shows its runs
  const [expandedSessionId, setExpandedSessionId] = useState<number | null>(
    currentSessionId
  );
  const [sessionRuns, setSessionRuns] = useState<
    Record<number, CBSessionRun[]>
  >({});
  const [loadingRuns, setLoadingRuns] = useState<Record<number, boolean>>({});

  const fetchSessions = useCallback(
    async (searchTerm: string) => {
      setLoading(true);
      try {
        const data = await listCBSessions(projectId, {
          limit: 20,
          offset: 0,
          search: searchTerm,
        });
        setSessions(data.sessions);
        setTotal(data.total);
      } catch {
        setSessions([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [projectId]
  );

  // Fetch runs for a session
  const fetchRuns = useCallback(async (sessionId: number) => {
    setLoadingRuns((prev) => ({ ...prev, [sessionId]: true }));
    try {
      const data = await listSessionRuns(sessionId);
      setSessionRuns((prev) => ({ ...prev, [sessionId]: data.runs }));
    } catch {
      setSessionRuns((prev) => ({ ...prev, [sessionId]: [] }));
    } finally {
      setLoadingRuns((prev) => ({ ...prev, [sessionId]: false }));
    }
  }, []);

  useEffect(() => {
    fetchSessions("");
  }, [fetchSessions]);

  // Auto-expand current session and load its runs
  useEffect(() => {
    if (currentSessionId && !sessionRuns[currentSessionId]) {
      fetchRuns(currentSessionId);
    }
  }, [currentSessionId, fetchRuns, sessionRuns]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchTimeout.current = setTimeout(() => fetchSessions(value), 300);
    },
    [fetchSessions]
  );

  const handleToggleSession = useCallback(
    (session: CBSession) => {
      if (expandedSessionId === session.id) {
        setExpandedSessionId(null);
      } else {
        setExpandedSessionId(session.id);
        if (!sessionRuns[session.id]) {
          fetchRuns(session.id);
        }
      }
    },
    [expandedSessionId, sessionRuns, fetchRuns]
  );

  // Select session with its latest run (or no run if new)
  const handleSelectSession = useCallback(
    (session: CBSession) => {
      const runs = sessionRuns[session.id];
      const latestRun = runs?.[0] ?? null;
      onSelect(session, undefined, latestRun);
    },
    [onSelect, sessionRuns]
  );

  // Select a specific run within a session
  const handleSelectRun = useCallback(
    (session: CBSession, run: CBSessionRun) => {
      onSelect(session, undefined, run);
    },
    [onSelect]
  );

  // Delete a run (DB row + on-disk workspace)
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const handleDeleteRun = useCallback(
    async (sessionId: number, runId: string | null) => {
      if (!runId) return;
      const ok = window.confirm(
        "Delete this run and its generated workspace files? This cannot be undone."
      );
      if (!ok) return;
      setDeletingRunId(runId);
      try {
        await deleteCBRun(runId);
        // Remove the run from local state
        setSessionRuns((prev) => ({
          ...prev,
          [sessionId]: (prev[sessionId] ?? []).filter(
            (r) => r.run_id !== runId
          ),
        }));
        // If the deleted run was the active one, reset selection by
        // notifying parent with no run selected.
        if (currentRunId === runId) {
          onSelect(
            sessions.find((s) => s.id === sessionId) ?? null,
            undefined,
            null
          );
        }
      } catch (e) {
        console.error("deleteCBRun failed", e);
        window.alert(
          "Failed to delete run. See console for details."
        );
      } finally {
        setDeletingRunId(null);
      }
    },
    [currentRunId, onSelect, sessions]
  );

  const handleCreateNew = useCallback(() => {
    onSelect(null, newSessionName.trim() || undefined, null);
  }, [onSelect, newSessionName]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-cbv2-bg border border-cbv2-border rounded-lg shadow-2xl w-[580px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-cbv2-border bg-cbv2-sidebar">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-cbv2-accent" />
            <span className="text-sm font-semibold text-cbv2-text">
              Sessions &amp; Runs
            </span>
            <span className="text-[10px] text-cbv2-text-dim font-mono">
              {projectName}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Search + New session ── */}
        <div className="px-4 py-2 border-b border-cbv2-border space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
            <input
              className="w-full pl-8 pr-3 py-1.5 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search sessions..."
              autoFocus
            />
          </div>

          {showNewForm ? (
            <div className="flex items-center gap-2">
              <input
                className="flex-1 px-2 py-1.5 bg-cbv2-input border border-cbv2-border rounded text-[12px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent outline-none"
                value={newSessionName}
                onChange={(e) => setNewSessionName(e.target.value)}
                placeholder="Session name (optional)"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateNew();
                }}
              />
              <button
                onClick={handleCreateNew}
                className="px-3 py-1.5 rounded bg-cbv2-accent text-white text-[11px] font-medium hover:bg-cbv2-accent/80 transition-colors"
              >
                Create
              </button>
              <button
                onClick={() => setShowNewForm(false)}
                className="p-1 rounded hover:bg-cbv2-hover text-cbv2-text-dim"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNewForm(true)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] font-medium text-cbv2-accent hover:bg-cbv2-accent/10 border border-dashed border-cbv2-accent/30 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              New session
            </button>
          )}
        </div>

        {/* ── Session list with expandable runs ── */}
        <div className="flex-1 overflow-y-auto cbv2-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-cbv2-text-dim">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading sessions...
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-cbv2-text-dim">
              {search
                ? "No sessions match your search."
                : "No sessions yet. Create one to get started."}
            </div>
          ) : (
            <div className="py-1">
              {sessions.map((s) => {
                const isActive = s.id === currentSessionId;
                const isExpanded = expandedSessionId === s.id;
                const runs = sessionRuns[s.id] ?? [];
                const isLoadingRuns = loadingRuns[s.id] ?? false;

                return (
                  <div key={s.id}>
                    {/* Session row */}
                    <div
                      className={[
                        "flex items-start gap-2 px-4 py-2.5 transition-colors border-l-2 cursor-pointer",
                        isActive
                          ? "bg-cbv2-accent/10 border-l-cbv2-accent"
                          : "border-l-transparent hover:bg-cbv2-hover",
                      ].join(" ")}
                    >
                      {/* Expand/collapse toggle */}
                      <button
                        onClick={() => handleToggleSession(s)}
                        className="mt-0.5 p-0.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {/* Session info — click to select latest run */}
                      <button
                        className="flex-1 min-w-0 text-left"
                        onClick={() => handleSelectSession(s)}
                      >
                        <div className="flex items-center gap-2">
                          <MessageSquare
                            className={[
                              "w-3.5 h-3.5 flex-shrink-0",
                              isActive
                                ? "text-cbv2-accent"
                                : "text-cbv2-text-dim",
                            ].join(" ")}
                          />
                          <span className="text-[10px] font-mono text-cbv2-text-dim">
                            #{s.id}
                          </span>
                          <span
                            className={[
                              "text-[12px] font-medium truncate",
                              isActive
                                ? "text-cbv2-accent"
                                : "text-cbv2-text",
                            ].join(" ")}
                          >
                            {s.session_name}
                          </span>
                          {isActive && (
                            <Check className="w-3 h-3 text-cbv2-accent flex-shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-[10px] text-cbv2-text-dim">
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-2.5 h-2.5" />
                            {s.message_count} msg
                            {s.message_count !== 1 ? "s" : ""}
                          </span>
                          {s.last_output_dir && (
                            <span className="flex items-center gap-1">
                              <FolderOpen className="w-2.5 h-2.5" />
                              has files
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {timeAgo(s.updated_at)}
                          </span>
                          <span
                            className={[
                              "px-1 py-0.5 rounded text-[9px] uppercase tracking-wide",
                              s.status === "active"
                                ? "bg-green-500/15 text-green-400"
                                : "bg-cbv2-border text-cbv2-text-dim",
                            ].join(" ")}
                          >
                            {s.status}
                          </span>
                        </div>
                        {s.description && (
                          <div className="mt-0.5 text-[10px] text-cbv2-text-dim truncate">
                            {s.description}
                          </div>
                        )}
                      </button>
                    </div>

                    {/* Expanded runs list */}
                    {isExpanded && (
                      <div className="ml-8 border-l border-cbv2-border/50 bg-cbv2-sidebar/30">
                        {isLoadingRuns ? (
                          <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-cbv2-text-dim">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Loading runs...
                          </div>
                        ) : runs.length === 0 ? (
                          <div className="px-4 py-3 text-[11px] text-cbv2-text-dim italic">
                            No runs yet — start a generation to create
                            the first run.
                          </div>
                        ) : (
                          runs.map((run) => {
                            const isRunActive =
                              currentRunId === run.run_id;
                            const isDeleting =
                              deletingRunId === run.run_id;
                            return (
                              <div
                                key={run.run_id}
                                className={[
                                  "w-full flex items-center gap-2 pl-4 pr-2 py-2 text-left transition-colors border-l-2 group",
                                  isRunActive
                                    ? "bg-cbv2-accent/15 border-l-cbv2-accent"
                                    : "border-l-transparent hover:bg-cbv2-hover/60",
                                ].join(" ")}
                              >
                                <button
                                  type="button"
                                  className="flex-1 flex items-center gap-3 text-left min-w-0 disabled:opacity-50"
                                  disabled={isDeleting}
                                  onClick={() =>
                                    handleSelectRun(s, run)
                                  }
                                >
                                  {runStatusIcon(run.status)}
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] font-mono text-cbv2-text-dim">
                                        {run.run_id?.slice(0, 8)}
                                      </span>
                                      <span
                                        className={[
                                          "text-[11px]",
                                          isRunActive
                                            ? "text-cbv2-accent font-medium"
                                            : "text-cbv2-text",
                                        ].join(" ")}
                                      >
                                        {formatDateTime(
                                          run.started_at
                                        )}
                                      </span>
                                      {isRunActive && (
                                        <Check className="w-3 h-3 text-cbv2-accent flex-shrink-0" />
                                      )}
                                    </div>
                                    <div className="flex items-center gap-3 mt-0.5 text-[10px] text-cbv2-text-dim">
                                      <span className="px-1 py-0 rounded bg-cbv2-accent/10 text-cbv2-accent">
                                        {run.pipeline_type}
                                      </span>
                                      <span>
                                        {run.files_generated}/
                                        {run.files_planned} files
                                      </span>
                                      {run.duration_seconds != null && (
                                        <span>
                                          {formatDuration(
                                            run.duration_seconds
                                          )}
                                        </span>
                                      )}
                                      {run.status ===
                                        "failed" &&
                                        run.error_message && (
                                          <span className="text-red-400 truncate max-w-[150px]">
                                            {run.error_message}
                                          </span>
                                        )}
                                    </div>
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  title="Delete this run and its workspace"
                                  disabled={isDeleting}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    handleDeleteRun(s.id, run.run_id);
                                  }}
                                  className="p-1 rounded text-cbv2-text-dim hover:text-red-400 hover:bg-red-500/10 opacity-60 group-hover:opacity-100 disabled:opacity-30 transition-all"
                                >
                                  {isDeleting ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-4 py-2 border-t border-cbv2-border text-[10px] text-cbv2-text-dim flex items-center justify-between">
          <span>
            Showing {sessions.length} of {total} session{total !== 1 ? "s" : ""}
            {search && ` matching "${search}"`}
            {!search && total > sessions.length && " (newest 20)"}
          </span>
          <span>Pick a session → expand to choose a run · 🗑 to delete</span>
        </div>
      </div>
    </div>
  );
}
