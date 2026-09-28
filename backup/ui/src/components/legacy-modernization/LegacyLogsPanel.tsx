"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Info, Loader2, RefreshCw, Shield, Terminal } from "lucide-react";
import { authFetch } from "@/lib/auth";

const LEGACY_API_BASE = "/lm-api";

const LOG_SOURCES = [
  { value: "legacy-modernization", label: "Legacy Modernization" },
  { value: "code-builder", label: "Code Builder" },
  { value: "common-utils", label: "Common Utils" },
  { value: "devaccel", label: "DevAccel" },
];

const LEVELS = ["ALL", "INFO", "WARNING", "ERROR", "DEBUG"];

type LogsResponse = {
  source: string;
  file: string;
  lines: string[];
  line_count: number;
  active_count: number;
  updated_at: string;
};

type LogLevel = "ERROR" | "WARNING" | "INFO" | "DEBUG" | "SUCCESS";

type ParsedLogEntry = {
  id: string;
  lineNumber: number;
  time: string;
  message: string;
  source: string;
  level: LogLevel;
  details: Array<{ key: string; value: string }>;
  raw: string[];
};

type LogInsight = {
  status: "healthy" | "warning" | "error" | "empty";
  title: string;
  explanation: string;
  location: string;
  action: string;
  entry?: ParsedLogEntry;
};

function getLineColor(line: string): string {
  const upper = line.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("EXCEPTION") || upper.includes("FAILED") || upper.includes("CRASHED")) {
    return "text-red-300";
  }
  if (upper.includes("WARNING") || upper.includes("WARN")) {
    return "text-amber-300";
  }
  if (upper.includes("DEBUG")) {
    return "text-slate-400";
  }
  if (upper.includes("SUCCESS") || upper.includes("COMPLETED")) {
    return "text-emerald-300";
  }
  return "text-cbv2-text";
}

function classifyEntry(text: string): LogLevel {
  const upper = text.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("EXCEPTION") || upper.includes("TRACEBACK") || upper.includes("FAILED") || upper.includes("REJECTED") || upper.includes("CRASHED")) {
    return "ERROR";
  }
  if (upper.includes("WARNING") || upper.includes("WARN")) return "WARNING";
  if (upper.includes("DEBUG")) return "DEBUG";
  if (upper.includes("SUCCESS") || upper.includes("COMPLETED") || upper.includes("READY") || upper.includes("ACCEPTED")) return "SUCCESS";
  return "INFO";
}

function humanizeToken(value: string): string {
  return value
    .replace(/^legacy_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanizeMessage(message: string): string {
  const known: Record<string, string> = {
    legacy_modernize_ws_connected: "Browser connected to the modernization WebSocket.",
    legacy_modernize_request_received: "The backend received a modernization start request.",
    legacy_modernize_model_resolved: "The AI model configuration was found for this project.",
    legacy_modernize_uploaded_source_prepared: "The uploaded or imported source code workspace was prepared.",
    legacy_modernize_accepted: "The modernization run was accepted and a run record was created.",
    legacy_modernize_pipeline_task_started: "The reverse-engineering pipeline task started.",
    legacy_modernize_rejected: "The backend rejected the modernization request before the pipeline started.",
    legacy_modernize_event: "The modernization pipeline emitted a progress event.",
    legacy_modernize_ws_closed: "The modernization WebSocket closed.",
    legacy_codegen_ws_connected: "Browser connected to the code-generation WebSocket.",
    legacy_codegen_request_received: "The backend received a code-generation request.",
    legacy_codegen_model_resolved: "The AI model configuration was found for code generation.",
    legacy_codegen_accepted: "The code-generation run was accepted and a run record was created.",
    legacy_codegen_pipeline_task_started: "The code-generation pipeline task started.",
    legacy_codegen_event: "The code-generation pipeline emitted a progress event.",
    legacy_codegen_ws_closed: "The code-generation WebSocket closed.",
    safe_default_options: "The model invocation options were normalized.",
  };
  return known[message] ?? humanizeToken(message);
}

function parseDetailLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  const sourceMatch = trimmed.match(/^source:\s*(.+)$/i);
  if (sourceMatch) return { key: "source", value: sourceMatch[1].trim() };
  const kvMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
  if (kvMatch) return { key: kvMatch[1].trim(), value: kvMatch[2].trim() };
  return null;
}

function parseLogLines(lines: string[]): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  let current: ParsedLogEntry | null = null;

  const finish = () => {
    if (!current) return;
    current.level = classifyEntry(current.raw.join("\n"));
    const source = current.details.find((item) => item.key.toLowerCase() === "source")?.value;
    if (source) current.source = source;
    entries.push(current);
  };

  lines.forEach((line, index) => {
    const header = line.match(/^\s*(\d{2}:\d{2}:\d{2})\s+→\s+(.*)$/);
    if (header) {
      finish();
      current = {
        id: `${index}-${header[1]}-${header[2].slice(0, 24)}`,
        lineNumber: index + 1,
        time: header[1],
        message: header[2].trim(),
        source: "unknown",
        level: "INFO",
        details: [],
        raw: [line],
      };
      return;
    }

    if (!current) {
      current = {
        id: `${index}-raw`,
        lineNumber: index + 1,
        time: "--:--:--",
        message: line.trim() || "Log continuation",
        source: "unknown",
        level: classifyEntry(line),
        details: [],
        raw: [line],
      };
      return;
    }

    current.raw.push(line);
    const detail = parseDetailLine(line);
    if (detail) current.details.push(detail);
  });

  finish();
  return entries;
}

