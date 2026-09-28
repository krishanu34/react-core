"use client";

import { useEffect, useRef, useState } from "react";
import {
  Terminal,
  Play,
  Square,
  Trash2,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  Wrench,
  Cpu,
  RotateCcw,
  Filter,
} from "lucide-react";
import type {
  CBv2ExecutionStatus,
  CBv2ExecStep,
  CBv2ExecLine,
  CBv2ExecProgress,
} from "@/types/code-builder-v2";

interface ExecutionTerminalProps {
  status: CBv2ExecutionStatus;
  lines: CBv2ExecLine[];
  steps: CBv2ExecStep[];
  technologies: string[];
  attempt: number;
  summary: { success: boolean; attempts: number; message: string; elapsedSeconds?: number } | null;
  progress: CBv2ExecProgress | null;
  onRun: () => void;
  onStop: () => void;
  onClear: () => void;
  canRun: boolean;
}

/* Status → color badge */
function statusBadge(status: CBv2ExecutionStatus) {
  switch (status) {
    case "idle":
      return { label: "Ready", color: "bg-gray-600 text-gray-300" };
    case "connecting":
      return { label: "Connecting", color: "bg-yellow-900/50 text-yellow-400" };
    case "detecting":
      return { label: "Detecting", color: "bg-blue-900/50 text-blue-400" };
    case "running":
      return { label: "Running", color: "bg-blue-900/50 text-blue-400" };
    case "healing":
      return { label: "Self-Healing", color: "bg-purple-900/50 text-purple-400" };
    case "success":
      return { label: "Passed", color: "bg-emerald-900/50 text-emerald-400" };
    case "failed":
      return { label: "Failed", color: "bg-red-900/50 text-red-400" };
  }
}

/* Step status icon */
function StepIcon({ status }: { status: CBv2ExecStep["status"] }) {
  switch (status) {
    case "pending":
      return <Circle size={12} className="text-gray-500" />;
    case "running":
      return <Loader2 size={12} className="text-blue-400 animate-spin" />;
    case "passed":
      return <CheckCircle2 size={12} className="text-emerald-400" />;
    case "failed":
      return <XCircle size={12} className="text-red-400" />;
  }
}

/* Line color mapping */
function lineColor(type: CBv2ExecLine["type"]) {
  switch (type) {
    case "command":
      return "text-cyan-300";
    case "stdout":
      return "text-gray-300";
    case "stderr":
      return "text-red-400";
    case "info":
      return "text-blue-300";
    case "success":
      return "text-emerald-400";
    case "error":
      return "text-red-400";
    case "separator":
      return "text-gray-600";
    case "heal":
      return "text-purple-300";
  }
}

