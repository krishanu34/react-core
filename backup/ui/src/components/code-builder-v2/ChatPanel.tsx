"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import ChatContextSelector from "./ChatContextSelector";
import { useCBv2ModelConfigStatus } from "@/hooks/useCodeBuilderQueries";
import { authFetch } from "@/lib/auth";
import type {
  CBv2ChatMessage,
  CBv2ContextWindowPreview,
  CBv2GenerationStatus,
  CBv2ChatContext,
  CBv2WorkspaceAnalysisStatus,
} from "@/types/code-builder-v2";
import {
  Send,
  Sparkles,
  Bot,
  User,
  Info,
  Loader2,
  CheckCircle2,
  XCircle,
  Settings,
  History,
  Download,
  SlidersHorizontal,
  Check,
  X,
  Cog,
  FileCheck,
  FilePlus2,
  FileX2,
  FilePen,
  Play,
  ListChecks,
  AlertTriangle,
  PackageCheck,
  Search,
  Layers,
  CircleCheck,
  CircleX,
  RefreshCw,
  Zap,
  ClipboardList,
  ShieldAlert,
  FileText,
  Square,
  Plus,
  Trash2,
  MoreVertical,
} from "lucide-react";

// ── Status Badge ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CBv2GenerationStatus }) {
  const config = {
    idle: { icon: Sparkles, text: "Ready", color: "text-cbv2-text-dim" },
    connecting: {
      icon: Loader2,
      text: "Connecting...",
      color: "text-yellow-400",
    },
    running: {
      icon: Loader2,
      text: "Generating...",
      color: "text-cbv2-accent",
    },
    complete: {
      icon: CheckCircle2,
      text: "Complete",
      color: "text-green-400",
    },
    error: { icon: XCircle, text: "Error", color: "text-red-400" },
  };

  const { icon: Icon, text, color } = config[status];

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className={color}>{text}</span>
    </div>
  );
}

// ── Phase Progress Bar ──────────────────────────────────────────────────

function PhaseBar({ phase }: { phase: string }) {
  if (!phase) return null;

  return (
    <div className="px-3 py-1.5 bg-cbv2-accent/10 border-b border-cbv2-border text-[11px] text-cbv2-accent flex items-center gap-2">
      <Loader2 className="w-3 h-3 animate-spin" />
      <span className="truncate">{phase}</span>
    </div>
  );
}

// ── Event Icon mapping ───────────────────────────────────────────────────

function getEventIcon(eventType?: string, data?: Record<string, unknown>): { icon: React.ReactNode; color: string } | null {
  const cls = "w-3.5 h-3.5 flex-shrink-0";
  switch (eventType) {
    case "pipeline_started":
      return { icon: <Play className={cls} />, color: "text-cbv2-accent" };
    case "phase":
      return { icon: <Layers className={cls} />, color: "text-cbv2-accent" };
    case "thinking":
      return { icon: <Cog className={`${cls} animate-spin`} />, color: "text-cbv2-text-dim" };
    case "manifest":
    case "manifest_updated":
      return { icon: <ClipboardList className={cls} />, color: "text-cbv2-accent" };
    case "schedule_info":
      return { icon: <Zap className={cls} />, color: "text-amber-400" };
    case "batch_start":
    case "batch_complete":
      return { icon: <Layers className={cls} />, color: "text-cbv2-text-dim" };
    case "file_start":
      return { icon: <Cog className={`${cls} animate-spin`} />, color: "text-cbv2-accent" };
    case "file_complete": {
      const action = data?.action as string;
      if (action === "create") return { icon: <FilePlus2 className={cls} />, color: "text-green-400" };
      if (action === "delete") return { icon: <FileX2 className={cls} />, color: "text-red-400" };
      return { icon: <FilePen className={cls} />, color: "text-amber-400" };
    }
    case "dependency_found":
      return { icon: <PackageCheck className={cls} />, color: "text-amber-400" };
    case "generation_complete":
      return { icon: <CircleCheck className={cls} />, color: "text-green-400" };
    case "review_complete":
      return { icon: <Search className={cls} />, color: "text-cbv2-accent" };
    case "pipeline_complete":
      return { icon: <CheckCircle2 className={cls} />, color: "text-green-400" };
    case "workspace_updated":
      return { icon: <RefreshCw className={cls} />, color: "text-cbv2-accent" };
    case "confirmation_required":
      return { icon: <ListChecks className={cls} />, color: "text-amber-400" };
    case "plan_approval_required":
      return { icon: <ClipboardList className={cls} />, color: "text-cbv2-accent" };
    case "file_diff_approval_required":
      return { icon: <FilePen className={cls} />, color: "text-amber-400" };
    case "file_written":
      return { icon: <FileCheck className={cls} />, color: "text-green-400" };
    case "file_rejected":
    case "file_failed":
      return { icon: <CircleX className={cls} />, color: "text-red-400" };
    case "review_start":
      return { icon: <ClipboardList className={cls} />, color: "text-cbv2-accent" };
    case "feasibility_confirmation_required":
      return { icon: <ShieldAlert className={cls} />, color: "text-amber-400" };
    case "context_compacted":
      return { icon: <Layers className={cls} />, color: "text-cbv2-text-dim" };
    case "error":
      return { icon: <XCircle className={cls} />, color: "text-red-400" };
    case "approval":
      return { icon: <CircleCheck className={cls} />, color: "text-green-400" };
    default:
      return null;
  }
}

