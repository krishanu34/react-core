"use client";

import React, { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock,
  Loader2,
} from "lucide-react";

/* ── Types ───────────────────────────────────────────────────────────── */

interface PipelineProgressBarProps {
  /** Current phase human-readable label */
  currentPhase: string;
  /** Pipeline overall status */
  status: "idle" | "connecting" | "running" | "complete" | "error";
  /** Phase index (1-based) and total phases from backend events */
  phaseProgress: { index: number; total: number };
  /** Phase-level elapsed times (seconds) keyed by phase name */
  phaseTimings: Record<string, number>;
  /** Timestamp (ms) when the pipeline started */
  pipelineStartTime: number | null;
  /** Files being generated / completed (for code-gen progress) */
  generatingFiles: string[];
  completedFiles: string[];
  manifest: Array<{ path: string; description: string }>;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/* ── Component ────────────────────────────────────────────────────────── */

export default function PipelineProgressBar({
  currentPhase,
  status,
  phaseProgress,
  phaseTimings,
  pipelineStartTime,
  generatingFiles,
  completedFiles,
  manifest,
}: PipelineProgressBarProps) {
  const [elapsed, setElapsed] = useState(() =>
    status === "running" && pipelineStartTime ? Date.now() - pipelineStartTime : 0
  );

  // Live elapsed timer
  useEffect(() => {
    if (status !== "running" || !pipelineStartTime) {
      return;
    }
    const interval = setInterval(() => {
      setElapsed(Date.now() - pipelineStartTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [status, pipelineStartTime]);

  const isRunning = status === "running" || status === "connecting";
  const isDone = status === "complete";
  const isError = status === "error";
  const isIdle = status === "idle";

  if (isIdle) return null;

  // Determine progress percentage
  const hasFileProgress = manifest.length > 0 && completedFiles.length > 0;
  const hasPhaseProgress = phaseProgress.total > 0;

  let progressPercent = 0;
  let progressLabel = "";

  if (hasFileProgress) {
    // Code generation phase — track by files
    progressPercent = Math.round((completedFiles.length / manifest.length) * 100);
    progressLabel = `${completedFiles.length} of ${manifest.length} files`;
  } else if (hasPhaseProgress) {
    // Analysis pipeline — track by phases
    progressPercent = Math.round((phaseProgress.index / phaseProgress.total) * 100);
    progressLabel = `Phase ${phaseProgress.index} of ${phaseProgress.total}`;
  }

  if (isDone) {
    progressPercent = 100;
  }

  const totalTimings = phaseTimings.total;

  return (
    <div className="mx-3 my-2 rounded-xl border border-cbv2-border bg-cbv2-bg/60 overflow-hidden">
      {/* Progress bar */}
      <div className="h-1.5 bg-cbv2-input/50 overflow-hidden">
        <div
          className={[
            "h-full rounded-r transition-all duration-700 ease-out",
            isError
              ? "bg-red-500"
              : isDone
                ? "bg-green-500"
                : "bg-gradient-to-r from-cbv2-accent to-blue-400",
            isRunning && !isDone ? "animate-pulse" : "",
          ].join(" ")}
          style={{ width: `${Math.max(progressPercent, isRunning ? 3 : 0)}%` }}
        />
      </div>

      <div className="px-3 py-2 flex items-center gap-3">
        {/* Status icon */}
        {isRunning ? (
          <Loader2 className="w-4 h-4 text-cbv2-accent animate-spin shrink-0" />
        ) : isDone ? (
          <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
        ) : isError ? (
          <Activity className="w-4 h-4 text-red-400 shrink-0" />
        ) : null}

        {/* Phase info */}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-cbv2-text truncate">
            {isDone
              ? "Pipeline complete"
              : isError
                ? "Pipeline failed"
                : currentPhase || "Starting..."}
          </div>
          {progressLabel && (
            <div className="text-[10px] text-cbv2-text-dim mt-0.5">
              {progressLabel}
              {isRunning && generatingFiles.length > 0 && (
                <span className="ml-2 text-cbv2-accent">
                  Generating: {generatingFiles[generatingFiles.length - 1]?.split("/").pop()}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Timing */}
        <div className="flex items-center gap-1.5 text-[10px] text-cbv2-text-dim shrink-0">
          <Clock className="w-3 h-3" />
          {isRunning && elapsed > 0
            ? formatElapsed(elapsed)
            : totalTimings
              ? `${totalTimings}s`
              : isDone && elapsed > 0
                ? formatElapsed(elapsed)
                : "—"}
        </div>

        {/* Percentage */}
        {progressPercent > 0 && (
          <span
            className={[
              "text-[11px] font-bold tabular-nums shrink-0",
              isDone ? "text-green-400" : isError ? "text-red-400" : "text-cbv2-accent",
            ].join(" ")}
          >
            {progressPercent}%
          </span>
        )}
      </div>
    </div>
  );
}
