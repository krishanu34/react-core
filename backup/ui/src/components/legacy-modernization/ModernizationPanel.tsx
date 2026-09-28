"use client";

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  CBv2ChatMessage,
  CBv2GenerationStatus,
} from "@/types/code-builder-v2";
import type {
  LegacyCodebaseChangeFile,
  LegacyModernizationDraft,
  LegacyModernizationProject,
  LegacyModernizationStartRequest,
} from "@/types/legacy-modernization";
import { authFetch, getUser } from "@/lib/auth";
import { useLegacyModProjects, useLegacyModSuggestions } from "@/hooks/useLegacyModernizationQueries";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCircle2,
  Code2,
  Download,
  FolderArchive,
  GitCompareArrows,
  GitBranch,
  History,
  Info,
  Layers,
  Loader2,
  MapPin,
  Rocket,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Target,
  Upload,
  User,
  XCircle,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import PipelineProgressBar from "./PipelineProgressBar";
import AnalysisInsights from "./AnalysisInsights";
import FileGenerationTracker from "./FileGenerationTracker";
import OpenQuestionsCard from "./OpenQuestionsCard";
import { previewGitRepoFiles, gitPush } from "@/lib/legacy-modernization-api";
import { extractTextFromFile } from "@/lib/document-text-extractor";
import { getLegacyModernizationApiRoot } from "@/lib/legacy-modernization-url";

function subscribeAuthSnapshot(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("focus", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("focus", onStoreChange);
  };
}

function getUsernameSnapshot() {
  return getUser()?.username?.trim() || "there";
}

function getServerUsernameSnapshot() {
  return "there";
}

function getProjectEligibilityLabel(project: LegacyModernizationProject): string {
  const configuredLabel = String(project.legacy_modernization_model_label ?? "").trim();
  const modelName = String(project.legacy_modernization_model_name ?? "").trim();
  const vendor = String(project.legacy_modernization_model_vendor ?? "").trim();
  const message = String(project.modernization_validation_message ?? "").toLowerCase();
  if (project.modernization_eligible === true || project.legacy_modernization_model_configured === true) {
    if (configuredLabel) return configuredLabel;
    if (modelName && vendor) return `${modelName} (${vendor})`;
    if (modelName) return modelName;
    if (vendor) return vendor;
    return "Model details unavailable";
  }
  if (message.includes("inactive")) return "Model inactive";
  if (message.includes("no 'base' model") || message.includes("no ai model is configured") || message.includes("no ai models are configured")) {
    return "Model missing";
  }
  if (message.includes("no settings configured")) return "Setup missing";
  if (project.legacy_modernization_model_configured === false || project.modernization_eligible === undefined) return "Model missing";
  return "Not eligible";
}

interface ModernizationPanelProps {
  messages: CBv2ChatMessage[];
  status: CBv2GenerationStatus;
  currentPhase: string;
  draft: LegacyModernizationDraft;
  summary: Record<string, unknown> | null;
  targetStack?: string;
  onDraftChange: (patch: Partial<LegacyModernizationDraft>) => void;
  onStart: (request: LegacyModernizationStartRequest) => void;
  onSendChat?: (message: string) => Promise<string | null>;
  onApproveCodebaseChange?: (proposalId: string, changedFiles: LegacyCodebaseChangeFile[]) => Promise<boolean>;
  onRejectCodebaseChange?: (proposalId: string) => void;
  onPreviewCodebaseChange?: (proposalId: string, changedFile: LegacyCodebaseChangeFile) => void;
  onOpenHistory?: () => void;
  onDownloadZip?: () => void;
  onBackToProjects?: () => void;
  onZipUploadSuccess?: (workspaceRoot?: string) => void;
  onGitPreviewLoaded?: (payload: { tree: Array<Record<string, unknown>>; count: number; provider?: string; branch?: string }) => void;
  onPushSuccess?: () => void;
  hasGeneratedCode?: boolean;
  /** Progress tracking */
  phaseProgress?: { index: number; total: number };
  phaseTimings?: Record<string, number>;
  pipelineStartTime?: number | null;
  analysisMetrics?: {
    totalFiles: number;
    sourceFiles: number;
    primaryLanguage: string;
    languageCounts: Record<string, number>;
    importantFilesCount: number;
    excludedFiles: number;
    analysisMode: string;
  } | null;
  generatingFiles?: string[];
  completedFiles?: string[];
  manifest?: Array<{ path: string; description: string }>;
  /** Open questions with suggested answers */
  openQuestions?: string[];
  openQuestionsSuggested?: string[];
  openQuestionsStatus?: "idle" | "pending" | "answered";
  onSubmitOpenQuestions?: (answers: Record<string, string>, stage?: string) => void;
  onSkipOpenQuestions?: () => void;
}

const FALLBACK_TARGET_STACK_EXAMPLES = [
  "Upload tech stack document",
];

const FALLBACK_MODERNIZATION_GOAL_EXAMPLES = [
  "Upload goal document",
  "skip",
];

const SOURCE_INPUT_EXAMPLES = ["Upload ZIP"];

const START_EXAMPLES = ["Start Modernization", "Restart Process"];

interface LegacySourceState {
  workspaceRoot: string;
  sourcePath: string;
  sourceKind: string;
  sourceUrl?: string;
  sourceBlobUrl?: string;
}

function StatusBadge({ status }: { status: CBv2GenerationStatus }) {
  const config = {
    idle: { icon: Sparkles, text: "Ready", color: "text-cbv2-text-dim", bg: "" },
    connecting: {
      icon: Loader2,
      text: "Connecting...",
      color: "text-yellow-400",
      bg: "bg-yellow-400/10",
    },
    running: {
      icon: Loader2,
      text: "Generating...",
      color: "text-cbv2-accent",
      bg: "bg-cbv2-accent/10",
    },
    complete: {
      icon: CheckCircle2,
      text: "Complete",
      color: "text-green-400",
      bg: "bg-green-400/10",
    },
    error: { icon: XCircle, text: "Error", color: "text-red-400", bg: "bg-red-400/10" },
  } as const;

  const { icon: Icon, text, color, bg } = config[status];

  return (
    <div className={`flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full ${bg}`}>
      <Icon className={`w-3.5 h-3.5 ${color} ${status === "running" || status === "connecting" ? "animate-spin" : ""}`} />
      <span className={color}>{text}</span>
    </div>
  );
}

/* ── Setup Stepper ─────────────────────────────────────────────── */

const SETUP_STEPS = [
  { key: "project", label: "Project", icon: Layers },
  { key: "source", label: "Source", icon: FolderArchive },
  { key: "stack", label: "Target Stack", icon: Target },
  { key: "goals", label: "Goals", icon: Zap },
  { key: "start", label: "Start", icon: Rocket },
] as const;

