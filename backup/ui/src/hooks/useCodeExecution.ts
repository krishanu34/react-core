"use client";

import { useCallback, useRef, useState } from "react";
import type {
  CBv2ExecutionStatus,
  CBv2ExecStep,
  CBv2ExecLine,
  CBv2ExecProgress,
} from "@/types/code-builder-v2";
import { getToken } from "@/lib/auth";

/* ── WebSocket URL — connect directly to code-builder backend ── */
function _execWsUrl(): string {
  if (typeof window === "undefined") {
    return "ws://localhost:8001/ws/execute";
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const port = new URL(
    process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL || "http://localhost:8001"
  ).port || "8001";
  const base = `${proto}//${window.location.hostname}:${port}/ws/execute`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

interface UseCodeExecutionReturn {
  status: CBv2ExecutionStatus;
  lines: CBv2ExecLine[];
  steps: CBv2ExecStep[];
  technologies: string[];
  attempt: number;
  maxAttempts: number;
  summary: { success: boolean; attempts: number; message: string; elapsedSeconds?: number } | null;
  progress: CBv2ExecProgress | null;

  startExecution: (params: {
    run_id?: string;
    output_dir?: string;
    project_id?: number | null;
  }) => void;
  stopExecution: () => void;
  clearOutput: () => void;
}

let lineId = 0;
function nextLineId() {
  lineId += 1;
  return lineId;
}

export function useCodeExecution(): UseCodeExecutionReturn {
  const [status, setStatus] = useState<CBv2ExecutionStatus>("idle");
  const [lines, setLines] = useState<CBv2ExecLine[]>([]);
  const [steps, setSteps] = useState<CBv2ExecStep[]>([]);
  const [technologies, setTechnologies] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [summary, setSummary] = useState<{
    success: boolean;
    attempts: number;
    message: string;
    elapsedSeconds?: number;
  } | null>(null);
  const [progress, setProgress] = useState<CBv2ExecProgress | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const addLine = useCallback(
    (type: CBv2ExecLine["type"], text: string, phase?: string) => {
      setLines((prev) => [
        ...prev,
        { id: nextLineId(), type, text, phase, timestamp: Date.now() },
      ]);
    },
    []
  );

  const handleEvent = useCallback(
    (event: Record<string, unknown>) => {
      const t = event.type as string;

      switch (t) {
        case "exec_phase":
          setStatus("detecting");
          addLine("info", `▶ ${event.message}`, event.phase as string);
          break;

        case "exec_tech_detected":
          setTechnologies(event.technologies as string[]);
          addLine(
            "success",
            `✓ Detected: ${(event.technologies as string[]).join(", ")}`,
            "detection"
          );
          if (event.entry_point) {
            addLine("info", `  Entry point: ${event.entry_point}`, "detection");
          }
          break;

        case "exec_plan":
          setSteps(
            (event.steps as Array<Record<string, string>>).map((s) => ({
              phase: s.phase,
              label: s.label,
              command: s.command,
              status: "pending" as const,
            }))
          );
          addLine("separator", "─── Execution Plan ───");
          (event.steps as Array<Record<string, string>>).forEach((s) => {
            addLine("info", `  • ${s.label}: ${s.command}`);
          });
          addLine("separator", "─────────────────────");
          break;

        case "exec_attempt":
          setAttempt(event.attempt as number);
          setMaxAttempts(event.max_attempts as number);
          setStatus("running");
          if ((event.attempt as number) > 1) {
            addLine(
              "separator",
              `─── Retry Attempt ${event.attempt}/${event.max_attempts} ───`
            );
          }
          break;

        case "exec_step_start":
          setSteps((prev) =>
            prev.map((s) =>
              s.phase === event.phase ? { ...s, status: "running" as const } : s
            )
          );
          addLine(
            "command",
            `$ ${event.command}`,
            event.phase as string
          );
          break;

        case "exec_cmd_start":
          addLine("info", `  [${event.phase}] Running: ${event.command}`, event.phase as string);
          break;

        case "exec_output": {
          const stream = event.stream as string;
          const lineType: CBv2ExecLine["type"] =
            stream === "stderr" ? "stderr" : "stdout";
          addLine(lineType, event.line as string, event.phase as string);
          break;
        }

        case "exec_cmd_end":
          if (event.success) {
            addLine("success", `  ✓ Exit code: ${event.exit_code}`, event.phase as string);
          } else {
            addLine("error", `  ✗ Exit code: ${event.exit_code}`, event.phase as string);
          }
          break;

        case "exec_step_pass":
          setSteps((prev) =>
            prev.map((s) =>
              s.phase === event.phase ? { ...s, status: "passed" as const } : s
            )
          );
          addLine("success", `✓ ${event.label} — PASSED`, event.phase as string);
          break;

        case "exec_step_fail":
          setSteps((prev) =>
            prev.map((s) =>
              s.phase === event.phase
                ? { ...s, status: "failed" as const, exitCode: event.exit_code as number }
                : s
            )
          );
          addLine("error", `✗ ${event.label} — FAILED (exit ${event.exit_code})`, event.phase as string);
          break;

        case "exec_healing":
          setStatus("healing");
          addLine("separator", `─── Self-Heal (Attempt ${event.attempt}) ───`);
          addLine("heal", `🔧 ${event.message}`);
          // Show ETA if available
          if (event.estimated_remaining_seconds) {
            const eta = event.estimated_remaining_seconds as number;
            const etaMins = Math.floor(eta / 60);
            const etaSecs = Math.round(eta % 60);
            addLine("info", `  ⏱ Est. remaining: ${etaMins > 0 ? `${etaMins}m ` : ""}${etaSecs}s`);
          }
          // Show error categories if available
          if (event.error_categories) {
            const cats = event.error_categories as Record<string, number>;
            const parts = Object.entries(cats)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            if (parts) {
              addLine("info", `  📊 Error breakdown: ${parts}`);
            }
          }
          break;

        case "heal_start":
          addLine("heal", `🤖 ${event.message}`);
          break;

        case "heal_analysis":
          addLine("heal", `📝 Agent analysis: ${(event.message as string).slice(0, 300)}...`);
          break;

        case "heal_file_patched":
          addLine("heal", `  ✏️ Patched: ${event.path} (${event.size} bytes)`);
          break;

        case "heal_result":
          if (event.success) {
            addLine("success", `✓ ${event.message} — re-executing...`);
            // Reset step statuses for retry
            setSteps((prev) =>
              prev.map((s) => ({ ...s, status: "pending" as const }))
            );
          } else {
            addLine("error", `✗ Self-heal failed: ${event.message}`);
          }
          break;

        case "exec_summary":
          setSummary({
            success: event.success as boolean,
            attempts: event.attempts as number,
            message: event.message as string,
            elapsedSeconds: event.elapsed_seconds as number | undefined,
          });
          setStatus(event.success ? "success" : "failed");
          addLine("separator", "═══════════════════════════════════════");
          addLine(
            event.success ? "success" : "error",
            `${event.success ? "🎉" : "❌"} ${event.message}`
          );
          if (event.elapsed_seconds) {
            const secs = event.elapsed_seconds as number;
            const mins = Math.floor(secs / 60);
            const remSecs = secs % 60;
            addLine("info", `  ⏱ Total time: ${mins > 0 ? `${mins}m ` : ""}${remSecs}s`);
          }
          if (event.errors_fixed && (event.errors_fixed as number) > 0) {
            addLine("info", `  🔧 Errors auto-fixed: ${event.errors_fixed}/${event.initial_errors}`);
          }
          addLine("separator", "═══════════════════════════════════════");
          break;

        case "exec_stuck":
          setStatus("failed");
          addLine("separator", "═══════════════════════════════════════");
          addLine("error", `⚠ ${event.message}`);
          addLine("info", `  Stopped after ${event.attempt} attempt(s) — same errors repeating.`);
          if (event.errors_fixed && (event.errors_fixed as number) > 0) {
            addLine("info", `  🔧 ${event.errors_fixed} error(s) were fixed before stopping.`);
          }
          addLine("separator", "═══════════════════════════════════════");
          break;

        case "exec_error":
          addLine("error", `❌ ${event.message}`);
          break;

        case "exec_progress":
          setProgress({
            totalAttempts: event.total_attempts as number,
            avgAttemptSeconds: event.avg_attempt_seconds as number,
            initialErrors: event.initial_errors as number,
            currentErrors: event.current_errors as number,
            errorsFixed: event.errors_fixed as number,
            fixRate: event.fix_rate as number,
            estimatedRemainingAttempts: event.estimated_remaining_attempts as number,
            estimatedRemainingSeconds: event.estimated_remaining_seconds as number,
            isMakingProgress: event.is_making_progress as boolean,
            errorCategories: (event.error_categories as Record<string, number>) || {},
            elapsedSeconds: event.elapsed_seconds as number,
          });
          break;

        case "exec_done":
          if (status === "running" || status === "healing" || status === "detecting") {
            setStatus((prev) =>
              prev === "running" || prev === "detecting" || prev === "healing"
                ? "failed"
                : prev
            );
          }
          break;

        default:
          break;
      }
    },
    [addLine, status]
  );

  const startExecution = useCallback(
    (params: {
      run_id?: string;
      output_dir?: string;
      project_id?: number | null;
    }) => {
      // Reset state
      setLines([]);
      setSteps([]);
      setTechnologies([]);
      setAttempt(0);
      setSummary(null);
      setProgress(null);
      setStatus("connecting");

      addLine("info", "⚡ Connecting to execution service...");

      // Close existing WS
      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = new WebSocket(_execWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("detecting");
        addLine("info", "✓ Connected. Starting auto-execution...");
        ws.send(
          JSON.stringify({
            run_id: params.run_id ?? null,
            output_dir: params.output_dir ?? null,
            project_id: params.project_id ?? null,
          })
        );
      };

      ws.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data);
          handleEvent(event);
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        setStatus("failed");
        addLine(
          "error",
          "❌ WebSocket connection error. Is the Code Builder backend running on port 8001?"
        );
      };

      ws.onclose = () => {
        wsRef.current = null;
      };
    },
    [addLine, handleEvent]
  );

  const stopExecution = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus("idle");
    addLine("info", "⏹ Execution stopped by user.");
  }, [addLine]);

  const clearOutput = useCallback(() => {
    setLines([]);
    setSteps([]);
    setTechnologies([]);
    setAttempt(0);
    setSummary(null);
    setProgress(null);
    setStatus("idle");
  }, []);

  return {
    status,
    lines,
    steps,
    technologies,
    attempt,
    maxAttempts,
    summary,
    progress,
    startExecution,
    stopExecution,
    clearOutput,
  };
}