function getDetail(entry: ParsedLogEntry | undefined, ...keys: string[]) {
  if (!entry) return "";
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return entry.details.find((item) => wanted.has(item.key.toLowerCase()))?.value ?? "";
}

function describeProblem(entry: ParsedLogEntry): string {
  const reason = getDetail(entry, "reason", "error", "message", "detail");
  if (reason) return `${humanizeMessage(entry.message)} Reason: ${humanizeToken(reason)}.`;
  if (entry.message.toLowerCase().includes("model_config")) return "The project model configuration could not be resolved.";
  if (entry.message.toLowerCase().includes("workspace")) return "The source workspace path appears to be missing, invalid, or blocked by safety checks.";
  if (entry.message.toLowerCase().includes("websocket") || entry.message.toLowerCase().includes("ws")) return "The browser connection to the backend closed or failed.";
  return humanizeMessage(entry.message);
}

function suggestAction(entry: ParsedLogEntry | undefined): string {
  if (!entry) return "No action required unless the UI is stuck.";
  const text = `${entry.message}\n${entry.raw.join("\n")}`.toLowerCase();
  if (text.includes("model_config") || text.includes("model config")) return "Open project settings and verify the modernization model is assigned with a valid endpoint/key.";
  if (text.includes("project_not_found")) return "Confirm the selected project still exists and is not archived.";
  if (text.includes("missing_target_stack")) return "Enter a target stack before starting modernization.";
  if (text.includes("workspace_root_not_allowed") || text.includes("workspace_root not allowed")) return "Use the upload/import flow so the source path is created inside the allowed runtime workspace.";
  if (text.includes("uploaded_source_missing") || text.includes("workspace not found")) return "Re-upload or re-import the source because the server cannot find the workspace folder.";
  if (text.includes("source_outside_workspace")) return "Check that source_path is inside workspace_root.";
  if (text.includes("already_running") || text.includes("already in progress")) return "Stop/clear the stuck run or restart the legacy modernization backend, then retry.";
  if (text.includes("websocket") || text.includes("ws_closed")) return "Check browser Network → WS and backend logs around the same timestamp.";
  return "Inspect this entry and the few entries immediately before it for the root cause.";
}

function buildInsight(entries: ParsedLogEntry[]): LogInsight {
  if (entries.length === 0) {
    return {
      status: "empty",
      title: "No log entries found",
      explanation: "No lines matched the selected source, level, or search filter.",
      location: "No matching log location",
      action: "Clear filters or refresh after reproducing the issue.",
    };
  }

  const latestProblem = [...entries].reverse().find((entry) => entry.level === "ERROR" || entry.level === "WARNING");
  if (latestProblem) {
    return {
      status: latestProblem.level === "ERROR" ? "error" : "warning",
      title: latestProblem.level === "ERROR" ? "Latest likely failure" : "Latest warning",
      explanation: describeProblem(latestProblem),
      location: `${latestProblem.source} at ${latestProblem.time} (visible line ${latestProblem.lineNumber})`,
      action: suggestAction(latestProblem),
      entry: latestProblem,
    };
  }

  const lastEntry = entries[entries.length - 1];
  return {
    status: "healthy",
    title: "No errors or warnings in the selected logs",
    explanation: `Latest activity: ${humanizeMessage(lastEntry.message)}.`,
    location: `${lastEntry.source} at ${lastEntry.time} (visible line ${lastEntry.lineNumber})`,
    action: "If the UI still failed, reproduce once and refresh logs with level set to ALL.",
    entry: lastEntry,
  };
}

function levelBadgeClass(level: LogLevel) {
  switch (level) {
    case "ERROR": return "bg-red-500/15 text-red-300 border-red-500/30";
    case "WARNING": return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "SUCCESS": return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "DEBUG": return "bg-slate-500/15 text-slate-300 border-slate-500/30";
    default: return "bg-cyan-500/10 text-cyan-200 border-cyan-500/20";
  }
}