function SetupStepper({
  currentStep,
}: {
  currentStep: number;
}) {
  return (
    <div className="px-3 py-2.5 border-b border-cbv2-border bg-gradient-to-r from-cbv2-bg to-cbv2-sidebar">
      <div className="flex items-center justify-between">
        {SETUP_STEPS.map((step, idx) => {
          const Icon = step.icon;
          const isComplete = idx < currentStep;
          const isCurrent = idx === currentStep;
          return (
            <React.Fragment key={step.key}>
              <div className="flex flex-col items-center gap-1 min-w-0">
                <div
                  className={[
                    "w-7 h-7 rounded-full flex items-center justify-center transition-all duration-300",
                    isComplete
                      ? "bg-green-500/20 text-green-400 ring-1 ring-green-500/40"
                      : isCurrent
                        ? "bg-cbv2-accent/20 text-cbv2-accent ring-2 ring-cbv2-accent/60 shadow-lg shadow-cbv2-accent/20"
                        : "bg-cbv2-input text-cbv2-text-dim",
                  ].join(" ")}
                >
                  {isComplete ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <Icon className="w-3.5 h-3.5" />
                  )}
                </div>
                <span
                  className={[
                    "text-[9px] font-medium tracking-wide transition-colors",
                    isComplete
                      ? "text-green-400"
                      : isCurrent
                        ? "text-cbv2-accent"
                        : "text-cbv2-text-dim",
                  ].join(" ")}
                >
                  {step.label}
                </span>
              </div>
              {idx < SETUP_STEPS.length - 1 && (
                <div className="flex-1 mx-1 h-px relative top-[-8px]">
                  <div className="h-px bg-cbv2-border w-full" />
                  <div
                    className="h-px bg-green-500/60 absolute top-0 left-0 transition-all duration-500"
                    style={{ width: isComplete ? "100%" : "0%" }}
                  />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ── Phase Divider ─────────────────────────────────────────────── */

function getPhaseLabel(eventType?: string): string | null {
  if (!eventType) return null;
  if (eventType.startsWith("setup_")) return "Setup";
  if (eventType.startsWith("repository_validation")) return "Repository Validation";
  if (eventType === "analysis_start" || eventType === "analysis_progress" || eventType === "analysis_result") return "Analysis";
  if (eventType === "roadmap" || eventType === "roadmap_status") return "Roadmap";
  if (eventType === "spec_start" || eventType === "spec_progress" || eventType === "spec_complete") return "Specifications";
  if (eventType === "codegen_start" || eventType === "codegen_progress" || eventType === "file_start" || eventType === "file_complete" || eventType === "file_content") return "Code Generation";
  if (eventType === "complete") return "Complete";
  return null;
}

function PhaseDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="flex-1 h-px bg-cbv2-border/50" />
      <span className="text-[9px] uppercase tracking-wider text-cbv2-text-dim font-semibold px-2 py-0.5 rounded-full bg-cbv2-input/50 border border-cbv2-border/50">
        {label}
      </span>
      <div className="flex-1 h-px bg-cbv2-border/50" />
    </div>
  );
}

function getCodebaseChangeProposal(msg: CBv2ChatMessage): {
  proposalId: string;
  changedFiles: LegacyCodebaseChangeFile[];
  impactPlan: string[];
  status: "pending" | "approved" | "rejected";
} | null {
  if (msg.eventType !== "chat_code_change_proposed") return null;
  const proposalId = typeof msg.data?.proposalId === "string" ? msg.data.proposalId : "";
  const rawFiles = Array.isArray(msg.data?.changedFiles) ? msg.data.changedFiles : [];
  const changedFiles = rawFiles
    .map((item) => item as Record<string, unknown>)
    .map((item) => ({
      path: String(item.path ?? ""),
      reason: String(item.reason ?? ""),
      language: String(item.language ?? "plaintext"),
      size: typeof item.size === "number" ? item.size : Number(item.size ?? 0),
      originalContent: String(item.originalContent ?? ""),
      content: String(item.content ?? ""),
      diffPreview: String(item.diffPreview ?? ""),
    }))
    .filter((item) => item.path);
  const impactPlan = Array.isArray(msg.data?.impactPlan)
    ? msg.data.impactPlan.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const statusValue = msg.data?.status;
  const status = statusValue === "approved" || statusValue === "rejected" ? statusValue : "pending";
  if (!proposalId) return null;
  return { proposalId, changedFiles, impactPlan, status };
}

function splitProposalPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.pop() || normalized;
  return {
    fileName,
    directory: parts.join("/"),
  };
}

function MessageBubble({
  msg,
  onSelectExample,
  targetStackExamples,
  modernizationGoalExamples,
  suggestionsLoading,
  disabledExamples = [],
  pendingExampleLabels = {},
  pendingProposalIds = [],
  onApproveCodebaseChange,
  onRejectCodebaseChange,
  onPreviewCodebaseChange,
}: {
  msg: CBv2ChatMessage;
  onSelectExample?: (value: string) => void;
  targetStackExamples?: string[];
  modernizationGoalExamples?: string[];
  suggestionsLoading?: boolean;
  disabledExamples?: string[];
  pendingExampleLabels?: Record<string, string>;
  pendingProposalIds?: string[];
  onApproveCodebaseChange?: (proposalId: string, changedFiles: LegacyCodebaseChangeFile[]) => void;
  onRejectCodebaseChange?: (proposalId: string) => void;
  onPreviewCodebaseChange?: (proposalId: string, changedFile: LegacyCodebaseChangeFile) => void;
}) {
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
  const examples =
    msg.eventType === "setup_source_prompt"
      ? SOURCE_INPUT_EXAMPLES
      : msg.eventType === "repository_validation_required"
      ? ["Proceed anyway", "Stop pipeline"]
      : msg.eventType === "setup_project_selected"
      ? (targetStackExamples ?? FALLBACK_TARGET_STACK_EXAMPLES)
      : msg.eventType === "setup_target_stack"
        ? (modernizationGoalExamples ?? FALLBACK_MODERNIZATION_GOAL_EXAMPLES)
        : msg.eventType === "setup_ready"
          ? START_EXAMPLES
          : [];
  const proposal = getCodebaseChangeProposal(msg);
  const isProposalPending = Boolean(proposal && pendingProposalIds.includes(proposal.proposalId));

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""} animate-fade-in`}>
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${iconClass} shadow-sm`}>
        <Icon className="w-3.5 h-3.5" />
      </div>

      <div
        className={[
          bubbleClass,
          "rounded-xl px-3.5 py-2.5 max-w-[88%] text-[12px] leading-relaxed shadow-sm",
          isUser ? "ml-auto" : "mr-auto",
        ].join(" ")}
      >

        {isUser ? (
          <div className="whitespace-pre-wrap break-words text-cbv2-text">
            {msg.content}
          </div>
        ) : (
          <div className="prose-chat break-words text-cbv2-text">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-cbv2-text">{children}</strong>,
                em: ({ children }) => <em className="italic text-cbv2-text/80">{children}</em>,
                code: ({ children }) => (
                  <code className="px-1 py-0.5 rounded bg-cbv2-input text-[11px] font-mono text-cbv2-accent">
                    {children}
                  </code>
                ),
                pre: ({ children }) => (
                  <pre className="my-2 p-2.5 rounded-lg bg-cbv2-bg border border-cbv2-border overflow-x-auto text-[11px]">
                    {children}
                  </pre>
                ),
                ul: ({ children }) => <ul className="list-disc list-inside mb-1.5 space-y-0.5">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside mb-1.5 space-y-0.5">{children}</ol>,
                li: ({ children }) => <li className="text-cbv2-text">{children}</li>,
                h1: ({ children }) => <h1 className="text-[14px] font-bold mb-1.5 text-cbv2-text">{children}</h1>,
                h2: ({ children }) => <h2 className="text-[13px] font-bold mb-1 text-cbv2-text">{children}</h2>,
                h3: ({ children }) => <h3 className="text-[12px] font-semibold mb-1 text-cbv2-text">{children}</h3>,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-cbv2-accent hover:underline">
                    {children}
                  </a>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-cbv2-accent/40 pl-2.5 my-1.5 text-cbv2-text-dim italic">
                    {children}
                  </blockquote>
                ),
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}

        {suggestionsLoading && (msg.eventType === "setup_project_selected" || msg.eventType === "setup_target_stack") ? (
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cbv2-text-dim">
            <Loader2 className="w-3 h-3 animate-spin" />
            Generating AI suggestions from your repo...
          </div>
        ) : null}

        {examples.length > 0 && onSelectExample ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {examples.map((example) => {
              const isUpload = example === "Upload goal document" || example === "Upload tech stack document";
              const isStart = example === "Start Modernization";
              const isRestart = example === "Restart Process";
              const isStop = example === "Stop pipeline";
              const isProceed = example === "Proceed anyway";
              const isDisabled = disabledExamples.includes(example);
              const label = pendingExampleLabels[example] ?? example;
              return (
                <button
                  key={example}
                  className={isStart
                    ? "px-3 py-1.5 rounded-full border-2 border-green-500/60 bg-green-500/20 text-green-400 text-[11px] hover:bg-green-500/30 hover:border-green-400 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-green-500/20 disabled:hover:border-green-500/60 transition-colors text-left flex items-center gap-1.5 font-semibold shadow-sm shadow-green-500/10"
                    : isRestart
                      ? "px-3 py-1.5 rounded-full border-2 border-amber-500/50 bg-amber-500/15 text-amber-400 text-[11px] hover:bg-amber-500/25 hover:border-amber-400 disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-left flex items-center gap-1.5 font-medium"
                    : isStop
                      ? "px-3 py-1.5 rounded-full border border-red-500/50 bg-red-500/15 text-red-400 text-[11px] hover:bg-red-500/25 disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-left flex items-center gap-1.5 font-medium"
                    : isProceed
                      ? "px-3 py-1.5 rounded-full border border-green-500/50 bg-green-500/15 text-green-400 text-[11px] hover:bg-green-500/25 disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-left flex items-center gap-1.5 font-medium"
                      : isUpload
                        ? "px-2.5 py-1 rounded-full border-2 border-dashed border-cbv2-accent/50 bg-cbv2-accent/15 text-cbv2-accent text-[10px] hover:bg-cbv2-accent/25 hover:border-cbv2-accent disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-left flex items-center gap-1 font-medium"
                        : "px-2 py-1 rounded-full border border-cbv2-accent/30 bg-cbv2-accent/10 text-cbv2-accent text-[10px] hover:bg-cbv2-accent/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-left"
                  }
                  onClick={() => onSelectExample(example)}
                  disabled={isDisabled}
                  aria-busy={isDisabled}
                  title={isStart ? "Begin the modernization pipeline" : isRestart ? "Clear all selections and start over" : isUpload ? "Click to upload a document (.txt, .md, .pdf, .doc, .docx, .rtf, .csv, .json, .yaml, .yml, .xml, .html)" : `Use example: ${example}`}
                >
                  {isStart ? <><Rocket className="w-3.5 h-3.5" /> {label}</> : isRestart ? <><RotateCcw className="w-3 h-3" /> {label}</> : isStop ? <><XCircle className="w-3.5 h-3.5" /> {label}</> : isProceed ? <><CheckCircle2 className="w-3.5 h-3.5" /> {label}</> : isUpload ? <><Upload className="w-3 h-3" /> {label}</> : label}
                </button>
              );
            })}
          </div>
        ) : null}

        {proposal ? (
          <div className="mt-3 rounded-lg border border-cbv2-border bg-cbv2-bg/60 overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-cbv2-border bg-cbv2-input/40">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-cbv2-text">Pending Approval</div>
                <div className="text-[10px] text-cbv2-text-dim">{proposal.changedFiles.length} proposed file change{proposal.changedFiles.length === 1 ? "" : "s"}</div>
              </div>
              <div className="text-[10px] uppercase tracking-wide text-cbv2-text-dim">{proposal.status}</div>
            </div>
            <div className="max-h-[340px] overflow-y-auto cbv2-scrollbar divide-y divide-cbv2-border/70">
              {proposal.impactPlan.length > 0 ? (
                <div className="px-3 py-2 bg-cbv2-input/15">
                  <div className="text-[10px] font-semibold uppercase text-cbv2-text-dim mb-1">Application impact</div>
                  <ul className="space-y-1 text-[10px] text-cbv2-text-dim">
                    {proposal.impactPlan.slice(0, 8).map((item) => (
                      <li key={item} className="leading-relaxed">{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {proposal.changedFiles.length > 0 ? proposal.changedFiles.map((file) => {
                const pathParts = splitProposalPath(file.path);
                return (
                <details key={file.path} className="group px-3 py-2.5" open={proposal.changedFiles.length === 1}>
                  <summary className="cursor-pointer list-none space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-mono font-semibold text-cbv2-accent break-all leading-relaxed">{pathParts.fileName}</div>
                        {pathParts.directory ? (
                          <div className="mt-0.5 text-[10px] font-mono text-cbv2-text-dim break-all leading-relaxed">{pathParts.directory}</div>
                        ) : null}
                      </div>
                      <span className="shrink-0 rounded border border-cbv2-border bg-cbv2-input px-1.5 py-0.5 text-[9px] text-cbv2-text-dim">
                        {file.size ? `${file.size} chars` : "Preview"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      {file.reason ? <div className="text-[10px] text-cbv2-text-dim leading-relaxed">{file.reason}</div> : <div />}
                      <button
                        className="h-6 w-fit px-2 rounded-md border border-cbv2-accent/30 bg-cbv2-accent/10 text-[10px] font-medium text-cbv2-accent hover:bg-cbv2-accent/20 flex items-center gap-1"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onPreviewCodebaseChange?.(proposal.proposalId, file);
                        }}
                        title="Open side-by-side diff"
                      >
                        <GitCompareArrows className="w-3 h-3" />
                        View Diff
                      </button>
                    </div>
                  </summary>
                  {file.diffPreview ? (
                    <pre className="mt-2 max-h-[180px] overflow-auto rounded-md border border-cbv2-border bg-black/25 p-2 text-[10px] leading-relaxed text-cbv2-text-dim font-mono whitespace-pre-wrap cbv2-scrollbar">
                      {file.diffPreview}
                    </pre>
                  ) : (
                    <div className="mt-2 text-[10px] text-cbv2-text-dim">No textual diff preview was returned for this file.</div>
                  )}
                </details>
                );
              }) : (
                <div className="px-3 py-2 text-[10px] text-cbv2-text-dim">No file edits were proposed.</div>
              )}
            </div>
            {proposal.status === "pending" ? (
              <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-cbv2-border bg-cbv2-input/20">
                <button
                  className="h-7 px-2.5 rounded-md border border-red-500/40 bg-red-500/10 text-[10px] font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50 flex items-center gap-1.5"
                  onClick={() => onRejectCodebaseChange?.(proposal.proposalId)}
                  disabled={isProposalPending}
                >
                  <XCircle className="w-3 h-3" />
                  Reject
                </button>
                <button
                  className="h-7 px-2.5 rounded-md border border-green-500/50 bg-green-500/15 text-[10px] font-semibold text-green-300 hover:bg-green-500/25 disabled:opacity-50 flex items-center gap-1.5"
                  onClick={() => onApproveCodebaseChange?.(proposal.proposalId, proposal.changedFiles)}
                  disabled={isProposalPending || proposal.changedFiles.length === 0}
                >
                  {isProposalPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                  {isProposalPending ? "Applying..." : "Approve & Apply"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

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

export default function ModernizationPanel({
  messages,
  status,
  currentPhase,
  draft,
  summary,
  targetStack,
  onDraftChange,
  onStart,
  onSendChat,
  onApproveCodebaseChange,
  onRejectCodebaseChange,
  onPreviewCodebaseChange,
  onOpenHistory,
  onDownloadZip,
  onBackToProjects,
  onZipUploadSuccess,
  onGitPreviewLoaded,
  onPushSuccess,
  hasGeneratedCode,
  phaseProgress = { index: 0, total: 0 },
  phaseTimings = {},
  pipelineStartTime = null,
  analysisMetrics = null,
  generatingFiles = [],
  completedFiles = [],
  manifest = [],
  openQuestions = [],
  openQuestionsSuggested = [],
  openQuestionsStatus = "idle",
  onSubmitOpenQuestions,
  onSkipOpenQuestions,
}: ModernizationPanelProps) {
  type PendingAction =
    | "start-modernization"
    | "source-stack-confirm"
    | "source-stack-change"
    | "techstack-approve"
    | "techstack-change"
    | "roadmap-approve"
    | "roadmap-change"
    | `code-change-${string}`;
  const [input, setInput] = useState("");
  const [setupMessages, setSetupMessages] = useState<CBv2ChatMessage[]>([]);
  const { data: projects = [], isLoading: projectsLoading, error: projectsQueryError, refetch: loadProjects } = useLegacyModProjects();
  const projectsError = projectsQueryError ? (projectsQueryError as Error).message : null;
  const [sourceState, setSourceState] = useState<LegacySourceState | null>(null);

  // Fetch AI-powered suggestions once source is ready
  const { data: suggestions = null, isLoading: suggestionsLoadingState } = useLegacyModSuggestions(
    (draft.projectId && draft.projectId > 0) ? draft.projectId : null,
    Boolean(sourceState?.workspaceRoot && sourceState?.sourcePath),
    sourceState?.workspaceRoot ?? null,
    draft.targetStack,
  );
  const dynamicTargetStackExamples = suggestions?.target_stack_suggestions?.length
    ? [...suggestions.target_stack_suggestions, "Upload tech stack document"]
    : FALLBACK_TARGET_STACK_EXAMPLES;
  const dynamicGoalExamples = suggestions?.modernization_goal_suggestions?.length
    ? [...suggestions.modernization_goal_suggestions, "Upload goal document", "skip"]
    : FALLBACK_MODERNIZATION_GOAL_EXAMPLES;
  const [sourceInputMode, setSourceInputMode] = useState<"zip" | "git" | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [projectSearchTerm, setProjectSearchTerm] = useState("");
  const [uploadingZip, setUploadingZip] = useState(false);
  const [importingRepo, setImportingRepo] = useState(false);
  const [previewingRepo, setPreviewingRepo] = useState(false);
  const [gitPreviewApproved, setGitPreviewApproved] = useState(false);
  const [pushBranchName, setPushBranchName] = useState("");
  const [pushCommitMsg, setPushCommitMsg] = useState("");
  const [pushingCode, setPushingCode] = useState(false);
  const [pendingActions, setPendingActions] = useState<Partial<Record<PendingAction, boolean>>>({});
  const [startRequested, setStartRequested] = useState(false);
  const [pushResult, setPushResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [sourceStackChangeText, setSourceStackChangeText] = useState<string | null>(null);
  const [techstackChangeText, setTechstackChangeText] = useState<string | null>(null);
  const [roadmapChangeText, setRoadmapChangeText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const requirementsFileInputRef = useRef<HTMLInputElement>(null);
  const techStackDocInputRef = useRef<HTMLInputElement>(null);
  const repoUrlInputRef = useRef<HTMLInputElement>(null);
  const promptedProjectRef = useRef<number | null>(null);
  const promptedSourceRef = useRef<string>("");
  const promptedTargetRef = useRef<string>("");
  const promptedGoalRef = useRef<string>("");
  const awaitingGoalReplyRef = useRef(false);

  const addSetupMessage = useCallback(
    (role: CBv2ChatMessage["role"], content: string, eventType?: string) => {
      setSetupMessages((prev) => [
        ...prev,
        {
          id: `legacy-setup-${prev.length + 1}-${Date.now()}`,
          role,
          content,
          timestamp: Date.now(),
          eventType,
        },
      ]);
    },
    []
  );

  const isRestoredSession = typeof summary?.run_id === "string" && (summary.run_id as string).trim().length > 0;
  const hasWorkspace = isRestoredSession || (typeof summary?.workspace_root === "string" && summary.workspace_root.trim().length > 0);
  const displayMessages = hasWorkspace ? [...setupMessages, ...messages] : setupMessages;
  const usernameFirst = useSyncExternalStore(
    subscribeAuthSnapshot,
    getUsernameSnapshot,
    getServerUsernameSnapshot
  );
  const selectedProject =
    projects.find((project) => Number(project.project_id) === Number(draft.projectId)) ?? null;
  const hasSelectedSource = Boolean(sourceState?.workspaceRoot && sourceState?.sourcePath);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayMessages]);

  useEffect(() => {
    setSourceState(null);
    setSourceInputMode(null);
    promptedSourceRef.current = "";

    setRepoUrl("");
  }, [draft.projectId, projects]);

  useEffect(() => {
    if (hasWorkspace) return;
    if (!draft.projectId) {
      promptedProjectRef.current = null;
      promptedSourceRef.current = "";
      promptedTargetRef.current = "";
      promptedGoalRef.current = "";
      awaitingGoalReplyRef.current = false;
      if (setupMessages.length === 0) {
        addSetupMessage(
          "assistant",
          `Welcome ${usernameFirst}. This module can reverse engineer your legacy application, analyze its structure and dependencies, and then generate modernized code from that understanding.`,
          "setup_welcome"
        );
        return;
      }
      if (setupMessages.length === 1) {
        const eligibleProjects = projects.filter(
          (project) => project.modernization_eligible === true
        );
        addSetupMessage(
          "assistant",
          projectsLoading
            ? "Please select a project from the available list. I am loading the projects now."
            : eligibleProjects.length > 0
              ? `Please select a project from this list by replying with the project name or project ID: ${eligibleProjects
                  .slice(0, 8)
                  .map((project) => `${project.project_name} (${project.project_id})`)
                  .join(", ")}${eligibleProjects.length > 8 ? " ..." : ""}`
              : "Please select a project by replying with the project name or project ID.",
          "setup_project_prompt"
        );
      }
      return;
    }

    if (promptedProjectRef.current !== draft.projectId) {
      promptedProjectRef.current = draft.projectId;
      promptedSourceRef.current = "";
      promptedTargetRef.current = "";
      promptedGoalRef.current = "";
      awaitingGoalReplyRef.current = false;
      addSetupMessage(
        "assistant",
        selectedProject?.git_repo_url
          ? `Project ${selectedProject.project_name ?? draft.projectId} is selected. A Git repository is already configured for this project: **${selectedProject.git_repo_url}**. You can import it directly or upload a ZIP file.`
          : `Project ${selectedProject?.project_name ?? draft.projectId} is selected. Please provide the legacy codebase by uploading a ZIP file or importing from a Git repository (GitHub, GitLab, or Azure DevOps).`,
        "setup_source_prompt"
      );
      return;
    }

    if (hasSelectedSource && promptedSourceRef.current !== sourceState?.sourcePath) {
      promptedSourceRef.current = sourceState?.sourcePath ?? "";
      addSetupMessage(
        "assistant",
        `Legacy source is ready from ${sourceState?.sourceKind === "github_url" ? "GitHub" : "ZIP upload"}. What target stack should I modernize this application to?`,
        "setup_project_selected"
      );
      return;
    }

    if (draft.targetStack.trim() && promptedTargetRef.current !== draft.targetStack.trim()) {
      promptedTargetRef.current = draft.targetStack.trim();
      awaitingGoalReplyRef.current = true;
      addSetupMessage(
        "assistant",
        `Target stack noted: ${draft.targetStack.trim()}. Any modernization goals or constraints I should follow? You can describe them, upload a goal document, or reply "skip".`,
        "setup_target_stack"
      );
      return;
    }

    const goalKey = draft.modernizationGoal.trim() || "__empty__";
    if (
      !awaitingGoalReplyRef.current &&
      draft.targetStack.trim() &&
      promptedGoalRef.current !== goalKey &&
      promptedTargetRef.current === draft.targetStack.trim()
    ) {
      promptedGoalRef.current = goalKey;
      addSetupMessage(
        "assistant",
        draft.modernizationGoal.trim()
          ? `Got it. I have the project, target stack, and your goals. Reply "start" when you want me to begin reverse engineering, or send more constraints to refine the plan.`
          : `No extra constraints recorded. Reply "start" when you want me to begin reverse engineering, or send more guidance first.`,
        "setup_ready"
      );
      return;
    }
  }, [
    addSetupMessage,
    draft.modernizationGoal,
    draft.projectId,
    draft.targetStack,
    hasWorkspace,
    hasSelectedSource,
    projects,
    projectsLoading,
    selectedProject,
    sourceState?.sourceKind,
    sourceState?.sourcePath,
    setupMessages.length,
  ]);

  const handleZipUpload = useCallback(
    async (file: File) => {
      if (!draft.projectId || uploadingZip) return;
      setUploadingZip(true);
      try {
        const form = new FormData();
        form.append("repo_zip", file);
        form.append("project_id", String(draft.projectId));
        form.append(
          "project_name",
          selectedProject?.project_name
            ? String(selectedProject.project_name)
            : `project_${draft.projectId}`
        );
        const res = await authFetch(`${getLegacyModernizationApiRoot()}/api/legacy-modernization/upload-zip`, {
          method: "POST",
          body: form,
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          addSetupMessage(
            "assistant",
            `ZIP upload failed: ${String((payload as { error?: unknown }).error ?? res.statusText)}`,
            "setup_source_error"
          );
          return;
        }
        const nextState: LegacySourceState = {
          workspaceRoot: String((payload as { workspace_root?: unknown }).workspace_root ?? ""),
          sourcePath: String((payload as { source_path?: unknown }).source_path ?? ""),
          sourceKind: String((payload as { source_kind?: unknown }).source_kind ?? "zip_upload"),
          sourceBlobUrl:
            typeof (payload as { source_blob_url?: unknown }).source_blob_url === "string"
              ? String((payload as { source_blob_url?: unknown }).source_blob_url)
              : undefined,
        };
        setSourceState(nextState);
        addSetupMessage(
          "user",
          `Uploaded ZIP: ${file.name}`,
          "setup_source_upload"
        );
        // Refresh explorer data immediately using the uploaded workspace root
        onZipUploadSuccess?.(nextState.workspaceRoot);
      } catch (error) {
        addSetupMessage(
          "assistant",
          `ZIP upload failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "setup_source_error"
        );
      } finally {
        setUploadingZip(false);
        if (zipInputRef.current) {
          zipInputRef.current.value = "";
        }
      }
    },
    [addSetupMessage, draft.projectId, selectedProject?.project_name, uploadingZip, onZipUploadSuccess]
  );

  const handleGithubImport = useCallback(async (urlOverride?: string) => {
    const url = (urlOverride ?? repoUrl).trim();
    if (!draft.projectId || !url || importingRepo) return;
    setImportingRepo(true);
    addSetupMessage("user", url, "setup_source_github");
    try {
      // Auto-detect provider from the URL for backend credential handling
      let detectedProvider: string | undefined;
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes("gitlab")) {
        detectedProvider = "gitlab";
      } else if (lowerUrl.includes("dev.azure.com") || lowerUrl.includes("visualstudio.com")) {
        detectedProvider = "azure_devops";
      } else {
        detectedProvider = "github";
      }

      const res = await authFetch(`${getLegacyModernizationApiRoot()}/api/legacy-modernization/import-github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: draft.projectId,
          repo_url: url,
          project_name: selectedProject?.project_name ?? `project_${draft.projectId}`,
          provider: detectedProvider,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        addSetupMessage(
          "assistant",
          `Git import failed: ${String((payload as { error?: unknown }).error ?? res.statusText)}`,
          "setup_source_error"
        );
        return;
      }
      const nextState: LegacySourceState = {
        workspaceRoot: String((payload as { workspace_root?: unknown }).workspace_root ?? ""),
        sourcePath: String((payload as { source_path?: unknown }).source_path ?? ""),
        sourceKind: String((payload as { source_kind?: unknown }).source_kind ?? "git_clone"),
        sourceUrl:
          typeof (payload as { source_url?: unknown }).source_url === "string"
            ? String((payload as { source_url?: unknown }).source_url)
            : url,
      };
      setSourceState(nextState);
      addSetupMessage(
        "assistant",
        "Git repository imported successfully. Source is ready for modernization.",
        "setup_source_imported"
      );
      onZipUploadSuccess?.(nextState.workspaceRoot);
      setRepoUrl("");
    } catch (error) {
      addSetupMessage(
        "assistant",
        `Git import failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "setup_source_error"
      );
    } finally {
      setImportingRepo(false);
    }
  }, [addSetupMessage, draft.projectId, importingRepo, onZipUploadSuccess, repoUrl, selectedProject?.project_name]);

  const handleGitPreview = useCallback(async () => {
    if (!draft.projectId || !selectedProject?.git_repo_url || previewingRepo) return;
    setPreviewingRepo(true);
    try {
      const preview = await previewGitRepoFiles(draft.projectId);
      onGitPreviewLoaded?.({
        tree: (preview?.tree as Array<Record<string, unknown>>) ?? [],
        count: preview?.count || 0,
        provider: undefined,
        branch: preview?.branch,
      });
      setGitPreviewApproved(true);
    } catch {
      addSetupMessage("assistant", "Failed to preview repository files.", "setup_source_error");
    } finally {
      setPreviewingRepo(false);
    }
  }, [addSetupMessage, draft.projectId, selectedProject?.git_repo_url, previewingRepo, onGitPreviewLoaded]);

  const handlePushToRepo = useCallback(async () => {
    if (!draft.projectId || pushingCode) return;
    const branch = pushBranchName.trim();
    if (!branch) return;
    setPushingCode(true);
    setPushResult(null);
    try {
      const result = await gitPush(
        draft.projectId,
        branch,
        pushCommitMsg.trim() || `Modernized code generated by DevAccel`,
      );
      setPushResult({ type: "success", message: result.message || `Pushed to origin/${branch}` });
      onPushSuccess?.();
    } catch (err) {
      setPushResult({ type: "error", message: err instanceof Error ? err.message : "Push failed" });
    } finally {
      setPushingCode(false);
    }
  }, [draft.projectId, pushBranchName, pushCommitMsg, pushingCode, onPushSuccess]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    // Allow interaction when the pipeline is paused waiting for user decisions
    // on source stack, techstack, or roadmap — otherwise block while running.
    const isRunningNow = status === "running" || status === "connecting";
    const isPausedForDecision =
      isRunningNow &&
      ((
        Boolean(typeof summary?.source_stack === "string" && (summary.source_stack as string).trim()) &&
        typeof summary?.source_stack_status === "string" &&
        summary.source_stack_status !== "approved" &&
        summary.source_stack_status !== "idle"
      ) || (
        Boolean(typeof summary?.techstack === "string" && (summary.techstack as string).trim()) &&
        typeof summary?.techstack_status === "string" &&
        summary.techstack_status !== "approved" &&
        summary.techstack_status !== "idle"
      ) || (
        Boolean(typeof summary?.roadmap === "string" && (summary.roadmap as string).trim()) &&
        typeof summary?.roadmap_status === "string" &&
        summary.roadmap_status !== "approved" &&
        summary.roadmap_status !== "idle"
      ));
    if (isRunningNow && !isPausedForDecision) return;

    if (!hasWorkspace) {
      addSetupMessage("user", text, "setup_user");
      const normalized = text.toLowerCase().trim();

      if (!draft.projectId) {
        const eligibleProjects = projects.filter(
          (project) => project.modernization_eligible === true
        );
        const byId = eligibleProjects.find((project) => String(project.project_id) === normalized);
        const matches = byId
          ? [byId]
          : eligibleProjects.filter((project) =>
              String(project.project_name ?? "").toLowerCase().includes(normalized)
            );

        if (matches.length === 1) {
          onDraftChange({ projectId: Number(matches[0].project_id) });
        } else if (matches.length > 1) {
          addSetupMessage(
            "assistant",
            `I found multiple matches. Please reply with the exact project ID: ${matches
              .slice(0, 8)
              .map((project) => `${project.project_name} (${project.project_id})`)
              .join(", ")}`,
            "setup_project_ambiguous"
          );
        } else {
          addSetupMessage(
            "assistant",
            projectsLoading
              ? "I am still loading projects. Please try the project name or ID again in a moment."
              : "I could not match that to a project. Reply with the exact project name or project ID.",
            "setup_missing_project"
          );
        }
        setInput("");
        return;
      }

      if (!hasSelectedSource) {
        if (normalized.includes("upload")) {
          addSetupMessage(
            "assistant",
            "Please use the Upload ZIP option in the panel above.",
            "setup_source_help"
          );
        } else {
          addSetupMessage(
            "assistant",
            "Please provide the legacy source by uploading a ZIP file. If you need to use a Git repository, configure it in the project settings.",
            "setup_source_help"
          );
        }
        setInput("");
        return;
      }

      if (!draft.targetStack.trim()) {
        onDraftChange({ targetStack: text });
        setInput("");
        return;
      }

      if (normalized === "skip" && !draft.modernizationGoal.trim()) {
        awaitingGoalReplyRef.current = false;
        promptedGoalRef.current = "__empty__";
        addSetupMessage(
          "assistant",
          `No extra constraints recorded. Reply "start" when you want me to begin reverse engineering, or send more guidance first.`,
          "setup_ready"
        );
        setInput("");
        return;
      }

      if (normalized === "start") {
        onStart({
          project_id: draft.projectId,
          target_stack: draft.targetStack.trim(),
          modernization_goal: draft.modernizationGoal.trim() || undefined,
          workspace_root: sourceState?.workspaceRoot,
          source_path: sourceState?.sourcePath,
          source_kind: sourceState?.sourceKind,
          source_url: sourceState?.sourceUrl,
          source_blob_url: sourceState?.sourceBlobUrl,
        });
        setInput("");
        return;
      }

      if (!draft.modernizationGoal.trim()) {
        awaitingGoalReplyRef.current = false;
        onDraftChange({ modernizationGoal: normalized === "skip" ? "" : text });
        setInput("");
        return;
      }

      awaitingGoalReplyRef.current = false;
      onDraftChange({
        modernizationGoal: `${draft.modernizationGoal.trim()}\n${text}`.trim(),
      });
      setInput("");
      return;
    }

    if (!onSendChat) return;
    void onSendChat(text);
    setInput("");
  }, [
    addSetupMessage,
    draft.modernizationGoal,
    draft.projectId,
    draft.targetStack,
    hasWorkspace,
    hasSelectedSource,
    input,
    onDraftChange,
    onSendChat,
    onStart,
    handleGithubImport,
    projects,
    projectsLoading,
    sourceState,
    status,
    summary,
  ]);

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
  // Pipeline is paused waiting for user to confirm source stack, approve techstack, or approve roadmap — allow interaction
  const isPipelinePaused =
    isRunning &&
    ((
      typeof summary?.repository_validation_status === "string" &&
      summary.repository_validation_status === "pending"
    ) || (
      Boolean(typeof summary?.source_stack === "string" && (summary.source_stack as string).trim()) &&
      typeof summary?.source_stack_status === "string" &&
      summary.source_stack_status !== "approved" &&
      summary.source_stack_status !== "idle"
    ) || (
      Boolean(typeof summary?.techstack === "string" && (summary.techstack as string).trim()) &&
      typeof summary?.techstack_status === "string" &&
      summary.techstack_status !== "approved" &&
      summary.techstack_status !== "idle"
    ) || (
      Boolean(typeof summary?.roadmap === "string" && (summary.roadmap as string).trim()) &&
      typeof summary?.roadmap_status === "string" &&
      summary.roadmap_status !== "approved" &&
      summary.roadmap_status !== "idle"
    ));
  const isEffectivelyRunning = isRunning && !isPipelinePaused;
  const contextSummary = selectedProject?.project_name
    ? `${selectedProject.project_name} (${selectedProject.project_id})`
    : draft.projectId
      ? `Project ${draft.projectId}`
      : null;
  const techstackText = typeof summary?.techstack === "string" ? summary.techstack.trim() : "";
  const techstackStatus = typeof summary?.techstack_status === "string" ? String(summary.techstack_status) : "idle";
  const techstackNotes = typeof summary?.techstack_notes === "string" ? summary.techstack_notes.trim() : "";
  const techstackAwaitingDecision = Boolean(techstackText) && techstackStatus !== "approved" && techstackStatus !== "idle";
  const showTechstack = Boolean(techstackText) && techstackStatus !== "approved";

  const sourceStackText = typeof summary?.source_stack === "string" ? summary.source_stack.trim() : "";
  const sourceStackStatus = typeof summary?.source_stack_status === "string" ? String(summary.source_stack_status) : "idle";
  const sourceStackNotes = typeof summary?.source_stack_notes === "string" ? summary.source_stack_notes.trim() : "";
  const sourceStackAwaitingDecision = Boolean(sourceStackText) && sourceStackStatus !== "approved" && sourceStackStatus !== "idle";
  const showSourceStack = Boolean(sourceStackText) && sourceStackStatus !== "approved";

  const roadmapText = typeof summary?.roadmap === "string" ? summary.roadmap.trim() : "";
  const roadmapStatus = typeof summary?.roadmap_status === "string" ? String(summary.roadmap_status) : "idle";
  const roadmapNotes = typeof summary?.roadmap_notes === "string" ? summary.roadmap_notes.trim() : "";
  const roadmapAwaitingDecision = Boolean(roadmapText) && roadmapStatus !== "approved" && roadmapStatus !== "idle";
  const showRoadmap = Boolean(roadmapText) && roadmapStatus !== "approved";
  const isActionPending = useCallback(
    (action: PendingAction) => Boolean(pendingActions[action]),
    [pendingActions]
  );

  const runPendingAction = useCallback(
    async (action: PendingAction, work: () => Promise<void>) => {
      if (pendingActions[action]) return;
      setPendingActions((prev) => ({ ...prev, [action]: true }));
      try {
        await work();
      } finally {
        setPendingActions((prev) => {
          const next = { ...prev };
          delete next[action];
          return next;
        });
      }
    },
    [pendingActions]
  );

  useEffect(() => {
    if (status === "error") {
      setStartRequested(false);
    }
  }, [status]);

  // Markdown components for styled rendering inside approval modals
  const approvalMdComponents = {
    h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className="text-[13px] font-bold text-cbv2-text mt-3 mb-1.5 first:mt-0" {...props}>{children}</h1>,
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="text-[12px] font-bold text-cbv2-text mt-2.5 mb-1 first:mt-0" {...props}>{children}</h2>,
    h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="text-[11px] font-semibold text-cbv2-text mt-2 mb-1" {...props}>{children}</h3>,
    p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p className="text-[11px] leading-relaxed text-cbv2-text-dim mb-1.5 last:mb-0" {...props}>{children}</p>,
    ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => <ul className="text-[11px] leading-relaxed text-cbv2-text-dim ml-3 mb-1.5 list-disc" {...props}>{children}</ul>,
    ol: ({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) => <ol className="text-[11px] leading-relaxed text-cbv2-text-dim ml-3 mb-1.5 list-decimal" {...props}>{children}</ol>,
    li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => <li className="mb-0.5" {...props}>{children}</li>,
    strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => <strong className="font-semibold text-cbv2-text" {...props}>{children}</strong>,
    table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => <div className="overflow-x-auto mb-2"><table className="w-full text-[10px] border-collapse" {...props}>{children}</table></div>,
    thead: ({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className="bg-white/5" {...props}>{children}</thead>,
    th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => <th className="text-left px-2 py-1 border border-cbv2-border font-semibold text-cbv2-text" {...props}>{children}</th>,
    td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => <td className="px-2 py-1 border border-cbv2-border text-cbv2-text-dim" {...props}>{children}</td>,
    code: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => <code className="text-[10px] px-1 py-0.5 rounded bg-white/5 text-cbv2-accent font-mono" {...props}>{children}</code>,
    hr: (props: React.HTMLAttributes<HTMLHRElement>) => <hr className="border-cbv2-border my-2" {...props} />,
  };

  const submitChangeRequest = useCallback(
    async (action: PendingAction, value: string, reset: () => void) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      await runPendingAction(action, async () => {
        await onSendChat?.(trimmed);
        reset();
      });
    },
    [onSendChat, runPendingAction]
  );

  const showProjectDropdown = !hasWorkspace && !draft.projectId;

  // Compute setup step for stepper
  const setupStep = hasWorkspace
    ? 5
    : !draft.projectId
      ? 0
      : !hasSelectedSource
        ? 1
        : !draft.targetStack.trim()
          ? 2
          : promptedGoalRef.current === "" && awaitingGoalReplyRef.current
            ? 3
            : 4;

  return (
    <div className="h-full flex flex-col bg-cbv2-sidebar text-cbv2-text relative">
      {/* Header */}
      <div className="px-3 py-2 border-b border-cbv2-border flex items-center justify-between bg-gradient-to-r from-cbv2-sidebar to-cbv2-bg">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-cbv2-accent/15 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-cbv2-accent" />
          </div>
          <span className="text-[12px] font-sans font-semibold">
            Legacy Modernization
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 rounded-lg hover:bg-cbv2-hover text-cbv2-text-dim hover:text-white transition-colors"
            onClick={onOpenHistory}
            title="Pipeline History"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          {hasGeneratedCode ? (
            <button
              className="p-1.5 rounded-lg hover:bg-cbv2-hover text-cbv2-text-dim hover:text-cbv2-accent transition-colors"
              onClick={onDownloadZip}
              title="Download ZIP"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          ) : null}
          <div className="w-px h-4 bg-cbv2-border mx-0.5" />
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Setup Stepper — only during setup phase */}
      {!hasWorkspace && <SetupStepper currentStep={setupStep} />}

      {/* Context summary bar */}
      {contextSummary ? (
        <div className="px-3 py-1.5 bg-cbv2-accent/5 border-b border-cbv2-border flex items-center gap-2 text-[10px]">
          {onBackToProjects && !isRunning ? (
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-cbv2-text-dim hover:text-white hover:bg-white/10 transition-colors shrink-0 border border-cbv2-border"
              onClick={onBackToProjects}
              title="Back to project selection"
            >
              <ArrowLeft className="w-3 h-3" />
              <span>Change</span>
            </button>
          ) : null}
          <span className="px-2 py-0.5 rounded-full bg-cbv2-accent/15 text-cbv2-accent font-medium border border-cbv2-accent/20">
            reverse
          </span>
          <span className="text-cbv2-text truncate font-medium">{contextSummary}</span>
          {hasSelectedSource ? (
            <span className="text-green-400 ml-auto flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              {sourceState?.sourceKind === "github_url" ? "GitHub" : "ZIP"}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Always-mounted hidden file input for modernization goal document upload */}
      <input
        ref={requirementsFileInputRef}
        type="file"
        accept=".txt,.md,.pdf,.doc,.docx,.rtf,.csv,.json,.yaml,.yml,.xml,.html,.htm,.log"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            extractTextFromFile(file)
              .then((content) => {
                const trimmed = content.trim();
                if (trimmed) {
                  awaitingGoalReplyRef.current = false;
                  onDraftChange({ modernizationGoal: trimmed });
                  addSetupMessage("user", `Uploaded goal document: ${file.name}`, "setup_requirements_upload");
                } else {
                  addSetupMessage("assistant", "The uploaded file appears to be empty. Please try again with a file that contains your modernization goals.", "setup_requirements_error");
                }
              })
              .catch(() => {
                addSetupMessage("assistant", "Failed to read the file. Please try again or type your goals instead.", "setup_requirements_error");
              });
          }
          if (requirementsFileInputRef.current) {
            requirementsFileInputRef.current.value = "";
          }
        }}
      />

      {/* Always-mounted hidden file input for tech stack document upload */}
      <input
        ref={techStackDocInputRef}
        type="file"
        accept=".txt,.md,.pdf,.doc,.docx,.rtf,.csv,.json,.yaml,.yml,.xml,.html,.htm,.log"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            extractTextFromFile(file)
              .then((content) => {
                const trimmed = content.trim();
                if (trimmed) {
                  onDraftChange({ targetStack: trimmed });
                  addSetupMessage("user", `Uploaded tech stack document: ${file.name}`, "setup_techstack_upload");
                } else {
                  addSetupMessage("assistant", "The uploaded file appears to be empty. Please try again with a file that describes your target tech stack.", "setup_techstack_error");
                }
              })
              .catch(() => {
                addSetupMessage("assistant", "Failed to read the file. Please try again or type your target stack instead.", "setup_techstack_error");
              });
          }
          if (techStackDocInputRef.current) {
            techStackDocInputRef.current.value = "";
          }
        }}
      />

      {!hasWorkspace && !hasSelectedSource && draft.projectId ? (
        <div className="px-3 py-3 border-b border-cbv2-border bg-gradient-to-b from-cbv2-bg/80 to-cbv2-sidebar space-y-2.5">
          <div className="text-[10px] uppercase tracking-wider text-cbv2-text-dim font-semibold flex items-center gap-1.5">
            <FolderArchive className="w-3.5 h-3.5" />
            Provide Legacy Source
          </div>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleZipUpload(file);
              }
            }}
          />
          {/* Upload ZIP Card */}
          <button
            className={[
              "w-full flex flex-col items-center gap-2 p-3 rounded-lg border-2 border-dashed transition-all duration-200 disabled:opacity-50 group",
              sourceInputMode === "zip"
                ? "border-cbv2-accent bg-cbv2-accent/10"
                : "border-cbv2-border hover:border-cbv2-accent/50 hover:bg-cbv2-accent/5",
            ].join(" ")}
            onClick={() => {
              setSourceInputMode("zip");
              zipInputRef.current?.click();
            }}
            disabled={uploadingZip || importingRepo || isRunning}
          >
            <div className="w-9 h-9 rounded-lg bg-blue-500/15 flex items-center justify-center group-hover:bg-blue-500/25 transition-colors">
              {uploadingZip ? (
                <Loader2 className="w-4.5 h-4.5 text-blue-400 animate-spin" />
              ) : (
                <Upload className="w-4.5 h-4.5 text-blue-400" />
              )}
            </div>
            <div className="text-center">
              <div className="text-[11px] font-semibold text-cbv2-text">
                {uploadingZip ? "Uploading..." : "Upload ZIP"}
              </div>
              <div className="text-[9px] text-cbv2-text-dim mt-0.5">Drop or click to browse</div>
            </div>
          </button>

          {/* Pre-configured Git repo from project settings — preview & import */}
          {selectedProject?.git_repo_url ? (
            <div className="flex flex-col gap-2 p-2.5 rounded-lg border border-cbv2-border bg-cbv2-input/40 animate-fade-in">
              <div className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-purple-400 shrink-0" />
                <span className="flex-1 text-[11px] text-cbv2-text truncate" title={selectedProject.git_repo_url}>
                  {selectedProject.git_repo_url}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 rounded-lg bg-purple-600 text-white text-[11px] font-medium hover:bg-purple-500 transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                  onClick={() => { void handleGitPreview(); }}
                  disabled={uploadingZip || importingRepo || previewingRepo || isRunning}
                >
                  {previewingRepo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  {previewingRepo ? "Loading..." : "Preview Files"}
                </button>
                <button
                  className="px-3 py-1.5 rounded-lg bg-cbv2-accent text-white text-[11px] font-medium hover:bg-cbv2-accent/80 transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                  onClick={() => {
                    setGitPreviewApproved(false);
                    void handleGithubImport(selectedProject.git_repo_url!);
                  }}
                  disabled={uploadingZip || importingRepo || previewingRepo || isRunning || !gitPreviewApproved}
                  title={gitPreviewApproved ? "Approve preview and import into DevAccel" : "Preview files first, then approve import"}
                >
                  {importingRepo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  {importingRepo ? "Importing..." : "Approve & Import"}
                </button>
              </div>
              {!gitPreviewApproved && (
                <p className="text-[9px] text-cbv2-text-dim">
                  Step 1: Preview files. Step 2: Approve &amp; Import to ingest for modernization.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Pipeline Progress Bar — replaces the simple phase label */}
      {(isEffectivelyRunning || status === "complete" || status === "error") ? (
        <PipelineProgressBar
          currentPhase={currentPhase}
          status={status}
          phaseProgress={phaseProgress}
          phaseTimings={phaseTimings}
          pipelineStartTime={pipelineStartTime}
          generatingFiles={generatingFiles}
          completedFiles={completedFiles}
          manifest={manifest}
        />
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3 cbv2-scrollbar"
      >
        {/* Analysis Insights — collapsible, inside scroll area */}
        {analysisMetrics ? (
          <AnalysisInsights metrics={analysisMetrics} phaseTimings={phaseTimings} />
        ) : null}

        {/* File Generation Tracker — inside scroll area */}
        {manifest.length > 0 ? (
          <FileGenerationTracker
            manifest={manifest}
            generatingFiles={generatingFiles}
            completedFiles={completedFiles}
          />
        ) : null}

        {displayMessages.length === 0 && !analysisMetrics ? (
          <div className="flex flex-col items-center justify-center h-full text-cbv2-text-dim px-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cbv2-accent/20 to-purple-500/20 flex items-center justify-center mb-4 ring-1 ring-cbv2-accent/30">
              <Sparkles className="w-7 h-7 text-cbv2-accent" />
            </div>
            <h3 className="text-[14px] font-semibold text-cbv2-text mb-1.5">Legacy Modernization</h3>
            <p className="text-[11px] text-center text-cbv2-text-dim mb-5 max-w-[280px] leading-relaxed">
              Reverse engineer your legacy codebase, analyze architecture & dependencies, and generate modernized code.
            </p>
            <div className="w-full space-y-2 max-w-[280px]">
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-cbv2-input/50 border border-cbv2-border/50">
                <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0">
                  <Layers className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <div className="text-[11px] font-medium text-cbv2-text">Reverse Engineering</div>
                  <div className="text-[10px] text-cbv2-text-dim">Analyze structure & dependencies</div>
                </div>
              </div>
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-cbv2-input/50 border border-cbv2-border/50">
                <div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
                  <Code2 className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <div className="text-[11px] font-medium text-cbv2-text">Code Generation</div>
                  <div className="text-[10px] text-cbv2-text-dim">Produce modernized application code</div>
                </div>
              </div>
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-cbv2-input/50 border border-cbv2-border/50">
                <div className="w-8 h-8 rounded-lg bg-green-500/15 flex items-center justify-center shrink-0">
                  <GitBranch className="w-4 h-4 text-green-400" />
                </div>
                <div>
                  <div className="text-[11px] font-medium text-cbv2-text">Source Control</div>
                  <div className="text-[10px] text-cbv2-text-dim">Push results to Git repository</div>
                </div>
              </div>
            </div>
            <p className="text-[10px] text-cbv2-text-dim mt-4">
              {draft.projectId
                ? "Upload a ZIP file to continue."
                : "Select a project to begin the modernization workflow."}
            </p>
          </div>
        ) : (
          displayMessages.map((msg, idx) => {
            const currentPhaseLabel = getPhaseLabel(msg.eventType);
            const prevPhaseLabel = idx > 0 ? getPhaseLabel(displayMessages[idx - 1].eventType) : null;
            const showDivider = currentPhaseLabel && currentPhaseLabel !== prevPhaseLabel;
            return (
              <React.Fragment key={msg.id}>
                {showDivider && <PhaseDivider label={currentPhaseLabel} />}
            <MessageBubble
              key={msg.id}
              msg={msg}
              targetStackExamples={dynamicTargetStackExamples}
              modernizationGoalExamples={dynamicGoalExamples}
              suggestionsLoading={suggestionsLoadingState}
              disabledExamples={startRequested ? ["Start Modernization"] : []}
              pendingExampleLabels={startRequested ? { "Start Modernization": "Starting..." } : {}}
              pendingProposalIds={Object.keys(pendingActions)
                .filter((key) => key.startsWith("code-change-"))
                .map((key) => key.replace(/^code-change-/, ""))}
              onApproveCodebaseChange={(proposalId, changedFiles) => {
                void runPendingAction(`code-change-${proposalId}`, async () => {
                  await onApproveCodebaseChange?.(proposalId, changedFiles);
                });
              }}
              onRejectCodebaseChange={(proposalId) => onRejectCodebaseChange?.(proposalId)}
              onPreviewCodebaseChange={(proposalId, changedFile) => onPreviewCodebaseChange?.(proposalId, changedFile)}
              onSelectExample={(value) => {
                if (value === "Start Modernization") {
                  if (startRequested || isRunning) {
                    return;
                  }
                  setStartRequested(true);
                  onStart({
                    project_id: draft.projectId,
                    target_stack: draft.targetStack.trim(),
                    modernization_goal: draft.modernizationGoal.trim() || undefined,
                    workspace_root: sourceState?.workspaceRoot,
                    source_path: sourceState?.sourcePath,
                    source_kind: sourceState?.sourceKind,
                    source_url: sourceState?.sourceUrl,
                    source_blob_url: sourceState?.sourceBlobUrl,
                  });
                  return;
                }
                if (value === "Add more constraints") {
                  setInput("");
                  requestAnimationFrame(() => inputRef.current?.focus());
                  return;
                }
                if (value === "Restart Process") {
                  // Reset all setup state
                  setStartRequested(false);
                  onDraftChange({
                    projectId: 0,
                    targetStack: "",
                    modernizationGoal: "",
                  });
                  setSourceState(null);
                  setSourceInputMode(null);
                  setRepoUrl("");
                  setSetupMessages([]);
                  setInput("");
                  promptedProjectRef.current = null;
                  promptedSourceRef.current = "";
                  promptedTargetRef.current = "";
                  promptedGoalRef.current = "";
                  awaitingGoalReplyRef.current = false;
                  return;
                }
                if (value === "Upload ZIP") {
                  setSourceInputMode("zip");
                  zipInputRef.current?.click();
                  return;
                }
                if (value === "Upload goal document") {
                  requirementsFileInputRef.current?.click();
                  return;
                }
                if (value === "Upload tech stack document") {
                  techStackDocInputRef.current?.click();
                  return;
                }

                if (value === "Approve roadmap") {
                  void runPendingAction("roadmap-approve", async () => {
                    await onSendChat?.("approve");
                  });
                  return;
                }
                if (value === "Proceed anyway") {
                  void onSendChat?.("proceed anyway");
                  return;
                }
                if (value === "Stop pipeline") {
                  void onSendChat?.("stop pipeline");
                  return;
                }
                if (value === "Request changes") {
                  setInput("Revise the roadmap to ");
                  requestAnimationFrame(() => inputRef.current?.focus());
                  return;
                }
                setInput(value);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            />
                {msg.eventType === "open_questions" && onSubmitOpenQuestions && onSkipOpenQuestions && (() => {
                  const eventQuestions = Array.isArray(msg.data?.questions) ? (msg.data.questions as string[]) : [];
                  const eventSuggested = Array.isArray(msg.data?.suggested_answers) ? (msg.data.suggested_answers as string[]) : [];
                  const eventStage = typeof msg.data?.stage === "string" ? msg.data.stage : undefined;
                  if (eventQuestions.length === 0) return null;
                  return (
                    <OpenQuestionsCard
                      questions={eventQuestions}
                      suggestedAnswers={eventSuggested}
                      status={openQuestionsStatus}
                      onSubmit={onSubmitOpenQuestions}
                      onSkip={onSkipOpenQuestions}
                      stage={eventStage}
                    />
                  );
                })()}
              </React.Fragment>
            );
          })
        )}

        {showProjectDropdown ? (
          <div className="rounded-lg border border-cbv2-border bg-gradient-to-b from-cbv2-bg/80 to-cbv2-sidebar p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-cbv2-text-dim font-semibold flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                Select Project
              </span>
              {projectsLoading && <Loader2 className="w-3 h-3 animate-spin text-cbv2-accent" />}
            </div>
            {/* Search input */}
            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-cbv2-text-dim" />
              <input
                className="w-full pl-8 pr-3 py-1.5 bg-cbv2-input border border-cbv2-border rounded-lg text-[11px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent focus:ring-1 focus:ring-cbv2-accent/30 outline-none transition-all"
                placeholder="Search projects..."
                onChange={(e) => {
                  const term = e.target.value.toLowerCase();
                  setProjectSearchTerm(term);
                }}
                disabled={projectsLoading || isRunning}
              />
            </div>
            {/* Project cards list */}
            <div className="max-h-[200px] overflow-y-auto space-y-1 cbv2-scrollbar">
              {projectsError ? (
                <div className="px-3 py-2 text-[11px] text-red-400 bg-red-500/10 rounded-lg border border-red-500/20">
                  {projectsError}
                </div>
              ) : !projectsLoading && projects.length === 0 ? (
                <div className="px-3 py-4 text-[11px] text-cbv2-text-dim text-center">
                  No projects available.
                </div>
              ) : (
                projects
                  .filter((project) => {
                    if (!projectSearchTerm) return true;
                    return (
                      String(project.project_name ?? "").toLowerCase().includes(projectSearchTerm) ||
                      String(project.project_id).includes(projectSearchTerm)
                    );
                  })
                  .map((project) => {
                    const isEligible = project.modernization_eligible === true;
                    const eligibilityLabel = getProjectEligibilityLabel(project);
                    return (
                      <button
                        key={String(project.project_id)}
                        className={[
                          "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all duration-150",
                          isEligible
                            ? "border-cbv2-border/50 hover:border-cbv2-accent/40 hover:bg-cbv2-accent/5 cbv2-interactive cursor-pointer"
                            : "border-cbv2-border/30 opacity-50 cursor-not-allowed",
                        ].join(" ")}
                        onClick={() => {
                          if (!isEligible) return;
                          const selectedId = Number(project.project_id);
                          addSetupMessage(
                            "user",
                            project.project_name
                              ? `Selected project: ${project.project_name} (${selectedId})`
                              : `Selected project ID ${selectedId}`,
                            "setup_project_dropdown"
                          );
                          onDraftChange({ projectId: selectedId });
                        }}
                        disabled={!isEligible || projectsLoading || isRunning}
                      >
                        <div className={[
                          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-[11px] font-bold",
                          isEligible ? "bg-cbv2-accent/15 text-cbv2-accent" : "bg-cbv2-input text-cbv2-text-dim",
                        ].join(" ")}>
                          {String(project.project_name ?? "P").charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-medium text-cbv2-text truncate">
                            {String(project.project_name ?? `Project ${project.project_id}`)}
                          </div>
                          <div className="text-[10px] text-cbv2-text-dim flex items-center gap-1.5">
                            <span>ID {project.project_id}</span>
                            <span className="text-cbv2-border">·</span>
                            <span className={isEligible ? "text-green-400" : "text-amber-400"}>
                              {eligibilityLabel}
                            </span>
                          </div>
                        </div>
                        {isEligible && (
                          <ArrowRight className="w-3.5 h-3.5 text-cbv2-text-dim shrink-0" />
                        )}
                      </button>
                    );
                  })
              )}
            </div>
          </div>
        ) : null}

        {isEffectivelyRunning ? (
          <div className="flex items-center gap-2.5 text-cbv2-accent text-[11px] pl-8 py-1">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cbv2-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cbv2-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cbv2-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="font-medium">Agent is working...</span>
          </div>
        ) : null}
      </div>

      {/* Push to Git — visible after code generation when project has a git repo */}
      {hasGeneratedCode && selectedProject?.git_repo_url ? (
        <div className="border-t border-cbv2-border px-3 py-2.5 bg-cbv2-sidebar/80 space-y-2 animate-fade-in">
          <div className="flex items-center gap-2 text-[10px] text-cbv2-text-dim uppercase tracking-wider font-semibold">
            <ArrowUp className="w-3.5 h-3.5" />
            Push to Repository
          </div>
          <div className="flex items-center gap-2 text-[10px] text-cbv2-text-dim">
            <GitBranch className="w-3 h-3 text-purple-400 shrink-0" />
            <span className="truncate" title={selectedProject.git_repo_url}>{selectedProject.git_repo_url}</span>
          </div>
          <input
            type="text"
            className="w-full px-2.5 py-1.5 bg-cbv2-input border border-cbv2-border rounded-lg text-[11px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent focus:ring-1 focus:ring-cbv2-accent/30 outline-none transition-all"
            placeholder="feature/modernized-code"
            value={pushBranchName}
            onChange={(e) => setPushBranchName(e.target.value)}
            disabled={pushingCode}
          />
          <input
            type="text"
            className="w-full px-2.5 py-1.5 bg-cbv2-input border border-cbv2-border rounded-lg text-[11px] text-cbv2-text placeholder-cbv2-text-dim focus:border-cbv2-accent focus:ring-1 focus:ring-cbv2-accent/30 outline-none transition-all"
            placeholder="Commit message (optional)"
            value={pushCommitMsg}
            onChange={(e) => setPushCommitMsg(e.target.value)}
            disabled={pushingCode}
          />
          <button
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 text-white text-[11px] font-medium hover:bg-green-500 transition-colors disabled:opacity-50"
            onClick={() => { void handlePushToRepo(); }}
            disabled={pushingCode || !pushBranchName.trim()}
            title={pushBranchName.trim() ? `Push as feature branch origin/${pushBranchName.trim()}` : "Enter a feature branch name first"}
          >
            {pushingCode ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUp className="w-3.5 h-3.5" />}
            {pushingCode ? "Pushing..." : "Push as Feature Branch"}
          </button>
          {pushResult ? (
            <div className={`text-[10px] px-2.5 py-1.5 rounded-lg border ${pushResult.type === "success" ? "text-green-400 bg-green-500/10 border-green-500/20" : "text-red-400 bg-red-500/10 border-red-500/20"}`}>
              {pushResult.message}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Input area */}
      <div className="border-t border-cbv2-border p-3 bg-cbv2-sidebar">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              className="w-full px-3 py-2 bg-cbv2-input border border-cbv2-border rounded-lg text-[12px] text-cbv2-text placeholder-cbv2-text-dim resize-none focus:border-cbv2-accent focus:ring-1 focus:ring-cbv2-accent/30 outline-none min-h-[40px] max-h-[120px] transition-all"
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isEffectivelyRunning
                  ? "Generation in progress..."
                  : !draft.projectId
                    ? "Select a project above or type a project name or ID..."
                    : !hasSelectedSource
                      ? "Upload a ZIP or ask for help..."
                      : summary?.repository_validation_status === "pending"
                        ? "Proceed anyway or stop the pipeline..."
                      : sourceStackAwaitingDecision
                        ? "Confirm the detected source stack or suggest corrections..."
                      : techstackAwaitingDecision
                        ? "Approve the tech stack or request changes..."
                      : roadmapAwaitingDecision
                        ? "Approve the roadmap or request changes..."
                    : "Ask about the repo, artifacts, or next generation step..."
              }
              disabled={isEffectivelyRunning}
            />
          </div>
          <div className="flex flex-col gap-1">
            <button
              className={[
                "p-2.5 rounded-lg transition-all duration-200",
                isEffectivelyRunning
                  ? "bg-cbv2-input text-cbv2-text-dim cursor-not-allowed"
                  : input.trim()
                    ? "bg-cbv2-accent text-white hover:bg-cbv2-accent/80 shadow-md shadow-cbv2-accent/20"
                    : "bg-cbv2-input text-cbv2-text-dim hover:text-cbv2-text",
              ].join(" ")}
              onClick={handleSend}
              disabled={isEffectivelyRunning || !input.trim()}
              title="Send (Enter)"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10px] text-cbv2-text-dim">
            <kbd className="px-1 py-0.5 rounded bg-cbv2-input text-[9px] font-mono">Shift+Enter</kbd> newline &middot; <kbd className="px-1 py-0.5 rounded bg-cbv2-input text-[9px] font-mono">Enter</kbd> send
          </span>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════
          APPROVAL MODAL OVERLAYS — centered over the panel
          ════════════════════════════════════════════════════════════════ */}

      {/* ── Source Stack Approval Modal ── */}
      {showSourceStack ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[92%] max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-cyan-500/30 bg-cbv2-sidebar shadow-2xl shadow-cyan-900/20 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-cbv2-border bg-gradient-to-r from-cyan-500/10 to-transparent">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/25 shrink-0">
                <Search className="w-5 h-5 text-cyan-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-cyan-400/80 uppercase tracking-widest">Step 1 of 3</span>
                </div>
                <h2 className="text-[15px] font-bold text-cbv2-text mt-0.5">Detected Source Tech Stack</h2>
                <p className="text-[11px] text-cbv2-text-dim mt-0.5">Review the technologies detected in your legacy codebase. Confirm if correct, or suggest corrections.</p>
              </div>
              <span className={[
                "text-[11px] px-3 py-1.5 rounded-full font-semibold shrink-0",
                sourceStackStatus === "approved"
                  ? "bg-green-500/15 text-green-400 border border-green-500/25"
                  : sourceStackStatus === "revising"
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                    : sourceStackStatus === "blocked"
                      ? "bg-red-500/15 text-red-400 border border-red-500/25"
                      : "bg-cyan-500/15 text-cyan-400 border border-cyan-500/25",
              ].join(" ")}>
                {sourceStackStatus === "approved"
                  ? "\u2713 Confirmed"
                  : sourceStackStatus === "revising"
                    ? "Revising\u2026"
                    : sourceStackStatus === "blocked"
                      ? "Blocked"
                      : "Awaiting Review"}
              </span>
            </div>

            {/* Scrollable markdown content */}
            <div className="flex-1 overflow-y-auto px-5 py-4 cbv2-scrollbar">
              <div className="prose-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={approvalMdComponents}>
                  {sourceStackText}
                </ReactMarkdown>
              </div>
            </div>

            {/* Footer with notes + actions */}
            <div className="px-5 py-4 border-t border-cbv2-border bg-cbv2-bg/40">
              {sourceStackNotes ? (
                <div className="mb-3 text-[11px] text-red-400 flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{sourceStackNotes}</span>
                </div>
              ) : null}

              {sourceStackAwaitingDecision ? (
                <div className="space-y-3">
                  {sourceStackChangeText !== null ? (
                    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-3 space-y-2">
                      <label className="block text-[11px] font-semibold text-cyan-300">What should be corrected in the detected source stack?</label>
                      <textarea
                        className="w-full min-h-[88px] rounded-lg border border-cbv2-border bg-cbv2-input px-3 py-2 text-[12px] text-cbv2-text placeholder-cbv2-text-dim outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 resize-y"
                        value={sourceStackChangeText}
                        onChange={(event) => setSourceStackChangeText(event.target.value)}
                        placeholder="Example: The source stack should include COBOL, JCL, DB2, CICS, and VSAM. Remove Java because this repo is mainframe only."
                        autoFocus
                      />
                      <div className="flex gap-2 justify-end">
                        <button className="px-3 py-2 rounded-lg border border-cbv2-border text-[12px] text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => setSourceStackChangeText(null)}>Cancel</button>
                        <button className="px-4 py-2 rounded-lg bg-cyan-600 text-white text-[12px] font-semibold hover:bg-cyan-500 disabled:opacity-50 transition-colors" disabled={!sourceStackChangeText.trim() || isEffectivelyRunning || isActionPending("source-stack-change")} onClick={() => void submitChangeRequest("source-stack-change", sourceStackChangeText, () => setSourceStackChangeText(null))}>{isActionPending("source-stack-change") ? "Submitting..." : "Submit Corrections"}</button>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex gap-3">
                    <button
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-green-600 to-green-500 text-white text-[13px] font-semibold hover:from-green-500 hover:to-green-400 disabled:opacity-50 transition-all shadow-lg shadow-green-900/25"
                      onClick={() => void runPendingAction("source-stack-confirm", async () => {
                        await onSendChat?.("confirm source stack");
                      })}
                      disabled={isEffectivelyRunning || isActionPending("source-stack-confirm")}
                      aria-busy={isActionPending("source-stack-confirm")}
                    >
                      <CheckCircle2 className="w-5 h-5" />
                      {isActionPending("source-stack-confirm") ? "Confirming..." : "Confirm Source Stack"}
                    </button>
                    <button
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-cbv2-border bg-cbv2-input text-[13px] font-medium text-cbv2-text hover:bg-cbv2-hover hover:border-cyan-500/40 disabled:opacity-50 transition-all"
                      onClick={() => setSourceStackChangeText("The source stack should include ")}
                      disabled={isEffectivelyRunning}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Suggest Corrections
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Tech Stack Recommendation Approval Modal ── */}
      {showTechstack ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[92%] max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-purple-500/30 bg-cbv2-sidebar shadow-2xl shadow-purple-900/20 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-cbv2-border bg-gradient-to-r from-purple-500/10 to-transparent">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/25 shrink-0">
                <Target className="w-5 h-5 text-purple-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-purple-400/80 uppercase tracking-widest">Step 2 of 3</span>
                </div>
                <h2 className="text-[15px] font-bold text-cbv2-text mt-0.5">Target Tech Stack Recommendation</h2>
                <p className="text-[11px] text-cbv2-text-dim mt-0.5">Review the recommended target technologies for modernization. Approve or request changes.</p>
              </div>
              <span className={[
                "text-[11px] px-3 py-1.5 rounded-full font-semibold shrink-0",
                techstackStatus === "approved"
                  ? "bg-green-500/15 text-green-400 border border-green-500/25"
                  : techstackStatus === "revising"
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                    : techstackStatus === "blocked"
                      ? "bg-red-500/15 text-red-400 border border-red-500/25"
                      : "bg-purple-500/15 text-purple-400 border border-purple-500/25",
              ].join(" ")}>
                {techstackStatus === "approved"
                  ? "\u2713 Approved"
                  : techstackStatus === "revising"
                    ? "Revising\u2026"
                    : techstackStatus === "blocked"
                      ? "Blocked"
                      : "Awaiting Review"}
              </span>
            </div>

            {/* Scrollable markdown content */}
            <div className="flex-1 overflow-y-auto px-5 py-4 cbv2-scrollbar">
              <div className="prose-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={approvalMdComponents}>
                  {techstackText}
                </ReactMarkdown>
              </div>
            </div>

            {/* Footer with notes + actions */}
            <div className="px-5 py-4 border-t border-cbv2-border bg-cbv2-bg/40">
              {techstackNotes ? (
                <div className="mb-3 text-[11px] text-red-400 flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{techstackNotes}</span>
                </div>
              ) : null}

              {techstackAwaitingDecision ? (
                <div className="space-y-3">
                  {techstackChangeText !== null ? (
                    <div className="rounded-xl border border-purple-500/25 bg-purple-500/5 p-3 space-y-2">
                      <label className="block text-[11px] font-semibold text-purple-300">What should change in the target tech stack?</label>
                      <textarea
                        className="w-full min-h-[88px] rounded-lg border border-cbv2-border bg-cbv2-input px-3 py-2 text-[12px] text-cbv2-text placeholder-cbv2-text-dim outline-none focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30 resize-y"
                        value={techstackChangeText}
                        onChange={(event) => setTechstackChangeText(event.target.value)}
                        placeholder="Example: Change the tech stack to Java Spring Boot APIs, React UI, PostgreSQL, Docker, and Azure DevOps CI/CD."
                        autoFocus
                      />
                      <div className="flex gap-2 justify-end">
                        <button className="px-3 py-2 rounded-lg border border-cbv2-border text-[12px] text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => setTechstackChangeText(null)}>Cancel</button>
                        <button className="px-4 py-2 rounded-lg bg-purple-600 text-white text-[12px] font-semibold hover:bg-purple-500 disabled:opacity-50 transition-colors" disabled={!techstackChangeText.trim() || isEffectivelyRunning || isActionPending("techstack-change")} onClick={() => void submitChangeRequest("techstack-change", techstackChangeText, () => setTechstackChangeText(null))}>{isActionPending("techstack-change") ? "Submitting..." : "Submit Changes"}</button>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex gap-3">
                    <button
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-green-600 to-green-500 text-white text-[13px] font-semibold hover:from-green-500 hover:to-green-400 disabled:opacity-50 transition-all shadow-lg shadow-green-900/25"
                      onClick={() => void runPendingAction("techstack-approve", async () => {
                        await onSendChat?.("approve techstack");
                      })}
                      disabled={isEffectivelyRunning || isActionPending("techstack-approve")}
                      aria-busy={isActionPending("techstack-approve")}
                    >
                      <CheckCircle2 className="w-5 h-5" />
                      {isActionPending("techstack-approve") ? "Approving..." : "Approve Stack"}
                    </button>
                    <button
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-cbv2-border bg-cbv2-input text-[13px] font-medium text-cbv2-text hover:bg-cbv2-hover hover:border-purple-500/40 disabled:opacity-50 transition-all"
                      onClick={() => setTechstackChangeText("Change the tech stack to ")}
                      disabled={isEffectivelyRunning}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Request Changes
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Modernization Roadmap Approval Modal ── */}
      {showRoadmap ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[92%] max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-amber-500/30 bg-cbv2-sidebar shadow-2xl shadow-amber-900/20 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-cbv2-border bg-gradient-to-r from-amber-500/10 to-transparent">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/25 shrink-0">
                <MapPin className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-amber-400/80 uppercase tracking-widest">Step 3 of 3</span>
                </div>
                <h2 className="text-[15px] font-bold text-cbv2-text mt-0.5">Modernization Roadmap</h2>
                <p className="text-[11px] text-cbv2-text-dim mt-0.5">Review the implementation blueprint and exact planned file list. Approving will lock that plan and enable code generation.</p>
              </div>
              <span className={[
                "text-[11px] px-3 py-1.5 rounded-full font-semibold shrink-0",
                roadmapStatus === "approved"
                  ? "bg-green-500/15 text-green-400 border border-green-500/25"
                  : roadmapStatus === "revising"
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                    : roadmapStatus === "blocked"
                      ? "bg-red-500/15 text-red-400 border border-red-500/25"
                      : "bg-amber-500/15 text-amber-400 border border-amber-500/25",
              ].join(" ")}>
                {roadmapStatus === "approved"
                  ? "\u2713 Approved"
                  : roadmapStatus === "revising"
                    ? "Revising\u2026"
                    : roadmapStatus === "blocked"
                      ? "Blocked"
                      : "Awaiting Review"}
              </span>
            </div>

            {/* Scrollable markdown content */}
            <div className="flex-1 overflow-y-auto px-5 py-4 cbv2-scrollbar">
              <div className="prose-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={approvalMdComponents}>
                  {roadmapText}
                </ReactMarkdown>
              </div>
            </div>

            {/* Footer with notes + actions */}
            <div className="px-5 py-4 border-t border-cbv2-border bg-cbv2-bg/40">
              {roadmapNotes ? (
                <div className="mb-3 text-[11px] text-red-400 flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{roadmapNotes}</span>
                </div>
              ) : null}

              {roadmapAwaitingDecision ? (
                <div className="space-y-3">
                  {roadmapChangeText !== null ? (
                    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 space-y-2">
                      <label className="block text-[11px] font-semibold text-amber-300">What should change in the modernization roadmap or planned file list?</label>
                      <textarea
                        className="w-full min-h-[88px] rounded-lg border border-cbv2-border bg-cbv2-input px-3 py-2 text-[12px] text-cbv2-text placeholder-cbv2-text-dim outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/30 resize-y"
                        value={roadmapChangeText}
                        onChange={(event) => setRoadmapChangeText(event.target.value)}
                        placeholder="Example: Revise the roadmap to prioritize database migration first, add a strangler pattern phase, rename backend/app/main.py to backend/app/server.py, and add docs/api-contract.md."
                        autoFocus
                      />
                      <div className="flex gap-2 justify-end">
                        <button className="px-3 py-2 rounded-lg border border-cbv2-border text-[12px] text-cbv2-text-dim hover:text-cbv2-text hover:bg-cbv2-hover transition-colors" onClick={() => setRoadmapChangeText(null)}>Cancel</button>
                        <button className="px-4 py-2 rounded-lg bg-amber-600 text-white text-[12px] font-semibold hover:bg-amber-500 disabled:opacity-50 transition-colors" disabled={!roadmapChangeText.trim() || isEffectivelyRunning || isActionPending("roadmap-change")} onClick={() => void submitChangeRequest("roadmap-change", roadmapChangeText, () => setRoadmapChangeText(null))}>{isActionPending("roadmap-change") ? "Submitting..." : "Submit Changes"}</button>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex gap-3">
                    <button
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-green-600 to-green-500 text-white text-[13px] font-semibold hover:from-green-500 hover:to-green-400 disabled:opacity-50 transition-all shadow-lg shadow-green-900/25"
                      onClick={() => void runPendingAction("roadmap-approve", async () => {
                        await onSendChat?.("approve");
                      })}
                      disabled={isEffectivelyRunning || isActionPending("roadmap-approve")}
                      aria-busy={isActionPending("roadmap-approve")}
                    >
                      <CheckCircle2 className="w-5 h-5" />
                      {isActionPending("roadmap-approve") ? "Approving..." : "Approve Roadmap"}
                    </button>
                    <button
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-cbv2-border bg-cbv2-input text-[13px] font-medium text-cbv2-text hover:bg-cbv2-hover hover:border-amber-500/40 disabled:opacity-50 transition-all"
                      onClick={() => setRoadmapChangeText("Revise the roadmap to ")}
                      disabled={isEffectivelyRunning}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Request Changes
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
