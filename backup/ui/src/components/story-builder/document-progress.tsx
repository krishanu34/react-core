"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Loader2,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils";
import {
  STAGE_LABELS,
  type DocJobStatus,
} from "@/lib/document-api";
import { useDocumentJobStatus } from "@/hooks/useStoryBuilderQueries";

// ── Types ─────────────────────────────────────────────────────────────────

interface StageEvent {
  stage: string;
  label: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
  percent: number;
}

interface DocumentProgressProps {
  jobId: string;
  /** Polling interval in ms (default 2000) */
  pollInterval?: number;
  /** Max consecutive poll failures before declaring the job dead (default 10) */
  maxPollFailures?: number;
  /** Max seconds a job can stay "running" with no progress change before being declared stale (default 300 = 5 min) */
  staleTimeoutSeconds?: number;
  onComplete?: () => void;
  onFailed?: (error: string) => void;
  onCancel?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseStageProgress(rawStage: string | null): { stageKey: string | null; detail: string | null } {
  if (!rawStage) return { stageKey: null, detail: null };

  const [stageKey, ...detailParts] = rawStage.split("||");
  return {
    stageKey: stageKey?.trim() || null,
    detail: detailParts.join("||").trim() || null,
  };
}

function getStageDisplayLabel(rawStage: string | null): string {
  const { stageKey, detail } = parseStageProgress(rawStage);
  if (!stageKey) return "";

  const baseLabel = STAGE_LABELS[stageKey] ?? stageKey;
  if (!detail) return baseLabel;
  if (stageKey === "stage_4_section_generation") return detail;
  return `${baseLabel} · ${detail}`;
}

function StageIcon({ status }: { status: "running" | "completed" | "failed" | "pending" }) {
  switch (status) {
    case "completed": return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
    case "failed":    return <XCircle      className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    case "running":   return <Loader2      className="h-3.5 w-3.5 text-blue-400 shrink-0 animate-spin" />;
    default:          return <Clock        className="h-3.5 w-3.5 text-slate-600 shrink-0" />;
  }
}

// ── Main component ────────────────────────────────────────────────────────

export function DocumentProgress({
  jobId,
  pollInterval = 2000,
  maxPollFailures = 10,
  staleTimeoutSeconds = 300,
  onComplete,
  onFailed,
  onCancel,
}: DocumentProgressProps) {
  const [percent, setPercent]         = useState(0);
  const [stageLabel, setStageLabel]   = useState("Initialising…");
  const [isDone, setIsDone]           = useState(false);
  const [isError, setIsError]         = useState(false);
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);
  const [stages, setStages]           = useState<StageEvent[]>([]);
  const [duration, setDuration]       = useState<number | null>(null);
  const [finalStatus, setFinalStatus] = useState<DocJobStatus | null>(null);

  const scrollRef       = useRef<HTMLDivElement>(null);
  const prevStage       = useRef<string | null>(null);
  const lastProgressRef = useRef<number>(Date.now());

  // Keep latest callbacks in refs so the reactive effect always uses the
  // current closure values (avoids stale-closure issues).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // ── TanStack Query: replaces setInterval polling ──
  const { data: pollData, failureCount } = useDocumentJobStatus(
    isDone ? null : jobId, // stop polling once done
    { pollInterval },
  );

  /** Cleanly mark the job as failed */
  const failJob = (msg: string) => {
    setIsError(true);
    setIsDone(true);
    setFinalStatus("failed");
    setErrorMsg(msg);
    setStages(prev => prev.map(s => s.status === "running" ? { ...s, status: "failed" } : s));
    onFailedRef.current?.(msg);
  };