export default function LegacyLogsPanel() {
  const [source, setSource] = useState("legacy-modernization");
  const [level, setLevel] = useState("ALL");
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"readable" | "raw">("readable");
  const [importantOnly, setImportantOnly] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        source,
        lines: "500",
      });
      if (level !== "ALL") params.set("level", level);
      if (query.trim()) params.set("query", query.trim());

      const res = await authFetch(
        `${LEGACY_API_BASE}/legacy-modernization/logs?${params.toString()}`,
        {},
        { silent: true }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(String(body.error ?? body.detail ?? "Could not load logs"));
      }
      setData(await res.json());
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not load logs");
    } finally {
      setLoading(false);
    }
  }, [source, level, query]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadLogs]);

  const logText = useMemo(() => (data?.lines ?? []).join("\n"), [data]);
  const parsedEntries = useMemo(() => parseLogLines(data?.lines ?? []), [data?.lines]);
  const visibleEntries = useMemo(
    () => importantOnly ? parsedEntries.filter((entry) => entry.level === "ERROR" || entry.level === "WARNING") : parsedEntries,
    [importantOnly, parsedEntries]
  );
  const insight = useMemo(() => buildInsight(parsedEntries), [parsedEntries]);
  const counts = useMemo(() => {
    return parsedEntries.reduce(
      (acc, entry) => ({ ...acc, [entry.level]: acc[entry.level] + 1 }),
      { ERROR: 0, WARNING: 0, INFO: 0, DEBUG: 0, SUCCESS: 0 } satisfies Record<LogLevel, number>
    );
  }, [parsedEntries]);

  const downloadLogs = useCallback(() => {
    const blob = new Blob([logText || "No logs available"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data?.source ?? source}-logs.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }, [data?.source, logText, source]);

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text overflow-hidden">
      <div className="px-4 py-3 border-b border-cbv2-border flex items-center gap-2.5 shrink-0 cbv2-header-gradient">
        <div className="w-7 h-7 rounded-lg bg-cbv2-accent/15 flex items-center justify-center">
          <Terminal className="w-4 h-4 text-cbv2-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold flex items-center gap-2">
            Runtime Logs
            <span className="inline-flex items-center gap-1 text-[9px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full px-1.5 py-0.5">
              <Shield className="w-2.5 h-2.5" /> Admin
            </span>
          </div>
          <div className="text-[10px] text-cbv2-text-dim truncate">
            {data?.file ?? "legacy-modernization.log"} · {data?.line_count ?? 0} lines · {data?.active_count ?? 0} active run(s)
          </div>
        </div>
        <button
          className="p-1.5 rounded-md text-cbv2-text-dim hover:text-white hover:bg-cbv2-hover transition-colors"
          onClick={() => void loadLogs()}
          title="Refresh logs"
          disabled={loading}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
        <button
          className="p-1.5 rounded-md text-cbv2-text-dim hover:text-white hover:bg-cbv2-hover transition-colors"
          onClick={downloadLogs}
          title="Download visible logs"
        >
          <Download className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-cbv2-border bg-cbv2-activity/70 grid grid-cols-1 md:grid-cols-[180px_110px_1fr_auto] gap-2 shrink-0">
        <select
          className="bg-cbv2-input border border-cbv2-border rounded-md px-2 py-1.5 text-[11px] outline-none focus:border-cbv2-accent"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          {LOG_SOURCES.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
        <select
          className="bg-cbv2-input border border-cbv2-border rounded-md px-2 py-1.5 text-[11px] outline-none focus:border-cbv2-accent"
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        >
          {LEVELS.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <input
          className="bg-cbv2-input border border-cbv2-border rounded-md px-2 py-1.5 text-[11px] outline-none focus:border-cbv2-accent placeholder:text-cbv2-text-dim"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter logs by text..."
        />
        <label className="inline-flex items-center gap-2 text-[11px] text-cbv2-text-dim px-2">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          Auto refresh
        </label>
      </div>

      <div className="px-3 py-2 border-b border-cbv2-border bg-cbv2-sidebar/95 flex flex-wrap items-center gap-2 shrink-0">
        <button
          className={`px-3 py-1.5 rounded-md text-[11px] border transition-colors ${viewMode === "readable" ? "bg-cbv2-accent/15 border-cbv2-accent/40 text-cbv2-accent" : "bg-cbv2-input border-cbv2-border text-cbv2-text-dim hover:text-cbv2-text"}`}
          onClick={() => setViewMode("readable")}
        >
          Readable view
        </button>
        <button
          className={`px-3 py-1.5 rounded-md text-[11px] border transition-colors ${viewMode === "raw" ? "bg-cbv2-accent/15 border-cbv2-accent/40 text-cbv2-accent" : "bg-cbv2-input border-cbv2-border text-cbv2-text-dim hover:text-cbv2-text"}`}
          onClick={() => setViewMode("raw")}
        >
          Raw view
        </button>
        <label className="inline-flex items-center gap-2 text-[11px] text-cbv2-text-dim px-2">
          <input
            type="checkbox"
            checked={importantOnly}
            onChange={(event) => setImportantOnly(event.target.checked)}
          />
          Show only errors/warnings
        </label>
        <div className="ml-auto flex flex-wrap gap-1.5 text-[10px]">
          <span className="px-2 py-1 rounded-full border border-red-500/25 bg-red-500/10 text-red-300">Errors {counts.ERROR}</span>
          <span className="px-2 py-1 rounded-full border border-amber-500/25 bg-amber-500/10 text-amber-300">Warnings {counts.WARNING}</span>
          <span className="px-2 py-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 text-emerald-300">Success {counts.SUCCESS}</span>
          <span className="px-2 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">Info {counts.INFO}</span>
        </div>
      </div>

      {error ? (
        <div className="m-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-300">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      ) : null}

      <div className="flex-1 overflow-auto bg-[#0b0f14] p-3 text-[11px] leading-5">
        {viewMode === "readable" ? (
          <div className="space-y-3">
            <div className={`rounded-xl border p-3 ${insight.status === "error" ? "border-red-500/30 bg-red-500/10" : insight.status === "warning" ? "border-amber-500/30 bg-amber-500/10" : insight.status === "healthy" ? "border-emerald-500/25 bg-emerald-500/10" : "border-cbv2-border bg-cbv2-input/50"}`}>
              <div className="flex items-start gap-2">
                {insight.status === "healthy" ? <CheckCircle2 className="w-4 h-4 text-emerald-300 mt-0.5" /> : insight.status === "error" ? <AlertCircle className="w-4 h-4 text-red-300 mt-0.5" /> : <Info className="w-4 h-4 text-amber-300 mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-cbv2-text">{insight.title}</div>
                  <div className="text-[11px] text-cbv2-text mt-1">{insight.explanation}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                    <div className="rounded-lg border border-cbv2-border bg-black/20 p-2">
                      <div className="text-[10px] uppercase tracking-wide text-cbv2-text-dim mb-0.5">Where</div>
                      <div className="text-cbv2-text">{insight.location}</div>
                    </div>
                    <div className="rounded-lg border border-cbv2-border bg-black/20 p-2">
                      <div className="text-[10px] uppercase tracking-wide text-cbv2-text-dim mb-0.5">What to check next</div>
                      <div className="text-cbv2-text">{insight.action}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {visibleEntries.length > 0 ? (
              <div className="space-y-2">
                {visibleEntries.map((entry) => (
                  <div key={entry.id} className="rounded-lg border border-cbv2-border bg-cbv2-sidebar/80 overflow-hidden">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-cbv2-border bg-cbv2-activity/50">
                      <span className={`px-2 py-0.5 rounded-full border text-[9px] font-semibold ${levelBadgeClass(entry.level)}`}>{entry.level}</span>
                      <span className="font-mono text-[10px] text-cbv2-text-dim">{entry.time}</span>
                      <span className="px-1.5 py-0.5 rounded bg-cbv2-input text-[10px] text-cbv2-text-dim">{entry.source}</span>
                      <span className="text-[11px] font-medium text-cbv2-text">{humanizeMessage(entry.message)}</span>
                      <span className="ml-auto font-mono text-[10px] text-slate-500">line {entry.lineNumber}</span>
                    </div>
                    {entry.details.filter((detail) => detail.key.toLowerCase() !== "source").length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 px-3 py-2">
                        {entry.details.filter((detail) => detail.key.toLowerCase() !== "source").slice(0, 8).map((detail) => (
                          <div key={`${entry.id}-${detail.key}`} className="rounded border border-cbv2-border/70 bg-black/20 px-2 py-1">
                            <span className="text-cbv2-text-dim">{humanizeToken(detail.key)}: </span>
                            <span className="text-cbv2-text break-all">{detail.value}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {(entry.level === "ERROR" || entry.level === "WARNING") ? (
                      <div className="px-3 pb-2 text-[11px] text-cbv2-text-dim">
                        <span className="text-cbv2-text">Suggested next step:</span> {suggestAction(entry)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-cbv2-text-dim">
                {loading ? "Loading logs..." : "No readable log entries match the selected filters."}
              </div>
            )}
          </div>
        ) : (data?.lines ?? []).length > 0 ? (
          <div className="space-y-0.5 whitespace-pre-wrap break-words font-mono">
            {(data?.lines ?? []).map((line, index) => (
              <div key={`${index}-${line.slice(0, 16)}`} className={getLineColor(line)}>
                <span className="select-none text-slate-600 mr-3">{String(index + 1).padStart(4, "0")}</span>
                {line}
              </div>
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-cbv2-text-dim">
            {loading ? "Loading logs..." : "No log lines found for the selected filters."}
          </div>
        )}
      </div>
    </div>
  );
}
