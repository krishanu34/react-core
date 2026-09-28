"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  SkipForward,
  Zap,
  Info,
  AlertTriangle,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils";
import { getToken } from "@/lib/auth";
import { getItem, removeItem, setItem } from "@/lib/storage";

// ── Types ─────────────────────────────────────────────────────────────────

type EventType =
  | "pipeline_started"
  | "stage_started"
  | "stage_completed"
  | "stage_skipped"
  | "stage_failed"
  | "pipeline_completed"
  | "pipeline_failed"
  | "log"
  | "stream_closed"
  | "keepalive";

interface StreamEvent {
  id: number;
  event: EventType;
  timestamp?: string;
  // stage events
  stage?: string;
  label?: string;
  percent?: number;
  duration_seconds?: number;
  completed_stages?: number;
  total_stages?: number;
  detail?: Record<string, unknown>;
  // pipeline events
  total_stories?: number;
  total_features?: number;
  total_epics?: number;
  total_story_points?: number;
  duration_seconds_total?: number;
  standards_score?: number;
  stages_executed?: number;
  stages_skipped?: number;
  stages_failed?: number;
  // log
  level?: string;
  message?: string;
  logger?: string;
  // generic
  error?: string;
  status?: string;
  [key: string]: unknown;
}

interface LogStreamProps {
  jobId: string;
  apiBase?: string;
  includeLogs?: boolean;
  /** last-event-id to resume from (e.g. from localStorage) */
  resumeFrom?: number | null;
  onComplete?: (summary: StreamEvent) => void;
  onFailed?: (err: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function EventIcon({ event }: { event: EventType }) {
  switch (event) {
    case "stage_completed":    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
    case "stage_failed":       return <XCircle      className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    case "stage_skipped":      return <SkipForward  className="h-3.5 w-3.5 text-slate-500 shrink-0" />;
    case "stage_started":      return <Clock        className="h-3.5 w-3.5 text-blue-400 shrink-0 animate-pulse" />;
    case "pipeline_started":   return <Zap          className="h-3.5 w-3.5 text-indigo-400 shrink-0" />;
    case "pipeline_completed": return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
    case "pipeline_failed":    return <XCircle      className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    case "log":                return <Info         className="h-3 w-3 text-slate-600 shrink-0" />;
    default:                   return <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />;
  }
}

function EventRow({ ev }: { ev: StreamEvent }) {
  const isLog     = ev.event === "log";
  const isStage   = ev.event.startsWith("stage_");
  const isSummary = ev.event === "pipeline_completed" || ev.event === "pipeline_failed";

  const text = (() => {
    if (ev.event === "pipeline_started")
      return `Pipeline started · quality=${ev.quality ?? "?"} · project=${ev.project_id ?? "?"}`;
    if (ev.event === "stage_started")
      return `▶ ${ev.label ?? ev.stage} (${ev.percent ?? 0}%)`;
    if (ev.event === "stage_completed")
      return `✓ ${ev.label ?? ev.stage}${ev.duration_seconds != null ? ` · ${ev.duration_seconds}s` : ""} · ${ev.percent ?? 0}%`;
    if (ev.event === "stage_skipped")
      return `⟳ ${ev.label ?? ev.stage} skipped`;
    if (ev.event === "stage_failed")
      return `✗ ${ev.label ?? ev.stage} failed`;
    if (ev.event === "pipeline_completed")
      return `Pipeline completed · ${ev.total_stories ?? 0} stories · ${ev.total_features ?? 0} features · ${ev.duration_seconds != null ? formatDuration(ev.duration_seconds as number) : ""}`;
    if (ev.event === "pipeline_failed")
      return `Pipeline failed: ${ev.error}`;
    if (isLog)
      return ev.message ?? "";
    return JSON.stringify(ev);
  })();

  return (
    <div
      className={cn(
        "flex items-start gap-2 py-0.5 px-2 rounded text-xs font-mono",
        isSummary && "bg-slate-800/60 py-1.5 my-1",
        ev.event === "pipeline_failed" && "bg-red-950/40",
        ev.event === "pipeline_completed" && "bg-emerald-950/40",
        isLog && "text-slate-500",
        isStage && !isLog && "text-slate-300",
        isSummary && "text-slate-100"
      )}
    >
      <EventIcon event={ev.event} />
      <span className="flex-1 break-all leading-relaxed">{text}</span>
      {ev.timestamp && (
        <span className="text-slate-600 shrink-0 tabular-nums text-[10px]">
          {new Date(ev.timestamp).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function LogStream({
  jobId,
  apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  includeLogs = true,
  resumeFrom = null,
  onComplete,
  onFailed,
}: LogStreamProps) {
  const [events, setEvents]       = useState<StreamEvent[]>([]);
  const [percent, setPercent]     = useState(0);
  const [stageLabel, setStageLabel] = useState<string>("Initialising…");
  const [isDone, setIsDone]       = useState(false);
  const [isError, setIsError]     = useState(false);
  const [lastId, setLastId]       = useState<number | null>(resumeFrom);
  const scrollRef                 = useRef<HTMLDivElement>(null);
  const esRef                     = useRef<EventSource | null>(null);

  // Persist lastId to localStorage so the UI can resume after a page reload.
  //
  // Via the storage helper because the bare setItem threw here when the origin
  // was full — inside an effect, so it surfaced as a render error rather than a
  // lost cursor. A cursor is expendable: without one the stream simply replays.
  //
  // Cleared once the job is finished, or every job a user ever streams leaves a
  // key behind forever.
  useEffect(() => {
    if (isDone) {
      removeItem(`sse_cursor_${jobId}`);
      return;
    }
    if (lastId !== null) {
      setItem(`sse_cursor_${jobId}`, String(lastId));
    }
  }, [lastId, jobId, isDone]);

  useEffect(() => {
    // Build URL with resume cursor
    const stored = getItem(`sse_cursor_${jobId}`);
    const cursor = resumeFrom ?? (stored ? parseInt(stored, 10) : null);
    const url    = `${apiBase}/api/v1/pipeline/jobs/${jobId}/stream?include_logs=${includeLogs}`;

    const connect = (fromCursor: number | null) => {
      if (esRef.current) esRef.current.close();

      // Use fetch + ReadableStream to send Last-Event-ID header (EventSource can't set headers)
      const headers: HeadersInit = { Accept: "text/event-stream" };
      if (fromCursor !== null) headers["Last-Event-ID"] = String(fromCursor);
      const _token = getToken();
      if (_token) (headers as Record<string, string>)["Authorization"] = `Bearer ${_token}`;

      let buffer = "";
      let aborted = false;

      const ctrl = new AbortController();

      fetch(url, { headers, signal: ctrl.signal })
        .then((res) => {
          if (!res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();

          const read = (): Promise<void> =>
            reader.read().then(({ done, value }) => {
              if (done || aborted) return;
              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split("\n\n");
              buffer = parts.pop() ?? "";
              for (const chunk of parts) {
                if (!chunk.trim()) continue;
                const lines = chunk.split("\n");
                let id: number | null = null;
                let eventType = "message";
                let dataStr   = "";
                for (const line of lines) {
                  if (line.startsWith("id:"))    id = parseInt(line.slice(3).trim(), 10);
                  if (line.startsWith("event:")) eventType = line.slice(6).trim();
                  if (line.startsWith("data:"))  dataStr   = line.slice(5).trim();
                  if (line.startsWith(":"))       continue; // keepalive comment
                }
                if (!dataStr) continue;
                if (id !== null) setLastId(id);
                try {
                  const payload = JSON.parse(dataStr) as Record<string, unknown>;
                  const ev: StreamEvent = { id: id ?? -1, event: eventType as EventType, ...payload };

                  if (eventType === "stream_closed") { setIsDone(true); return; }

                  setEvents((prev) => [...prev, ev]);

                  if (eventType === "stage_started" || eventType === "stage_completed") {
                    if (ev.label)   setStageLabel(ev.label as string);
                    if (ev.percent != null) setPercent(ev.percent as number);
                  }
                  if (eventType === "pipeline_completed") {
                    setPercent(100);
                    setStageLabel("Done");
                    setIsDone(true);
                    onComplete?.(ev);
                  }
                  if (eventType === "pipeline_failed") {
                    setIsError(true);
                    setIsDone(true);
                    onFailed?.(ev.error as string ?? "Unknown error");
                  }
                } catch {
                  // ignore parse errors
                }
              }
              return read();
            });

          return read();
        })
        .catch(() => {
          if (!aborted) {
            // Auto-reconnect after 2s on network error
            setTimeout(() => {
              const storedCursor = getItem(`sse_cursor_${jobId}`);
              connect(storedCursor ? parseInt(storedCursor, 10) : null);
            }, 2000);
          }
        });

      return () => { aborted = true; ctrl.abort(); };
    };

    const cleanup = connect(cursor);
    return () => { cleanup?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div className="flex flex-col gap-3">
      {/* Progress bar */}
      {!isDone && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium">{stageLabel}</span>
            <span className="tabular-nums">{percent.toFixed(0)}%</span>
          </div>
          <Progress value={percent} />
        </div>
      )}

      {isDone && (
        <div className="flex items-center gap-2">
          {isError ? (
            <Badge variant="danger">Failed</Badge>
          ) : (
            <Badge variant="success">Completed</Badge>
          )}
          <span className="text-xs text-slate-400">
            {events.length} events captured
            {lastId !== null && ` · last-id: ${lastId}`}
          </span>
        </div>
      )}

      {/* Event log — only shown when logs are enabled */}
      {includeLogs && (
        <div
          ref={scrollRef}
          className="h-[420px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-0.5"
        >
          {events.length === 0 && (
            <p className="text-xs text-slate-600 text-center mt-8">Waiting for events…</p>
          )}
          {events.map((ev, i) => (
            <EventRow key={i} ev={ev} />
          ))}
        </div>
      )}
    </div>
  );
}