// ── Single Chat Message ─────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: CBv2ChatMessage }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  const Icon = isUser ? User : isSystem ? Info : Bot;

  const bubbleClass = isUser
    ? "bg-cbv2-accent/15 border border-cbv2-accent/30"
    : isSystem
      ? "bg-cbv2-input/50 border border-cbv2-border"
      : "bg-cbv2-sidebar border border-cbv2-border";

  const iconClass = isUser
    ? "bg-cbv2-accent text-white"
    : isSystem
      ? "bg-cbv2-input text-cbv2-text-dim"
      : "bg-cbv2-accent/80 text-white";

  const eventIcon = getEventIcon(msg.eventType, msg.data);

  // Render markdown-like bold + code text
  const renderContent = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={i} className="font-semibold text-cbv2-accent">
            {part.slice(2, -2)}
          </strong>
        );
      }
      const codeParts = part.split(/(`[^`]+`)/g);
      return codeParts.map((cp, j) => {
        if (cp.startsWith("`") && cp.endsWith("`")) {
          return (
            <code
              key={`${i}-${j}`}
              className="px-1 py-0.5 bg-cbv2-input rounded text-cbv2-accent text-[11px] font-mono border border-cbv2-border"
            >
              {cp.slice(1, -1)}
            </code>
          );
        }
        return <span key={`${i}-${j}`}>{cp}</span>;
      });
    });
  };

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`w-6 h-6 rounded flex items-center justify-center flex-shrink-0 mt-0.5 ${iconClass}`}
      >
        <Icon className="w-3.5 h-3.5" />
      </div>

      {/* Bubble */}
      <div
        className={[bubbleClass, "rounded-lg px-3 py-2 max-w-[90%] text-[12px] leading-relaxed", isUser ? "ml-auto" : "mr-auto"].join(" ")}
      >
        <div className="whitespace-pre-wrap break-words text-cbv2-text">
          {eventIcon && (
            <span className={`inline-flex items-center mr-1.5 align-text-bottom ${eventIcon.color}`}>
              {eventIcon.icon}
            </span>
          )}
          {renderContent(msg.content)}
        </div>

        <div className="text-[10px] text-cbv2-text-dim mt-1 text-right">
          {new Date(msg.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}

// ── Batch Review Card (Copilot-style end-of-run review) ──────────────

interface BatchChangeEntry {
  task_id: number;
  file_path: string;
  action: string;
  description?: string;
  preview?: string;
  original_preview?: string;
}

function BatchReviewCard({
  msg,
  onDecision,
  disabled,
  onFileClick,
}: {
  msg: CBv2ChatMessage;
  onDecision: (decision: { acceptAll?: boolean; rejectAll?: boolean; fileDecisions?: Array<{ file_path: string; approved: boolean }> }) => void;
  disabled: boolean;
  onFileClick?: (path: string) => void;
}) {
  const summary = (msg.data?.summary as { created: number; modified: number; deleted: number; total: number }) || { created: 0, modified: 0, deleted: 0, total: 0 };
  const changes = (msg.data?.changes as { created: BatchChangeEntry[]; modified: BatchChangeEntry[]; deleted: BatchChangeEntry[] }) || { created: [], modified: [], deleted: [] };
  const allEntries: BatchChangeEntry[] = [
    ...(changes.created || []),
    ...(changes.modified || []),
    ...(changes.deleted || []),
  ];

  // Default: every file is approved. User can uncheck to revert.
  const [approvedSet, setApprovedSet] = useState<Set<string>>(
    () => new Set(allEntries.map((e) => e.file_path))
  );

  const toggle = (fp: string) => {
    setApprovedSet((prev) => {
      const next = new Set(prev);
      if (next.has(fp)) next.delete(fp);
      else next.add(fp);
      return next;
    });
  };

  const renderGroup = (label: string, entries: BatchChangeEntry[], color: string) => {
    if (entries.length === 0) return null;
    return (
      <div className="border-b border-cbv2-border last:border-b-0">
        <div className={`px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold ${color} bg-cbv2-input/40`}>
          {label} ({entries.length})
        </div>
        {entries.map((entry) => {
          const isApproved = approvedSet.has(entry.file_path);
          return (
            <div key={entry.file_path} className="px-3 py-1.5 flex items-center gap-2 hover:bg-cbv2-hover/40 transition-colors">
              <input
                type="checkbox"
                checked={isApproved}
                onChange={() => toggle(entry.file_path)}
                disabled={disabled}
                className="accent-cbv2-accent flex-shrink-0"
                title={isApproved ? "Approve (keep file)" : "Reject (will be reverted on disk)"}
              />
              <button
                type="button"
                onClick={() => onFileClick?.(entry.file_path)}
                className="text-[11px] text-cbv2-accent hover:underline font-mono truncate flex-1 text-left"
                title={entry.file_path}
              >
                {entry.file_path}
              </button>
              {entry.description && (
                <span className="text-[10px] text-cbv2-text-dim truncate hidden md:inline-block max-w-[40%]">
                  {entry.description}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const totalSelected = approvedSet.size;
  const totalRejected = allEntries.length - totalSelected;

  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-lg border border-cbv2-accent/40 bg-cbv2-input/30 overflow-hidden">
        <div className="flex items-center gap-3 px-3 py-2 border-b border-cbv2-border bg-cbv2-accent/5">
          <PackageCheck className="w-4 h-4 text-cbv2-accent" />
          <div className="flex-1">
            <div className="text-[12px] font-medium text-cbv2-text">Review Generated Changes</div>
            <div className="text-[10px] text-cbv2-text-dim">
              {summary.total} file(s) on disk · click filename to preview · uncheck to revert
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-green-300">+{summary.created}</span>
            <span className="text-amber-300">~{summary.modified}</span>
            <span className="text-red-300">-{summary.deleted}</span>
          </div>
        </div>
        {renderGroup("Created", changes.created || [], "text-green-300")}
        {renderGroup("Modified", changes.modified || [], "text-amber-300")}
        {renderGroup("Deleted", changes.deleted || [], "text-red-300")}
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-[11px] font-medium transition-colors"
            onClick={() => onDecision({ acceptAll: true })}
            title="Keep all generated files as-is"
          >
            <Check className="w-3.5 h-3.5" /> Accept All ({summary.total})
          </button>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-[11px] font-medium transition-colors"
            onClick={() => onDecision({ rejectAll: true })}
            title="Revert every file on disk"
          >
            <X className="w-3.5 h-3.5" /> Reject All
          </button>
          {totalRejected > 0 && (
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cbv2-accent hover:bg-cbv2-accent/80 text-white text-[11px] font-medium transition-colors"
              onClick={() => onDecision({
                fileDecisions: allEntries.map((e) => ({
                  file_path: e.file_path,
                  approved: approvedSet.has(e.file_path),
                })),
              })}
              title="Apply only the checked files; revert the rest"
            >
              <FileCheck className="w-3.5 h-3.5" /> Apply Selected ({totalSelected})
            </button>
          )}
          <span className="text-[10px] text-cbv2-text-dim">
            {totalRejected > 0
              ? `${totalRejected} unchecked file(s) will be reverted on disk.`
              : `Files are already on disk — Accept All to keep, Reject All to revert.`}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Confirmation Card (inline approve/reject for proposed changes) ────

function ConfirmationCard({
  msg,
  onConfirm,
  onRunTasksSubset,
  disabled,
  onFileClick,
}: {
  msg: CBv2ChatMessage;
  onConfirm: (approved: boolean, selectedTaskIds?: string[]) => void;
  onRunTasksSubset?: (taskIds: string[]) => Promise<{ ok: boolean; detail?: string }>;
  disabled: boolean;
  onFileClick?: (path: string) => void;
}) {
  const isPlanApproval = !!msg.data?.plan_approval;
  const isFileDiffApproval = !!msg.data?.file_diff_approval;
  const planContent = (msg.data?.plan_content as string) || "";
  const proposed = (msg.data?.proposed_changes as Array<{
    file_path: string;
    action: string;
    diff_summary?: string;
    diff?: string;
  }>) || [];
  const planSteps = (msg.data?.plan_steps as Array<{
    step_id: number;
    title: string;
    description: string;
    tool: string;
  }>) || [];
  type PlanTask = {
    task_id: string;
    ordinal?: number;
    title: string;
    type?: string;
    story_refs?: string[];
    doc_refs?: string[];
    files_affected?: Array<{ path: string; action: string }>;
    change_overview?: string;
  };
  const tasks: PlanTask[] = ((msg.data?.tasks as PlanTask[]) || []);
  const selectedStories = (msg.data?.selected_stories as Array<{ id: string; title: string; type?: string }>) || [];
  const selectedDocuments = (msg.data?.selected_documents as Array<{ id: string; title: string; type?: string }>) || [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const [taskSelection, setTaskSelection] = useState<Set<string>>(new Set());
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<"unified" | "split">("unified");

  const toggleTask = (taskId: string) => {
    setTaskSelection((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const allSelected = tasks.length > 0 && taskSelection.size === tasks.length;
  const handleSelectAll = () => {
    setTaskSelection(allSelected ? new Set() : new Set(tasks.map((t) => t.task_id)));
  };

  const runSubset = async (taskIds: string[]) => {
    if (taskIds.length === 0) return;
    setBusyTaskId(taskIds.length === 1 ? taskIds[0] : "__bulk__");
    try {
      await onRunTasksSubset?.(taskIds);
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {/* Clickable planning.md link — opens in editor */}
      {isPlanApproval && planContent && (
        <button
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cbv2-border bg-cbv2-input/50 hover:bg-cbv2-hover/50 transition-colors w-full text-left group"
          onClick={() => onFileClick?.("planning.md")}
        >
          <FileText className="w-4 h-4 text-cbv2-accent flex-shrink-0" />
          <span className="text-[11px] font-medium text-cbv2-accent group-hover:underline">planning.md</span>
          <span className="text-[10px] text-cbv2-text-dim ml-auto">Click to view full plan</span>
        </button>
      )}

      {/* Plan step list */}
      {isPlanApproval && planSteps.length > 0 && tasks.length === 0 && (
        <div className="rounded-lg border border-cbv2-border bg-cbv2-input/50 overflow-hidden">
          {planSteps.map((step, i) => (
            <div key={i} className="border-b border-cbv2-border last:border-b-0 px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cbv2-accent/20 text-cbv2-accent text-[10px] font-bold flex items-center justify-center mt-0.5">
                  {step.step_id}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium text-cbv2-text">{step.title}</div>
                  <div className="text-[10px] text-cbv2-text-dim mt-0.5">{step.description}</div>
                </div>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-cbv2-border text-cbv2-text-dim font-mono flex-shrink-0">
                  {step.tool}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected story / document chips */}
      {isPlanApproval && (selectedStories.length > 0 || selectedDocuments.length > 0) && (
        <div className="rounded-lg border border-cbv2-border bg-cbv2-input/40 px-3 py-2 space-y-1.5">
          <div className="text-[10px] font-semibold text-cbv2-text-dim uppercase tracking-wide">Selected references</div>
          <div className="flex flex-wrap gap-1.5">
            {selectedStories.length === 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cbv2-border/40 text-cbv2-text-dim italic">No user stories selected</span>
            )}
            {selectedStories.map((s) => (
              <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 font-mono" title={s.title}>
                {s.id} · {s.title.slice(0, 40)}
              </span>
            ))}
            {selectedDocuments.length === 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cbv2-border/40 text-cbv2-text-dim italic">No documents selected</span>
            )}
            {selectedDocuments.map((d) => (
              <span key={d.id} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 font-mono" title={d.title}>
                {d.id} · {d.title.slice(0, 40)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Per-task cards with checkbox + Run button */}
      {isPlanApproval && tasks.length > 0 && (
        <div className="rounded-lg border border-cbv2-border bg-cbv2-input/50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-cbv2-border bg-cbv2-input/70">
            <label className="flex items-center gap-2 cursor-pointer text-[11px] text-cbv2-text">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={handleSelectAll}
                className="accent-cbv2-accent"
              />
              <span>Select all ({tasks.length})</span>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                disabled={taskSelection.size === 0 || !!busyTaskId || !onRunTasksSubset}
                onClick={() => runSubset(Array.from(taskSelection))}
                className="text-[11px] px-2 py-1 rounded bg-cbv2-accent/20 hover:bg-cbv2-accent/30 disabled:opacity-40 disabled:cursor-not-allowed text-cbv2-accent font-medium transition-colors"
              >
                {busyTaskId === "__bulk__" ? "Running…" : `Run selected (${taskSelection.size})`}
              </button>
            </div>
          </div>
          {tasks.map((task) => {
            const isExpanded = expanded === task.task_id;
            const checked = taskSelection.has(task.task_id);
            return (
              <div key={task.task_id} className="border-b border-cbv2-border last:border-b-0">
                <div className="px-3 py-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTask(task.task_id)}
                    className="mt-1 accent-cbv2-accent"
                  />
                  <span className="flex-shrink-0 px-1.5 py-0.5 rounded bg-cbv2-accent/20 text-cbv2-accent text-[10px] font-bold font-mono">
                    {task.task_id}
                  </span>
                  <div className="flex-1 min-w-0">
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : task.task_id)}
                      className="text-left w-full"
                    >
                      <div className="text-[11px] font-medium text-cbv2-text">{task.title}</div>
                      {task.change_overview && (
                        <div className="text-[10px] text-cbv2-text-dim mt-0.5 line-clamp-2">{task.change_overview}</div>
                      )}
                    </button>
                    {(task.story_refs?.length || task.doc_refs?.length) ? (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(task.story_refs || []).map((sid) => (
                          <span key={`s-${sid}`} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-300 font-mono">{sid}</span>
                        ))}
                        {(task.doc_refs || []).map((did) => (
                          <span key={`d-${did}`} className="text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 font-mono">{did}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {/* Per-task Run button intentionally hidden — users
                      should use checkbox selection + the bulk
                      "Run selected" action above so the planner runs
                      coherent subsets rather than one task at a time. */}
                </div>
                {isExpanded && (task.files_affected?.length || 0) > 0 && (
                  <div className="px-3 pb-2 pl-12 space-y-0.5">
                    {(task.files_affected || []).map((f, i) => (
                      <div key={i} className="text-[10px] font-mono flex items-center gap-1.5">
                        <span className={`px-1 rounded ${f.action === "create" ? "bg-green-500/15 text-green-300" : f.action === "delete" ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300"}`}>
                          {f.action.toUpperCase()}
                        </span>
                        <button
                          type="button"
                          onClick={() => onFileClick?.(f.path)}
                          className="text-cbv2-accent hover:underline"
                        >
                          {f.path}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Per-file diff approval card (gate before write) */}
      {isFileDiffApproval && (() => {
        const filePath = (msg.data?.file_path as string) || "";
        const action = ((msg.data?.action as string) || "modify").toLowerCase();
        const diff = (msg.data?.diff as string) || "";
        const oldContent = (msg.data?.old_content as string) || "";
        const newContent = (msg.data?.new_content as string) || "";
        const fileIndex = msg.data?.file_index as number | undefined;
        const filesTotal = msg.data?.files_total as number | undefined;
        const stepSummary = (msg.data?.step_summary as string) || "";
        const actionColor = action === "create"
          ? "text-green-400 bg-green-500/10"
          : action === "delete"
            ? "text-red-400 bg-red-500/10"
            : "text-amber-400 bg-amber-500/10";
        const actionLabel = action === "create" ? "NEW" : action === "delete" ? "DEL" : "MOD";
        const oldLines = oldContent ? oldContent.split("\n") : [];
        const newLines = newContent ? newContent.split("\n") : [];
        const colorizeDiffLine = (line: string): string => {
          if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "text-cbv2-accent";
          if (line.startsWith("+")) return "text-green-300";
          if (line.startsWith("-")) return "text-red-300";
          return "text-cbv2-text-dim";
        };
        return (
          <div className="rounded-lg border border-cbv2-border bg-cbv2-input/50 overflow-hidden">
            {/* Header row */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-cbv2-border bg-cbv2-input/70">
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${actionColor}`}>{actionLabel}</span>
              <button
                type="button"
                onClick={() => onFileClick?.(filePath)}
                className="text-[11px] text-cbv2-accent font-mono flex-1 truncate text-left hover:underline"
                title={filePath}
              >
                {filePath}
              </button>
              {(fileIndex && filesTotal) ? (
                <span className="text-[10px] text-cbv2-text-dim font-mono">
                  {fileIndex}/{filesTotal}
                </span>
              ) : null}
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={() => setDiffViewMode("unified")}
                  className={`text-[10px] px-2 py-0.5 rounded ${diffViewMode === "unified" ? "bg-cbv2-accent/20 text-cbv2-accent" : "text-cbv2-text-dim hover:text-cbv2-text"}`}
                >Unified</button>
                <button
                  onClick={() => setDiffViewMode("split")}
                  className={`text-[10px] px-2 py-0.5 rounded ${diffViewMode === "split" ? "bg-cbv2-accent/20 text-cbv2-accent" : "text-cbv2-text-dim hover:text-cbv2-text"}`}
                >Split</button>
              </div>
            </div>

            {stepSummary && (
              <div className="px-3 py-1.5 text-[10px] text-cbv2-text-dim border-b border-cbv2-border bg-cbv2-input/30">
                {stepSummary}
              </div>
            )}

            {/* Body — unified or split */}
            {diffViewMode === "unified" ? (
              <pre className="px-3 py-2 text-[10px] font-mono bg-black/30 overflow-x-auto max-h-[420px] overflow-y-auto whitespace-pre">
                {diff
                  ? diff.split("\n").map((line, i) => (
                      <div key={i} className={colorizeDiffLine(line)}>{line || "\u00a0"}</div>
                    ))
                  : <span className="text-cbv2-text-dim italic">(no diff content)</span>}
              </pre>
            ) : (
              <div className="grid grid-cols-2 gap-px bg-cbv2-border max-h-[420px] overflow-hidden">
                <div className="bg-black/30 overflow-auto">
                  <div className="sticky top-0 px-3 py-1 text-[10px] uppercase tracking-wide text-red-300 bg-black/50 border-b border-cbv2-border">
                    Old{action === "create" ? " (none)" : ""}
                  </div>
                  <pre className="px-3 py-2 text-[10px] font-mono whitespace-pre">
                    {oldLines.length === 0
                      ? <span className="text-cbv2-text-dim italic">(file did not exist)</span>
                      : oldLines.map((l, i) => (
                          <div key={i} className="flex">
                            <span className="text-cbv2-text-dim/40 select-none w-8 text-right pr-2">{i + 1}</span>
                            <span className="text-cbv2-text-dim flex-1">{l || "\u00a0"}</span>
                          </div>
                        ))}
                  </pre>
                </div>
                <div className="bg-black/30 overflow-auto">
                  <div className="sticky top-0 px-3 py-1 text-[10px] uppercase tracking-wide text-green-300 bg-black/50 border-b border-cbv2-border">
                    New{action === "delete" ? " (deleted)" : ""}
                  </div>
                  <pre className="px-3 py-2 text-[10px] font-mono whitespace-pre">
                    {newLines.length === 0
                      ? <span className="text-cbv2-text-dim italic">(file removed)</span>
                      : newLines.map((l, i) => (
                          <div key={i} className="flex">
                            <span className="text-cbv2-text-dim/40 select-none w-8 text-right pr-2">{i + 1}</span>
                            <span className="text-cbv2-text flex-1">{l || "\u00a0"}</span>
                          </div>
                        ))}
                  </pre>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* File change list */}
      {!isPlanApproval && proposed.length > 0 && (
        <div className="rounded-lg border border-cbv2-border bg-cbv2-input/50 overflow-hidden">
          {proposed.map((change, i) => {
            const isNew = change.action === "create";
            const isDelete = change.action === "delete";
            const isExpanded = expanded === change.file_path;
            const actionColor = isNew
              ? "text-green-400 bg-green-500/10"
              : isDelete
                ? "text-red-400 bg-red-500/10"
                : "text-amber-400 bg-amber-500/10";
            const actionLabel = isNew ? "NEW" : isDelete ? "DEL" : "MOD";
            return (
              <div key={i} className="border-b border-cbv2-border last:border-b-0">
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-cbv2-hover/50 transition-colors flex items-center gap-2"
                  onClick={() => setExpanded(isExpanded ? null : change.file_path)}
                >
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${actionColor}`}>
                    {actionLabel}
                  </span>
                  <code className="text-cbv2-accent font-mono flex-1">{change.file_path}</code>
                  <span className="text-cbv2-text-dim text-[10px]">{change.diff_summary || change.action}</span>
                </button>
                {isExpanded && change.diff && (
                  <pre className="px-3 py-2 text-[10px] font-mono bg-black/30 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre text-cbv2-text-dim">
                    {change.diff}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Approve / Reject buttons */}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-[11px] font-medium transition-colors"
            onClick={() => onConfirm(true, isPlanApproval && taskSelection.size > 0 ? Array.from(taskSelection) : undefined)}
          >
            <Check className="w-3.5 h-3.5" />
            {isFileDiffApproval
              ? "Apply Change"
              : isPlanApproval
                ? (taskSelection.size > 0
                    ? `Approve ${taskSelection.size} task${taskSelection.size === 1 ? "" : "s"}`
                    : "Approve Plan")
                : "Approve Changes"}
          </button>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-[11px] font-medium transition-colors"
            onClick={() => onConfirm(false)}
          >
            <X className="w-3.5 h-3.5" />
            {isFileDiffApproval ? "Skip File" : "Reject"}
          </button>
          {isPlanApproval && taskSelection.size > 0 && (
            <span className="text-[10px] text-cbv2-text-dim">
              Only the {taskSelection.size} selected task{taskSelection.size === 1 ? "" : "s"} will run on approval.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Context Window Ring Indicator ────────────────────────────────────────

function ContextRing({
  preview,
  loading,
}: {
  preview: CBv2ContextWindowPreview | null;
  loading: boolean;
}) {
  if (loading && !preview) {
    return (
      <div className="relative w-8 h-8 flex items-center justify-center" title="Loading context preview...">
        <Loader2 className="w-4 h-4 animate-spin text-cbv2-text-dim" />
      </div>
    );
  }
  if (!preview || !preview.context_window_tokens) return null;

  const used = preview.final_input_tokens;
  const budget = preview.context_window_tokens;
  const pct = Math.min(used / budget, 1);

  // Color: green < 60%, amber 60-85%, red > 85%
  const color =
    pct > 0.85 ? "stroke-red-400" : pct > 0.6 ? "stroke-amber-400" : "stroke-cbv2-accent";

  const r = 12;
  const circ = 2 * Math.PI * r;
  const filled = circ * pct;
  const gap = circ - filled;
  const displayPct = Math.round(pct * 100);

  const tooltipLines = [
    `${used.toLocaleString()} / ${budget.toLocaleString()} input tokens (${displayPct}%)`,
    `Prompt: ${preview.prompt_tokens}`,
    preview.story_tokens > 0 ? `Stories: ${preview.story_tokens}` : null,
    preview.document_tokens > 0 ? `Docs: ${preview.document_tokens}` : null,
    preview.smart_context_tokens > 0 ? `Codebase: ${preview.smart_context_tokens}` : null,
    `Output reserve: ${preview.reserved_output_tokens}`,
    preview.would_compact ? "Context will be compacted" : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="relative w-8 h-8 flex items-center justify-center group" title={tooltipLines}>
      <svg width="30" height="30" viewBox="0 0 30 30" className="transform -rotate-90">
        {/* Background ring */}
        <circle cx="15" cy="15" r={r} fill="none" strokeWidth="3" className="stroke-cbv2-border" />
        {/* Filled arc */}
        <circle
          cx="15"
          cy="15"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          className={`${color} transition-all duration-300`}
          strokeDasharray={`${filled} ${gap}`}
        />
      </svg>
      {/* Center text */}
      <span className="absolute inset-0 flex items-center justify-center text-[8px] font-medium text-cbv2-text-dim leading-none">
        {displayPct}
      </span>
      {loading && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-cbv2-accent animate-pulse" />
      )}
    </div>
  );
}

// ── Chat Panel ──────────────────────────────────────────────────────────

interface CBv2ChatPanelProps {
  messages: CBv2ChatMessage[];
  status: CBv2GenerationStatus;
  currentPhase: string;
  onSend: (description: string, context: CBv2ChatContext) => void;
  onContextChange?: (context: CBv2ChatContext) => void;
  onOpenHistory?: () => void;
  onDownloadZip?: () => void;
  hasGeneratedCode?: boolean;
  analysisStatus?: CBv2WorkspaceAnalysisStatus | null;
  pendingConfirmation?: boolean;
  onConfirmation?: (approved: boolean, selectedTaskIds?: string[]) => void;
  onBatchReview?: (decision: { acceptAll?: boolean; rejectAll?: boolean; fileDecisions?: Array<{ file_path: string; approved: boolean }> }) => void;
  onRunTasksSubset?: (taskIds: string[]) => Promise<{ ok: boolean; detail?: string }>;
  onFileClick?: (path: string) => void;
  currentSessionId?: number | null;
  currentRunId?: string | null;
  /** Called when user selects a different project — resets session */
  onProjectChange?: () => void;
  /** Stop / cancel the in-flight pipeline run. */
  onStop?: () => void | Promise<void>;
  /** Clear chat history and start a brand-new session. */
  onNewSession?: () => void;
  /** Clear chat history for the active session (keeps session_id). */
  onClearHistory?: (opts?: { deleteArtifacts?: boolean }) => void | Promise<void>;
  initialProjectId?: number | null;
}

export default function CBv2ChatPanel({
  messages,
  status,
  currentPhase,
  onSend,
  onContextChange,
  onOpenHistory,
  onDownloadZip,
  hasGeneratedCode,
  analysisStatus,
  pendingConfirmation,
  onConfirmation,
  onBatchReview,
  onRunTasksSubset,
  onFileClick,
  currentSessionId,
  currentRunId,
  onProjectChange,
  onStop,
  onNewSession,
  onClearHistory,
  initialProjectId,
}: CBv2ChatPanelProps) {
  const [input, setInput] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [chatContext, setChatContext] = useState<CBv2ChatContext>({
    project_id: null,
    project_name: "",
    pipeline_type: "greenfield",
    selected_story_ids: [],
    selected_stories: [],
    selected_document_ids: [],
    selected_documents: [],
    selected_doc_types: [],
  });

  // Sync from parent's initialProjectId on mount
  useEffect(() => {
    if (initialProjectId && initialProjectId > 0) {
      setChatContext((prev) => prev.project_id ? prev : { ...prev, project_id: initialProjectId });
    }
  }, [initialProjectId]);
  const [debouncedInput, setDebouncedInput] = useState("");
  const [contextPreview, setContextPreview] = useState<CBv2ContextWindowPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check model config status when project changes (via React Query)
  const { data: modelConfigData } = useCBv2ModelConfigStatus(chatContext.project_id);
  const modelConfigStatus = {
    configured: modelConfigData?.configured ?? true,
    message: modelConfigData?.message,
    model_name: modelConfigData?.model_name,
    checking: false,
  };

  // Keep chatContext.session_id in sync with the auto-loaded session id
  // surfaced by the parent (via currentSessionId). Without this, any
  // subsequent context tweak (pipeline type, story selection, etc.) would
  // emit a stale chatContext.session_id=null upstream and clobber the
  // session that was just auto-selected when the project was opened.
  useEffect(() => {
    setChatContext((prev) => {
      if ((prev.session_id ?? null) === (currentSessionId ?? null)) return prev;
      return { ...prev, session_id: currentSessionId ?? null };
    });
  }, [currentSessionId]);

  // Notify parent whenever the context changes (e.g. project selected)
  const handleContextChange = useCallback(
    (ctx: CBv2ChatContext) => {
      // Detect project change — reset session for a fresh start
      const projectChanged = ctx.project_id !== chatContext.project_id;
      setChatContext(ctx);
      onContextChange?.(ctx);
      if (projectChanged && ctx.project_id) {
        onProjectChange?.();
      }
    },
    [onContextChange, onProjectChange, chatContext.project_id]
  );

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Close the overflow menu when clicking outside.
  useEffect(() => {
    if (!showOverflow) return;
    const onDocClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showOverflow]);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedInput(input.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [input]);

  useEffect(() => {
    if (!chatContext.project_id || !modelConfigStatus.configured) {
      setContextPreview(null);
      setPreviewLoading(false);
      return;
    }

    const controller = new AbortController();
    const shouldPreview =
      !!debouncedInput ||
      chatContext.selected_story_ids.length > 0 ||
      chatContext.selected_document_ids.length > 0;

    if (!shouldPreview) {
      setContextPreview(null);
      setPreviewLoading(false);
      return;
    }

    setPreviewLoading(true);
    authFetch("/cb-api/context-window-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: chatContext.project_id,
        user_prompt: debouncedInput,
        pipeline_type: chatContext.pipeline_type,
        stories: (chatContext.selected_stories ?? []).map((story) => ({
          id: story.id,
          type: story.artifact_type,
          title: story.title,
          description: story.description ?? "",
          content: story.content ?? {},
        })),
        documents: (chatContext.selected_documents ?? []).map((doc) => ({
          id: doc.id,
          type: doc.artifact_type,
          title: doc.title,
          description: doc.description ?? "",
          content: doc.content ?? {},
        })),
        document_types: chatContext.selected_doc_types ?? [],
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setContextPreview(data);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setContextPreview(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPreviewLoading(false);
        }
      });

    return () => controller.abort();
  }, [
    debouncedInput,
    chatContext.project_id,
    chatContext.pipeline_type,
    chatContext.selected_story_ids,
    chatContext.selected_document_ids,
    chatContext.selected_stories,
    chatContext.selected_documents,
    chatContext.selected_doc_types,
    modelConfigStatus.configured,
  ]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || status === "running" || status === "connecting") return;
    onSend(text, chatContext);
    setInput("");
    setShowContext(false); // Collapse context after sending
  }, [input, status, onSend, chatContext]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const isRunning = status === "running" || status === "connecting";
  const isAnalysisBusy = analysisStatus != null &&
    (analysisStatus.status === "pending" || analysisStatus.status === "analyzing" || analysisStatus.status === "ingesting");

  // Esc → Stop Generation while a run is in flight. Skipped while the
  // user is composing inside the textarea so plain Esc doesn't kill the
  // run when they're just trying to dismiss focus elsewhere on the page.
  useEffect(() => {
    if (!isRunning || !onStop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isRunning, onStop]);

  // Context summary for the header badge
  const contextSummary = chatContext.project_id
    ? chatContext.project_name
    : null;

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text">
      {/* Header — with GitHub Copilot-style action icons */}
      <div className="px-3 py-2 border-b border-cbv2-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-cbv2-accent" />
          <span className="text-[12px] font-sans font-medium">
            AI Code Builder
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Context toggle (like GitHub Copilot's @ icon) */}
          <button
            className={[
              "p-1.5 rounded transition-colors",
              showContext
                ? "bg-cbv2-accent/20 text-cbv2-accent"
                : "hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white",
            ].join(" ")}
            onClick={() => setShowContext((s) => !s)}
            title="Toggle Context Panel"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={onOpenHistory}
            title="Pipeline History"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          {isRunning && onStop && (
            <button
              className="p-1.5 rounded hover:bg-red-500/15 text-cbv2-text-dim hover:text-red-400 transition-colors"
              onClick={() => onStop()}
              title="Stop Generation (Esc)"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}
          {(onClearHistory || onNewSession) && (
            <div className="relative" ref={overflowRef}>
              <button
                className={[
                  "p-1.5 rounded transition-colors",
                  showOverflow
                    ? "bg-cbv2-accent/15 text-cbv2-accent"
                    : "hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white",
                ].join(" ")}
                onClick={() => setShowOverflow((s) => !s)}
                title="Session actions"
                aria-haspopup="menu"
                aria-expanded={showOverflow}
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
              {showOverflow && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1 w-56 bg-cbv2-sidebar border border-cbv2-border rounded-md shadow-lg z-30 py-1"
                >
                  {onNewSession && (
                    <button
                      role="menuitem"
                      className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-cbv2-text hover:bg-cbv2-hover text-left"
                      onClick={() => {
                        setShowOverflow(false);
                        if (
                          messages.length === 0 ||
                          window.confirm(
                            "Start a new session? Your generated files remain on disk under their existing session bucket."
                          )
                        ) {
                          onNewSession();
                        }
                      }}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span className="flex-1">New Session</span>
                    </button>
                  )}
                  {onClearHistory && messages.length > 0 && (
                    <button
                      role="menuitem"
                      className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-400 hover:bg-red-500/10 text-left"
                      onClick={() => {
                        setShowOverflow(false);
                        if (
                          window.confirm(
                            "Clear chat history for this session?\n\nThe session and any generated files stay on disk; only the conversation transcript is wiped."
                          )
                        ) {
                          onClearHistory();
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span className="flex-1">Clear History</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {hasGeneratedCode && (
            <button
              className="p-1.5 rounded hover:bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-accent transition-colors"
              onClick={onDownloadZip}
              title="Download ZIP"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="w-px h-4 bg-cbv2-border mx-0.5" />
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Active context badge (compact, always visible when project selected) */}
      {contextSummary && !showContext && (
        <button
          className="px-3 py-1 bg-cbv2-accent/5 border-b border-cbv2-border flex items-center gap-2 text-[10px] hover:bg-cbv2-accent/10 transition-colors w-full text-left"
          onClick={() => setShowContext(true)}
        >
          <span className="text-cbv2-text truncate">{contextSummary}</span>
          {chatContext.selected_story_ids.length > 0 && (
            <span className="text-cbv2-text-dim">
              · {chatContext.selected_story_ids.length} stories
            </span>
          )}
          {chatContext.selected_document_ids.length > 0 && (
            <span className="text-cbv2-text-dim">
              · {chatContext.selected_document_ids.length} docs
            </span>
          )}
          <Settings className="w-3 h-3 text-cbv2-text-dim ml-auto flex-shrink-0" />
        </button>
      )}

      {/* Collapsible context selector (GitHub Copilot style) */}
      {showContext && (
        <ChatContextSelector
          context={chatContext}
          currentSessionId={currentSessionId}
          currentRunId={currentRunId}
          onChange={handleContextChange}
          onClose={() => setShowContext(false)}
        />
      )}

      {/* Phase bar */}
      {isRunning && <PhaseBar phase={currentPhase} />}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 space-y-3 cbv2-scrollbar"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-cbv2-text-dim">
            <Bot className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-[12px] text-center">
              {chatContext.project_id ? (
                <>
                  Project <strong className="text-cbv2-accent">{chatContext.project_name}</strong> selected.
                  <br />
                  <span className="text-[11px]">
                    Describe what you want to build or modify.
                  </span>
                </>
              ) : (
                <>
                  Select a project using the{" "}
                  <button
                    className="text-cbv2-accent hover:underline inline"
                    onClick={() => setShowContext(true)}
                  >
                    context panel
                  </button>
                  , then describe your project.
                  <br />
                  <span className="text-[11px]">
                    e.g., &quot;Full-stack e-commerce app with Python backend
                    and Next.js frontend&quot;
                  </span>
                </>
              )}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <React.Fragment key={msg.id}>
              <MessageBubble msg={msg} />
              {!!msg.data?.needs_confirmation && (
                msg.data?.batch_review ? (
                  <BatchReviewCard
                    msg={msg}
                    onDecision={(decision) => onBatchReview?.(decision)}
                    disabled={!pendingConfirmation}
                    onFileClick={onFileClick}
                  />
                ) : (
                  <ConfirmationCard
                    msg={msg}
                    onConfirm={(approved, selectedTaskIds) => onConfirmation?.(approved, selectedTaskIds)}
                    onRunTasksSubset={onRunTasksSubset}
                    disabled={!pendingConfirmation}
                    onFileClick={onFileClick}
                  />
                )
              )}
            </React.Fragment>
          ))
        )}

        {/* Typing indicator when running */}
        {isRunning && (
          <div className="flex items-center gap-2 text-cbv2-text-dim text-[11px] pl-8">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Agent is working...</span>
          </div>
        )}
      </div>

      {/* Model config warning */}
      {chatContext.project_id && !modelConfigStatus.configured && !modelConfigStatus.checking && (
        <div className="px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-[11px] text-yellow-400 flex items-start gap-2">
          <Settings className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">LLM model not configured for Code Builder</p>
            <p className="text-yellow-400/80 mt-0.5">
              Please go to <strong>Project Settings → AI Models</strong> and select a model for <strong>Code Builder (Base)</strong> before generating code.
            </p>
          </div>
        </div>
      )}

      {/* Analysis pending warning */}
      {isAnalysisBusy && (
        <div className="px-3 py-2 bg-yellow-950/30 border-t border-yellow-800/50 text-[11px] text-yellow-300 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
          <span>
            Code analysis in progress — wait for it to complete or remove the workspace source to continue.
          </span>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-cbv2-border p-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              className="w-full px-3 py-2 bg-cbv2-input border border-cbv2-border rounded-lg text-[12px] text-cbv2-text placeholder-cbv2-text-dim resize-none focus:border-cbv2-accent outline-none min-h-[40px] max-h-[120px]"
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isRunning
                  ? "Generation in progress..."
                  : isAnalysisBusy
                    ? "Analysis in progress — please wait or remove the source..."
                    : !chatContext.project_id
                      ? "Select a project first, then describe your project..."
                      : !modelConfigStatus.configured
                        ? "Please configure an AI model for Code Builder in project settings..."
                        : `Describe what to build for ${chatContext.project_name}...`
              }
              disabled={isRunning || isAnalysisBusy || (!!chatContext.project_id && !modelConfigStatus.configured)}
            />
          </div>
          <div className="flex flex-col gap-1">
            {/* Context window ring indicator */}
            {chatContext.project_id && (contextPreview || previewLoading) && (
              <ContextRing preview={contextPreview} loading={previewLoading} />
            )}
            {isRunning && onStop ? (
              <button
                type="button"
                className="p-2 rounded-lg bg-red-500/15 border border-red-500/40 text-red-400 hover:bg-red-500/25 hover:text-red-300 transition-colors"
                onClick={() => onStop()}
                title="Stop Generation (Esc)"
                aria-label="Stop generation"
              >
                <Square className="w-4 h-4" fill="currentColor" />
              </button>
            ) : (
              <button
                className={[
                  "p-2 rounded-lg transition-colors",
                  isAnalysisBusy || (chatContext.project_id && !modelConfigStatus.configured)
                    ? "bg-cbv2-input text-cbv2-text-dim cursor-not-allowed"
                    : input.trim()
                      ? "bg-cbv2-accent text-white hover:bg-cbv2-accent/80"
                      : "bg-cbv2-input text-cbv2-text-dim",
                ].join(" ")}
                onClick={handleSend}
                disabled={isAnalysisBusy || !input.trim() || (!!chatContext.project_id && !modelConfigStatus.configured)}
                title={isAnalysisBusy ? "Analysis in progress — wait or remove source" : "Send (Enter)"}
              >
                <Send className="w-4 h-4" />
              </button>
            )}
            <button
              className={[
                "p-2 rounded-lg transition-colors",
                showContext
                  ? "bg-cbv2-accent/20 text-cbv2-accent"
                  : "bg-cbv2-input text-cbv2-text-dim hover:text-cbv2-text",
              ].join(" ")}
              onClick={() => setShowContext((s) => !s)}
              title="Toggle Context"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="mt-1 text-[10px] text-cbv2-text-dim">
          Shift+Enter for newline · Enter to send
        </div>
      </div>
    </div>
  );
}