  // React to poll data changes
  useEffect(() => {
    if (!pollData) return;

    const res = pollData;

    // Update progress
    if (res.progress) {
      const pct = res.progress.percent;
      setPercent(pct);
      const currentStage = res.progress.current_stage;
      const { stageKey } = parseStageProgress(currentStage);
      if (stageKey) {
        const label = getStageDisplayLabel(currentStage);
        setStageLabel(label);

        if (!prevStage.current) {
          lastProgressRef.current = Date.now();
          setStages((prev) => {
            const nextEvent: StageEvent = {
              stage: stageKey,
              label,
              status: "running",
              timestamp: new Date().toISOString(),
              percent: pct,
            };
            const existingIdx = prev.findIndex((s) => s.stage === stageKey);
            if (existingIdx >= 0) {
              const updated = [...prev];
              updated[existingIdx] = nextEvent;
              return updated;
            }
            return [...prev, nextEvent];
          });
          prevStage.current = stageKey;
        } else {
          setStages((prev) => prev.map((s) => (
            s.stage === stageKey && s.status === "running"
              ? { ...s, label, percent: pct, timestamp: new Date().toISOString() }
              : s
          )));
        }

        // Track stage transitions
        if (stageKey !== prevStage.current) {
          lastProgressRef.current = Date.now();

          if (prevStage.current) {
            setStages(prev => {
              const updated = [...prev];
              const idx = updated.findIndex(s => s.stage === prevStage.current && s.status === "running");
              if (idx >= 0) updated[idx] = { ...updated[idx], status: "completed" };
              return updated;
            });

            setStages(prev => {
              const updated = [...prev];
              const existingIdx = updated.findIndex(s => s.stage === stageKey);
              const nextEvent: StageEvent = {
                stage: stageKey,
                label,
                status: "running",
                timestamp: new Date().toISOString(),
                percent: pct,
              };

              if (existingIdx >= 0) {
                updated[existingIdx] = nextEvent;
                return updated;
              }

              return [...updated, nextEvent];
            });

            prevStage.current = stageKey;
          }
        }
      }
    }

    // Check stale timeout
    if (
      res.status === "running" &&
      staleTimeoutSeconds > 0 &&
      Date.now() - lastProgressRef.current > staleTimeoutSeconds * 1000
    ) {
      failJob("Job appears stale — no progress for " + Math.round(staleTimeoutSeconds / 60) + " min. You can dismiss and retry.");
      return;
    }

    // Check terminal states
    if (res.status === "completed" || res.status === "updated") {
      setPercent(100);
      setStageLabel("Done");
      setIsDone(true);
      setFinalStatus(res.status);
      setDuration(res.duration_seconds);
      setStages(prev => prev.map(s => s.status === "running" ? { ...s, status: "completed" } : s));
      onCompleteRef.current?.();
    } else if (res.status === "cancelled") {
      setIsDone(true);
      setFinalStatus("cancelled");
      setStageLabel("Cancelled");
      setErrorMsg("Cancelled by user");
      setStages(prev => prev.map(s => s.status === "running" ? { ...s, status: "failed" } : s));
      onCancelRef.current?.();
    } else if (res.status === "failed") {
      failJob(res.error ?? "Unknown error");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollData]);

  // Track consecutive query failures
  useEffect(() => {
    if (failureCount >= maxPollFailures) {
      failJob("Lost contact with the job (server may have restarted). Dismiss and retry.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failureCount, maxPollFailures]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [stages]);

  // Suppress unused-var lint for finalStatus (kept for future use)
  void finalStatus;

  return (
    <div className="flex flex-col gap-3">
      {/* Progress bar */}
      {!isDone && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-slate-400">
            <span className="font-medium flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
              {stageLabel}
            </span>
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
          {duration != null && (
            <span className="text-xs text-slate-400">
              {formatDuration(duration)}
            </span>
          )}
        </div>
      )}

      {/* Error message */}
      {isError && errorMsg && (
        <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
          {errorMsg}
        </div>
      )}

      {/* Stage log */}
      <div
        ref={scrollRef}
        className="h-[320px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2 space-y-0.5"
      >
        {stages.length === 0 && !isDone && (
          <p className="text-xs text-slate-600 text-center mt-8">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            Waiting for live status…
          </p>
        )}
        {/* Pipeline started */}
        {stages.length > 0 && (
          <div className="flex items-start gap-2 py-1 px-2 rounded text-xs font-mono bg-slate-800/60 my-1 text-slate-100">
            <Zap className="h-3.5 w-3.5 text-indigo-400 shrink-0 mt-0.5" />
            <span>Pipeline started</span>
          </div>
        )}
        {stages.map((s, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-2 py-0.5 px-2 rounded text-xs font-mono text-slate-300",
              s.status === "completed" && "text-slate-300",
              s.status === "failed" && "bg-red-950/40 text-red-400",
              s.status === "running" && "text-blue-300",
            )}
          >
            <StageIcon status={s.status} />
            <span className="flex-1 break-all leading-relaxed">
              {s.status === "running" && "▶ "}
              {s.status === "completed" && "✓ "}
              {s.status === "failed" && "✗ "}
              {s.label}
              {s.status === "completed" && ` · ${s.percent}%`}
            </span>
            <span className="text-slate-600 shrink-0 tabular-nums text-[10px]">
              {new Date(s.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
        {/* Pipeline completed/failed */}
        {isDone && !isError && (
          <div className="flex items-start gap-2 py-1.5 px-2 rounded text-xs font-mono bg-emerald-950/40 text-slate-100 my-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              Pipeline completed
              {duration != null && ` · ${formatDuration(duration)}`}
            </span>
          </div>
        )}
        {isDone && isError && (
          <div className="flex items-start gap-2 py-1.5 px-2 rounded text-xs font-mono bg-red-950/40 text-red-400 my-1">
            <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
            <span>Pipeline failed: {errorMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}