export default function ExecutionTerminal({
  status,
  lines,
  steps,
  technologies,
  attempt,
  summary,
  progress,
  onRun,
  onStop,
  onClear,
  canRun,
}: ExecutionTerminalProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showSteps, setShowSteps] = useState(true);
  const [hiddenPhases, setHiddenPhases] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  const badge = statusBadge(status);
  const isActive = status === "running" || status === "healing" || status === "detecting" || status === "connecting";

  /* Collect unique phases from the output lines */
  const availablePhases = Array.from(new Set(lines.map((l) => l.phase).filter(Boolean))) as string[];

  /* Filter lines by hidden phases */
  const filteredLines = hiddenPhases.size === 0
    ? lines
    : lines.filter((l) => !l.phase || !hiddenPhases.has(l.phase));

  const togglePhase = (phase: string) => {
    setHiddenPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });
  };

  /* Auto-scroll to bottom */
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  /* Auto-expand when execution starts */
  useEffect(() => {
    if (isActive) {
      setIsCollapsed(false);
    }
  }, [isActive]);

  if (isCollapsed) {
    return (
      <div className="border-t border-cbv2-border bg-[#0d1117] h-8 flex items-center px-3 gap-2 shrink-0">
        <Terminal size={12} className="text-cbv2-accent" />
        <span className="text-[11px] text-gray-300 font-medium">
          Execution Terminal
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.color}`}>
          {badge.label}
        </span>
        {isActive && (
          <Loader2 size={11} className="text-cbv2-accent animate-spin" />
        )}
        <div className="flex-1" />
        <button
          onClick={() => setIsCollapsed(false)}
          className="text-gray-500 hover:text-gray-300"
          title="Expand Terminal"
        >
          <ChevronUp size={14} />
        </button>
      </div>
    );
  }

  const terminalHeight = isExpanded ? 450 : 260;

  return (
    <div
      className="border-t border-cbv2-border bg-[#0d1117] flex flex-col shrink-0"
      style={{ height: terminalHeight }}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-cbv2-border bg-[#161b22] shrink-0">
        <Terminal size={13} className="text-cbv2-accent" />
        <span className="text-[11px] text-gray-200 font-medium">
          Execution Terminal
        </span>

        {/* Traffic lights */}
        <div className="flex items-center gap-1 ml-1">
          <Circle size={6} className="text-red-500 fill-red-500" />
          <Circle size={6} className="text-yellow-500 fill-yellow-500" />
          <Circle size={6} className="text-green-500 fill-green-500" />
        </div>

        {/* Status badge */}
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.color}`}>
          {badge.label}
        </span>

        {/* Attempt counter when healing */}
        {attempt > 0 && (
          <span className="text-[10px] text-gray-500 flex items-center gap-1">
            <RotateCcw size={10} />
            attempt {attempt} (auto)
          </span>
        )}

        {/* Tech stack */}
        {technologies.length > 0 && (
          <span className="text-[10px] text-gray-500 flex items-center gap-1">
            <Cpu size={10} />
            {technologies.join(", ")}
          </span>
        )}

        {/* ETA / Progress when active */}
        {isActive && progress && progress.currentErrors > 0 && (
          <span className="text-[10px] text-yellow-400/80 flex items-center gap-1">
            ⏱ ~{progress.estimatedRemainingSeconds >= 60
              ? `${Math.floor(progress.estimatedRemainingSeconds / 60)}m ${Math.round(progress.estimatedRemainingSeconds % 60)}s`
              : `${Math.round(progress.estimatedRemainingSeconds)}s`} remaining
          </span>
        )}
        {isActive && progress && progress.errorsFixed > 0 && (
          <span className="text-[10px] text-emerald-400/80 flex items-center gap-1">
            🔧 {progress.errorsFixed}/{progress.initialErrors} fixed
          </span>
        )}

        <div className="flex-1" />

        {/* Controls */}
        <div className="flex items-center gap-1">
          {/* Run / Stop */}
          {isActive ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px]
                         bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
              title="Stop Execution"
            >
              <Square size={10} />
              Stop
            </button>
          ) : (
            <button
              onClick={onRun}
              disabled={!canRun}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                canRun
                  ? "bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50"
                  : "bg-gray-800 text-gray-600 cursor-not-allowed"
              }`}
              title={canRun ? "Run Code" : "Generate code first"}
            >
              <Play size={10} />
              Run
            </button>
          )}

          <button
            onClick={onClear}
            className="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-white/5"
            title="Clear Output"
          >
            <Trash2 size={12} />
          </button>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 rounded ${
              autoScroll
                ? "text-cbv2-accent bg-cbv2-accent/10"
                : "text-gray-500 hover:text-gray-300"
            }`}
            title="Auto-scroll"
          >
            <ChevronDown size={12} />
          </button>

          <button
            onClick={() => setShowSteps(!showSteps)}
            className={`p-1 rounded text-[10px] ${
              showSteps
                ? "text-cbv2-accent bg-cbv2-accent/10"
                : "text-gray-500 hover:text-gray-300"
            }`}
            title="Toggle Steps Panel"
          >
            <Wrench size={12} />
          </button>

          {/* Phase filter dropdown */}
          {availablePhases.length > 1 && (
            <div className="relative group">
              <button
                className={`p-1 rounded text-[10px] ${
                  hiddenPhases.size > 0
                    ? "text-yellow-400 bg-yellow-900/20"
                    : "text-gray-500 hover:text-gray-300"
                }`}
                title="Filter by phase"
              >
                <Filter size={12} />
              </button>
              <div className="absolute right-0 bottom-full mb-1 hidden group-hover:block
                            bg-[#1c2333] border border-cbv2-border rounded shadow-lg z-50 min-w-[140px] py-1">
                {availablePhases.map((phase) => (
                  <button
                    key={phase}
                    onClick={() => togglePhase(phase)}
                    className={`w-full text-left px-3 py-1 text-[10px] flex items-center gap-2 hover:bg-white/5 ${
                      hiddenPhases.has(phase) ? "text-gray-600 line-through" : "text-gray-300"
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      hiddenPhases.has(phase) ? "bg-gray-600" : "bg-emerald-400"
                    }`} />
                    {phase}
                  </button>
                ))}
                {hiddenPhases.size > 0 && (
                  <button
                    onClick={() => setHiddenPhases(new Set())}
                    className="w-full text-left px-3 py-1 text-[10px] text-blue-400 hover:bg-white/5 border-t border-cbv2-border mt-0.5 pt-1"
                  >
                    Show all
                  </button>
                )}
              </div>
            </div>
          )}

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-white/5"
          >
            {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>

          <button
            onClick={() => setIsCollapsed(true)}
            className="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-white/5"
            title="Collapse"
          >
            <ChevronDown size={12} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Steps sidebar */}
        {showSteps && steps.length > 0 && (
          <div className="w-[200px] border-r border-cbv2-border bg-[#0d1117] overflow-y-auto p-2 shrink-0">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-medium">
              Steps
            </div>
            {steps.map((step, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 px-2 py-1.5 rounded text-[11px] mb-0.5 ${
                  step.status === "running"
                    ? "bg-blue-900/20 text-blue-300"
                    : step.status === "passed"
                    ? "text-emerald-400/80"
                    : step.status === "failed"
                    ? "text-red-400/80"
                    : "text-gray-500"
                }`}
              >
                <StepIcon status={step.status} />
                <span className="truncate">{step.label}</span>
              </div>
            ))}

            {/* Progress card (live during execution) */}
            {progress && isActive && (
              <div className="mt-3 p-2 rounded border border-blue-800/50 bg-blue-900/10 text-[10px]">
                <div className="font-medium text-blue-300 mb-1.5">📊 Progress</div>

                {/* Error resolution progress bar */}
                {progress.initialErrors > 0 && (
                  <div className="mb-1.5">
                    <div className="flex justify-between text-gray-400 mb-0.5">
                      <span>Errors fixed</span>
                      <span className="text-emerald-400">
                        {progress.errorsFixed}/{progress.initialErrors}
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(100, Math.round((progress.errorsFixed / Math.max(1, progress.initialErrors)) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* ETA */}
                {progress.estimatedRemainingSeconds > 0 && (
                  <div className="flex justify-between text-gray-400 mb-0.5">
                    <span>Est. remaining</span>
                    <span className="text-yellow-400">
                      {progress.estimatedRemainingSeconds >= 60
                        ? `~${Math.floor(progress.estimatedRemainingSeconds / 60)}m ${Math.round(progress.estimatedRemainingSeconds % 60)}s`
                        : `~${Math.round(progress.estimatedRemainingSeconds)}s`}
                    </span>
                  </div>
                )}

                {/* Current errors */}
                <div className="flex justify-between text-gray-400 mb-0.5">
                  <span>Current errors</span>
                  <span className={progress.currentErrors === 0 ? "text-emerald-400" : "text-red-400"}>
                    {progress.currentErrors}
                  </span>
                </div>

                {/* Error categories */}
                {Object.keys(progress.errorCategories).length > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-blue-800/30">
                    <div className="text-gray-500 mb-0.5">Error types:</div>
                    {Object.entries(progress.errorCategories)
                      .filter(([, v]) => v > 0)
                      .map(([cat, count]) => (
                        <div key={cat} className="flex justify-between text-gray-500 pl-1">
                          <span>{cat.replace(/_/g, " ")}</span>
                          <span className="text-red-400/70">{count}</span>
                        </div>
                      ))}
                  </div>
                )}

                {/* Making progress indicator */}
                {progress.totalAttempts >= 2 && (
                  <div className={`mt-1 text-[9px] ${progress.isMakingProgress ? "text-emerald-400/60" : "text-yellow-400/60"}`}>
                    {progress.isMakingProgress
                      ? "✓ Making progress — errors decreasing"
                      : "⚠ Progress stalled — may need manual review"}
                  </div>
                )}
              </div>
            )}

            {/* Summary card */}
            {summary && (
              <div
                className={`mt-3 p-2 rounded border text-[10px] ${
                  summary.success
                    ? "border-emerald-800 bg-emerald-900/20 text-emerald-400"
                    : "border-red-800 bg-red-900/20 text-red-400"
                }`}
              >
                <div className="font-medium mb-1">
                  {summary.success ? "✓ All Passed" : "✗ Failed"}
                </div>
                <div className="text-gray-400">
                  {summary.attempts} attempt{summary.attempts > 1 ? "s" : ""}
                </div>
                {summary.elapsedSeconds != null && (
                  <div className="text-gray-500 mt-0.5">
                    ⏱ {summary.elapsedSeconds >= 60
                      ? `${Math.floor(summary.elapsedSeconds / 60)}m ${summary.elapsedSeconds % 60}s`
                      : `${summary.elapsedSeconds}s`}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Terminal output */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-[1.6] min-w-0"
        >
          {lines.length === 0 && (
            <div className="text-gray-600 text-center mt-8">
              <Terminal size={24} className="mx-auto mb-2 opacity-30" />
              <div className="text-[11px]">
                Click <span className="text-emerald-500">Run</span> to auto-execute the generated code
              </div>
              <div className="text-[10px] mt-1 text-gray-700">
                Errors will be automatically fixed by the AI agent
              </div>
            </div>
          )}

          {filteredLines.map((line) => (
            <div
              key={line.id}
              className={`${lineColor(line.type)} ${
                line.type === "separator" ? "mt-1 mb-0.5 opacity-50" : ""
              } ${line.type === "heal" ? "pl-2 border-l-2 border-purple-700/50" : ""}`}
            >
              {line.type === "command" ? (
                <span>
                  <span className="text-emerald-400 select-none">$ </span>
                  <span className="text-cyan-300">{line.text.replace(/^\$\s*/, "")}</span>
                </span>
              ) : line.type === "stderr" ? (
                <span className="text-red-400/90">{line.text}</span>
              ) : (
                line.text
              )}
            </div>
          ))}

          {/* Blinking cursor when active */}
          {isActive && (
            <div className="text-emerald-400 animate-pulse">▋</div>
          )}
        </div>
      </div>
    </div>
  );
}
