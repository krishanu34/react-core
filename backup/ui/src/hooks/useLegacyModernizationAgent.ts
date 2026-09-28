"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CBv2ChatMessage,
  CBv2FileNode,
  CBv2GenerationStatus,
} from "@/types/code-builder-v2";
import queryKeys from "@/lib/query-keys";
import {
  getLegacyModernizationApiRoot,
  getLegacyModernizationSseUrl,
} from "@/lib/legacy-modernization-url";
import type {
  LegacyModernizationAgent,
  LegacyCodebaseChangeFile,
  LegacyModernizationCodegenRequest,
  LegacyModernizationEvent,
  LegacyModernizationStartRequest,
} from "@/types/legacy-modernization";

const API_BASE = "/lm-api";

type RoadmapStatus =
  | "idle"
  | "generating"
  | "ready"
  | "revising"
  | "approved"
  | "blocked";

type RoadmapContext = {
  project_id?: number;
  workspace_root: string;
  target_stack: string;
  modernization_goal?: string;
};

type ResetStateOptions = {
  preserveExplorer?: boolean;
};

function isApprovalCommand(value: string) {
  const normalized = value.trim().toLowerCase();
  return [
    "approve",
    "approve roadmap",
    "approved",
    "start",
    "proceed",
    "proceed with roadmap",
    "go ahead",
    "yes",
    "y",
  ].includes(normalized);
}

function isRoadmapRevisionRequest(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("revise") ||
    normalized.startsWith("change") ||
    normalized.startsWith("update") ||
    normalized.startsWith("modify") ||
    normalized.startsWith("adjust") ||
    normalized.startsWith("please change") ||
    normalized.startsWith("please revise")
  );
}

function isGeneratedCodeChangeRequest(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(what|why|how|where|when|who|explain|show|list|summarize|describe)\b/.test(normalized)) {
    return false;
  }
  if (/\b(roadmap|source stack|tech stack|analysis report|tracker|document)\b/.test(normalized)) {
    return false;
  }
  return /\b(refactor|change|modify|update|fix|rename|replace|remove|add|implement|apply|convert|extract|move|standardize|restructure|optimi[sz]e)\b/.test(normalized);
}

let msgId = 0;
function makeId() {
  msgId += 1;
  return `legacy-msg-${msgId}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// SSE run persistence: lets us reconnect to an in-flight legacy modernization
// or code-generation SSE stream after a browser refresh.  The backend keeps
// the run alive (detached asyncio task + in-memory event log) and supports
// resume via the `last_id` query param on /sse/events/{run_id}.
// ---------------------------------------------------------------------------
type PersistedSseKind = "reverse" | "codegen";
type PersistedSseRun = {
  runId: string;
  kind: PersistedSseKind;
  projectId?: number;
  workspaceRoot?: string;
  targetStack?: string;
  modernizationGoal?: string;
  lastEventId: number;
  startedAt: number;
};

const SSE_PERSIST_KEY = "legacy.modernization.activeSse";

function loadPersistedSseRun(): PersistedSseRun | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SSE_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSseRun;
    if (!parsed || typeof parsed.runId !== "string" || !parsed.runId) return null;
    if (parsed.kind !== "reverse" && parsed.kind !== "codegen") return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersistedSseRun(state: PersistedSseRun): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SSE_PERSIST_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage may be unavailable (e.g. quota / privacy mode); ignore.
  }
}

function clearPersistedSseRun(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SSE_PERSIST_KEY);
  } catch {
    // Ignore.
  }
}

function updatePersistedLastEventId(runId: string, lastEventId: number): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(SSE_PERSIST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedSseRun;
    if (!parsed || parsed.runId !== runId) return;
    if (!Number.isFinite(lastEventId)) return;
    if (lastEventId <= parsed.lastEventId) return;
    parsed.lastEventId = lastEventId;
    window.sessionStorage.setItem(SSE_PERSIST_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore.
  }
}

async function fetchFromModernizationApi(
  path: string,
  init?: RequestInit
): Promise<Response> {
  let lastError: Error | null = null;
  // DIRECT_API_BASE points to the FastAPI server root (not including `/api`),
  // while API_BASE is proxied by Next.js rewrites and already maps to `/api/*`.
  const candidates = [`${getLegacyModernizationApiRoot()}/api${path}`, `${API_BASE}${path}`];

  for (const url of candidates) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 404 || url === candidates[candidates.length - 1]) {
        return response;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Request failed");
    }
  }

  throw lastError ?? new Error("Request failed");
}

export function useLegacyModernizationAgent(): LegacyModernizationAgent {
  const qc = useQueryClient();
  const [status, setStatus] = useState<CBv2GenerationStatus>("idle");
  const [messages, setMessages] = useState<CBv2ChatMessage[]>([]);
  const [fileTree, setFileTree] = useState<CBv2FileNode[]>([]);
  const [fileCount, setFileCount] = useState(0);
  const [currentPhase, setCurrentPhase] = useState("");
  const [generatingFiles, setGeneratingFiles] = useState<string[]>([]);
  const [completedFiles, setCompletedFiles] = useState<string[]>([]);
  const [manifest, setManifest] = useState<
    Array<{ path: string; description: string }>
  >([]);
  const [summaryState, setSummary] = useState<Record<string, unknown> | null>(null);
  const [roadmap, setRoadmap] = useState("");
  const [roadmapStatus, setRoadmapStatus] = useState<RoadmapStatus>("idle");
  const [roadmapNotes, setRoadmapNotes] = useState("");
  const [techstack, setTechstack] = useState("");
  const [techstackStatus, setTechstackStatus] = useState<RoadmapStatus>("idle");
  const [techstackNotes, setTechstackNotes] = useState("");
  const [sourceStack, setSourceStack] = useState("");
  const [sourceStackStatus, setSourceStackStatus] = useState<RoadmapStatus>("idle");
  const [sourceStackNotes, setSourceStackNotes] = useState("");
  // Open questions state
  const [openQuestions, setOpenQuestions] = useState<string[]>([]);
  const [openQuestionsSuggested, setOpenQuestionsSuggested] = useState<string[]>([]);
  const [openQuestionsStatus, setOpenQuestionsStatus] = useState<"idle" | "pending" | "answered">("idle");
  // Progress & timing state
  const [phaseProgress, setPhaseProgress] = useState<{ index: number; total: number }>({ index: 0, total: 0 });
  const [phaseTimings, setPhaseTimings] = useState<Record<string, number>>({});
  const [pipelineStartTime, setPipelineStartTime] = useState<number | null>(null);
  // Analysis insights state
  const [analysisMetrics, setAnalysisMetrics] = useState<{
    totalFiles: number;
    sourceFiles: number;
    primaryLanguage: string;
    languageCounts: Record<string, number>;
    importantFilesCount: number;
    excludedFiles: number;
    analysisMode: string;
  } | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const workspaceRootRef = useRef<string>("");
  const historyRunIdRef = useRef<string>("");
  const seenDoneRef = useRef(false);
  const hadTerminalErrorRef = useRef(false);
  const pipelineStoppedRef = useRef(false);
  const runKindRef = useRef<"" | "reverse" | "codegen">("");
  const requestedProjectIdRef = useRef<number | null>(null);
  const requestedTargetStackRef = useRef<string>("");
  const requestedModernizationGoalRef = useRef<string>("");
  const approvedRoadmapRef = useRef<string>("");
  const roadmapContextRef = useRef<RoadmapContext | null>(null);
  const reverseEngineeringCompletedRef = useRef<
    | RoadmapContext
    | null
  >(null);

  const summary = useMemo(() => {
    const next = {
      ...(summaryState ?? {}),
      roadmap: roadmap || undefined,
      roadmap_status: roadmapStatus,
      roadmap_notes: roadmapNotes || undefined,
      techstack: techstack || undefined,
      techstack_status: techstackStatus,
      techstack_notes: techstackNotes || undefined,
      source_stack: sourceStack || undefined,
      source_stack_status: sourceStackStatus,
      source_stack_notes: sourceStackNotes || undefined,
    } as Record<string, unknown>;
    if (!roadmap) {
      delete next.roadmap;
    }
    if (!roadmapNotes) {
      delete next.roadmap_notes;
    }
    if (!techstack) {
      delete next.techstack;
    }
    if (!techstackNotes) {
      delete next.techstack_notes;
    }
    if (!sourceStack) {
      delete next.source_stack;
    }
    if (!sourceStackNotes) {
      delete next.source_stack_notes;
    }
    next.roadmap_status = roadmapStatus;
    next.techstack_status = techstackStatus;
    next.source_stack_status = sourceStackStatus;
    return next;
  }, [summaryState, roadmap, roadmapNotes, roadmapStatus, techstack, techstackNotes, techstackStatus, sourceStack, sourceStackNotes, sourceStackStatus]);

  const addMessage = useCallback(
    (
      role: CBv2ChatMessage["role"],
      content: string,
      eventType?: string,
      data?: Record<string, unknown>
    ) => {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role,
          content,
          timestamp: Date.now(),
          eventType,
          data,
        },
      ]);
    },
    []
  );

  const refreshFileTree = useCallback(async (workspaceRoot?: string) => {
    try {
      if (workspaceRoot) {
        historyRunIdRef.current = "";
        workspaceRootRef.current = workspaceRoot;
      }
      const historyRunId = historyRunIdRef.current;
      const wsRoot = workspaceRootRef.current;

      // When viewing a historical run, use the run-based endpoint (blob fallback)
      if (historyRunId) {
        const res = await fetchFromModernizationApi(
          `/legacy-modernization/runs/${encodeURIComponent(historyRunId)}/files`
        );
        if (!res.ok) return;
        const data = await res.json();
        setFileTree(data.tree || []);
        setFileCount(data.count || 0);
        return;
      }

      if (!wsRoot) {
        setFileTree([]);
        setFileCount(0);
        return;
      }

      const qs = `?workspace_root=${encodeURIComponent(wsRoot)}`;
      const res = await fetchFromModernizationApi(`/files${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      setFileTree(data.tree || []);
      setFileCount(data.count || 0);
    } catch {
      // Ignore while pipeline is not ready.
    }
  }, []);

  // Populate the explorer when the page loads (useful after a refresh or when
  // inspecting an already-generated workspace).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshFileTree();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshFileTree]);

  const fetchFileContent = useCallback(
    async (
      path: string
    ): Promise<{ content: string; language: string } | null> => {
      try {
        const historyRunId = historyRunIdRef.current;

        // When viewing a historical run, use the run-based endpoint (blob fallback)
        if (historyRunId) {
          const res = await fetchFromModernizationApi(
            `/legacy-modernization/runs/${encodeURIComponent(historyRunId)}/files/${encodeURIComponent(path)}`
          );
          if (!res.ok) return null;
          return await res.json();
        }

        const wsRoot = workspaceRootRef.current;
        if (!wsRoot) return null;

        const qs = `?workspace_root=${encodeURIComponent(wsRoot)}`;
        const res = await fetchFromModernizationApi(
          `/files/${encodeURIComponent(path)}${qs}`
        );
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    []
  );

  const saveFile = useCallback(
    async (path: string, content: string): Promise<boolean> => {
      const normalizedPath = path.replace(/^\/+/, "");
      if (!normalizedPath) return false;

      try {
        const res = await fetchFromModernizationApi("/files/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: normalizedPath,
            content,
            workspace_root: workspaceRootRef.current || undefined,
            run_id: historyRunIdRef.current || undefined,
          }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    []
  );

  const applyAIChange = useCallback(
    async (
      path: string,
      instruction: string,
      currentContent?: string,
      symbolName?: string,
      projectId?: number
    ): Promise<{ content: string; language: string; summary?: string } | null> => {
      const normalizedPath = path.replace(/^\/+/, "");
      const trimmedInstruction = instruction.trim();
      if (!normalizedPath || !trimmedInstruction) return null;

      try {
        const res = await fetchFromModernizationApi("/files/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: normalizedPath,
            instruction: trimmedInstruction,
            current_content: currentContent,
            symbol_name: symbolName?.trim() || undefined,
            project_id: projectId || undefined,
            workspace_root: workspaceRootRef.current || undefined,
            run_id: historyRunIdRef.current || undefined,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) return null;
        const content = String((payload as { content?: unknown }).content ?? "");
        if (!content) return null;
        return {
          content,
          language: String((payload as { language?: unknown }).language ?? "plaintext"),
          summary: String((payload as { summary?: unknown }).summary ?? ""),
        };
      } catch {
        return null;
      }
    },
    []
  );

  const applyChatCodebaseChange = useCallback(
    async (
      instruction: string,
      projectId?: number,
      history?: Array<{ role: string; content: string }>
    ): Promise<{ proposalId: string; summary: string; impactPlan: string[]; suggestions: string[]; changedFiles: LegacyCodebaseChangeFile[] } | null> => {
      const trimmedInstruction = instruction.trim();
      if (!trimmedInstruction) return null;

      try {
        const res = await fetchFromModernizationApi("/files/ai-codebase-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: trimmedInstruction,
            project_id: projectId || undefined,
            workspace_root: workspaceRootRef.current || undefined,
            run_id: historyRunIdRef.current || undefined,
            history: history || [],
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) return null;
        const changedFiles = Array.isArray((payload as { changed_files?: unknown }).changed_files)
          ? ((payload as { changed_files: Array<Record<string, unknown>> }).changed_files)
              .map((item) => ({
                path: String(item.path ?? ""),
                reason: String(item.reason ?? ""),
                language: String(item.language ?? "plaintext"),
                size: typeof item.size === "number" ? item.size : Number(item.size ?? 0),
                originalContent: String(item.original_content ?? ""),
                content: String(item.content ?? ""),
                diffPreview: String(item.diff_preview ?? ""),
              }))
              .filter((item) => item.path && item.content)
          : [];
        const suggestions = Array.isArray((payload as { suggestions?: unknown }).suggestions)
          ? ((payload as { suggestions: unknown[] }).suggestions).map((item) => String(item).trim()).filter(Boolean)
          : [];
        const impactPlan = Array.isArray((payload as { impact_plan?: unknown }).impact_plan)
          ? ((payload as { impact_plan: unknown[] }).impact_plan).map((item) => String(item).trim()).filter(Boolean)
          : [];
        return {
          proposalId: String((payload as { proposal_id?: unknown }).proposal_id ?? `proposal-${Date.now()}`),
          summary: String((payload as { summary?: unknown }).summary ?? "AI codebase change completed"),
          impactPlan,
          suggestions,
          changedFiles,
        };
      } catch {
        return null;
      }
    },
    []
  );

  const approveChatCodebaseChange = useCallback(
    async (proposalId: string, changedFiles: LegacyCodebaseChangeFile[]): Promise<boolean> => {
      const changes = changedFiles
        .map((file) => ({
          path: file.path,
          content: file.content ?? "",
          reason: file.reason,
        }))
        .filter((file) => file.path && file.content);

      if (!proposalId || changes.length === 0) {
        addMessage("assistant", "There are no proposed code changes to approve.", "chat_code_change_error");
        return false;
      }

      try {
        const res = await fetchFromModernizationApi("/files/ai-codebase-apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            changes,
            workspace_root: workspaceRootRef.current || undefined,
            run_id: historyRunIdRef.current || undefined,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail = String((payload as { detail?: unknown }).detail ?? res.statusText ?? "Unknown error");
          addMessage("assistant", `Could not apply approved changes: ${detail}`, "chat_code_change_error");
          return false;
        }

        setMessages((prev) => prev.map((message) => {
          if (message.eventType !== "chat_code_change_proposed" || message.data?.proposalId !== proposalId) return message;
          return { ...message, data: { ...message.data, status: "approved" } };
        }));
        await refreshFileTree();
        const changedList = changes.slice(0, 8).map((file) => `- \`${file.path}\``).join("\n");
        addMessage(
          "assistant",
          `**Generated Code Updated**\n\nApproved changes were applied.\n\nChanged files:\n${changedList}`,
          "chat_code_change_applied",
          { proposalId, changedFiles: changes }
        );
        return true;
      } catch (error) {
        addMessage(
          "assistant",
          `Could not apply approved changes: ${error instanceof Error ? error.message : "Unknown error"}`,
          "chat_code_change_error"
        );
        return false;
      }
    },
    [addMessage, refreshFileTree]
  );

  const rejectChatCodebaseChange = useCallback((proposalId: string) => {
    setMessages((prev) => prev.map((message) => {
      if (message.eventType !== "chat_code_change_proposed" || message.data?.proposalId !== proposalId) return message;
      return { ...message, data: { ...message.data, status: "rejected" } };
    }));
    addMessage("assistant", "The generated-code proposal was rejected. No files were changed.", "chat_code_change_rejected", { proposalId });
  }, [addMessage]);

  const resetState = useCallback((options: ResetStateOptions = {}) => {
    const preserveExplorer = options.preserveExplorer ?? false;
    setMessages([]);
    if (!preserveExplorer) {
      setFileTree([]);
      setFileCount(0);
    }
    setCurrentPhase("");
    setGeneratingFiles([]);
    setCompletedFiles([]);
    setManifest([]);
    setSummary(null);
    setRoadmap("");
    setRoadmapStatus("idle");
    setRoadmapNotes("");
    setTechstack("");
    setTechstackStatus("idle");
    setTechstackNotes("");
    setSourceStack("");
    setSourceStackStatus("idle");
    setSourceStackNotes("");
    setOpenQuestions([]);
    setOpenQuestionsSuggested([]);
    setOpenQuestionsStatus("idle");
    setPhaseProgress({ index: 0, total: 0 });
    setPhaseTimings({});
    setPipelineStartTime(null);
    setAnalysisMetrics(null);
    if (!preserveExplorer) {
      workspaceRootRef.current = "";
    }
    historyRunIdRef.current = "";
    seenDoneRef.current = false;
    hadTerminalErrorRef.current = false;
    pipelineStoppedRef.current = false;
    runKindRef.current = "";
    requestedProjectIdRef.current = null;
    requestedTargetStackRef.current = "";
    requestedModernizationGoalRef.current = "";
    approvedRoadmapRef.current = "";
    roadmapContextRef.current = null;
    reverseEngineeringCompletedRef.current = null;
    clearPersistedSseRun();
  }, []);

  const closeEventStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => closeEventStream, [closeEventStream]);

  const handleEvent = useCallback(
    (event: LegacyModernizationEvent) => {
      const type = event.type;

      switch (type) {
        case "accepted":
          addMessage("system", String(event.message ?? "Request accepted."), type);
          if (event.workspace_root) {
            void refreshFileTree(String(event.workspace_root));
          }
          setSummary((prev) => ({
            ...(prev ?? {}),
            ...(event.workspace_root ? { workspace_root: String(event.workspace_root) } : {}),
            ...(event.target_stack ? { target_stack: String(event.target_stack) } : {}),
            ...(event.pipeline_stage ? { pipeline_stage: String(event.pipeline_stage) } : {}),
          }));
          break;

        case "pipeline_started":
          setStatus("running");
          setPipelineStartTime(Date.now());
          if (event.workspace_root) {
            void refreshFileTree(String(event.workspace_root));
          }
          setSummary((prev) => ({
            ...(prev ?? {}),
            ...(event.workspace_root ? { workspace_root: String(event.workspace_root) } : {}),
            ...(event.pipeline_stage ? { pipeline_stage: String(event.pipeline_stage) } : {}),
          }));
          addMessage(
            "assistant",
            "Legacy reverse engineering started. Preparing analysis workspace...",
            type,
            event as Record<string, unknown>
          );
          break;

        case "phase":
          setCurrentPhase(String(event.label ?? event.phase ?? ""));
          if (typeof (event as Record<string, unknown>).phase_index === "number") {
            setPhaseProgress({
              index: Number((event as Record<string, unknown>).phase_index),
              total: Number((event as Record<string, unknown>).total_phases ?? 0),
            });
          }
          addMessage(
            "assistant",
            `Working on ${String(event.label ?? event.phase ?? "next step")}...`,
            type
          );
          break;

        case "legacy_workspace_ready":
          if (event.workspace_root) {
            void refreshFileTree(String(event.workspace_root));
          }
          setSummary((prev) => ({
            ...(prev ?? {}),
            ...(event.workspace_root ? { workspace_root: String(event.workspace_root) } : {}),
            ...(event.analysis_dir ? { analysis_dir: String(event.analysis_dir) } : {}),
            ...(event.generated_dir ? { generated_dir: String(event.generated_dir) } : {}),
          }));
          addMessage(
            "assistant",
            `Workspace ready for \`${String(event.project_name ?? "modernization run")}\`.`,
            type
          );
          break;

        case "analysis_inventory": {
          const ev = event as Record<string, unknown>;
          const totalFiles = Number(ev.total_files ?? 0);
          const sourceFilesCount = Number(ev.source_files ?? 0);
          const langCounts = (ev.language_counts ?? {}) as Record<string, number>;
          const primaryLang = String(ev.primary_language ?? "Unknown");
          setAnalysisMetrics((prev) => ({
            totalFiles,
            sourceFiles: sourceFilesCount,
            primaryLanguage: primaryLang,
            languageCounts: langCounts,
            importantFilesCount: Number(ev.important_files_count ?? prev?.importantFilesCount ?? 0),
            excludedFiles: Number(ev.excluded_files ?? prev?.excludedFiles ?? 0),
            analysisMode: prev?.analysisMode ?? "scanning",
          }));
          const langSummary = Object.entries(langCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([lang, count]) => `${lang}: ${count}`)
            .join(", ");
          addMessage(
            "assistant",
            `Scanned **${totalFiles}** files (${sourceFilesCount} source files). Primary language: **${primaryLang}**.\nLanguage breakdown: ${langSummary || "N/A"}`,
            type,
            ev
          );
          break;
        }

        case "repository_validation_passed": {
          const ev = event as Record<string, unknown>;
          const totalFiles = Number(ev.total_files ?? 0);
          const sourceFilesCount = Number(ev.source_files ?? 0);
          const langCounts = (ev.language_counts ?? {}) as Record<string, number>;
          const primaryLang = String(ev.primary_language ?? "Unknown");
          setAnalysisMetrics((prev) => ({
            totalFiles,
            sourceFiles: sourceFilesCount,
            primaryLanguage: primaryLang,
            languageCounts: langCounts,
            importantFilesCount: prev?.importantFilesCount ?? 0,
            excludedFiles: prev?.excludedFiles ?? 0,
            analysisMode: "validated",
          }));
          setSummary((prev) => ({
            ...(prev ?? {}),
            repository_validation_status: "passed",
            repository_validation: ev,
          }));
          addMessage(
            "assistant",
            `Repository validation passed. Found **${sourceFilesCount}** supported source file${sourceFilesCount === 1 ? "" : "s"} across **${totalFiles}** file${totalFiles === 1 ? "" : "s"}. Continuing automatically.`,
            type,
            ev
          );
          break;
        }

        case "repository_validation_required": {
          const ev = event as Record<string, unknown>;
          const issues = Array.isArray(ev.issues) ? (ev.issues as string[]) : [];
          setSummary((prev) => ({
            ...(prev ?? {}),
            repository_validation_status: "pending",
            repository_validation: ev,
          }));
          addMessage(
            "assistant",
            [
              "**Repository validation needs your decision.**",
              "",
              issues.length ? issues.map((issue) => `- ${issue}`).join("\n") : "- The upload does not look like a supported source repository.",
              "",
              Boolean(ev.can_force_continue)
                ? "You can stop now, or proceed with a best-effort analysis of the non-empty files."
                : "There is no analyzable content, so stopping is recommended.",
            ].join("\n"),
            type,
            ev
          );
          break;
        }

        case "repository_validation_overridden":
          setSummary((prev) => ({
            ...(prev ?? {}),
            repository_validation_status: "overridden",
            repository_validation: event as Record<string, unknown>,
          }));
          addMessage(
            "assistant",
            "Repository validation was overridden. Continuing with best-effort analysis.",
            type,
            event as Record<string, unknown>
          );
          break;

        case "analysis_complete": {
          const ev = event as Record<string, unknown>;
          const timings = (ev.phase_timings ?? {}) as Record<string, number>;
          const elapsed = Number(ev.total_elapsed_seconds ?? 0);
          if (Object.keys(timings).length > 0) {
            setPhaseTimings(timings);
          }
          setAnalysisMetrics((prev) => ({
            totalFiles: Number(ev.total_files ?? prev?.totalFiles ?? 0),
            sourceFiles: Number(ev.source_files ?? prev?.sourceFiles ?? 0),
            primaryLanguage: String(ev.primary_language ?? prev?.primaryLanguage ?? "Unknown"),
            languageCounts: (ev.language_counts as Record<string, number>) ?? prev?.languageCounts ?? {},
            importantFilesCount: Number(ev.important_files_count ?? prev?.importantFilesCount ?? 0),
            excludedFiles: Number(ev.excluded_files ?? prev?.excludedFiles ?? 0),
            analysisMode: String(ev.analysis_mode ?? prev?.analysisMode ?? "heuristic"),
          }));
          refreshFileTree();
          addMessage(
            "assistant",
            `Reverse engineering analysis complete${elapsed > 0 ? ` in ${elapsed}s` : ""}. Preparing the modernization roadmap next.`,
            type,
            ev
          );
          try { qc.invalidateQueries({ queryKey: queryKeys.legacyMod.projects() }); } catch {}
          break;
        }

        case "dependency_graph_ready":
          refreshFileTree();
          setSummary((prev) => ({
            ...(prev ?? {}),
            analysis_artifacts: {
              ...(((prev ?? {}) as Record<string, unknown>).analysis_artifacts as
                | Record<string, string>
                | undefined),
              ...(event.dependency_graph_json_path
                ? { "dependency_graph.json": String(event.dependency_graph_json_path) }
                : {}),
              ...(event.dependency_mermaid_path
                ? { "dependency_diagram.mmd": String(event.dependency_mermaid_path) }
                : {}),
              ...(event.dependency_mermaid_alias_path
                ? { "dependency_graph.mmd": String(event.dependency_mermaid_alias_path) }
                : {}),
            },
          }));
          addMessage(
            "assistant",
            "Dependency graph and Mermaid diagram are ready. Opening the diagram preview now; it is also available under analysis/dependency_diagram.mmd.",
            type,
            event as Record<string, unknown>
          );
          break;

        case "reverse_engineering_complete":
          refreshFileTree();
          addMessage(
            "assistant",
            "Reverse engineering complete. The analysis artifacts are ready for the next code-generation phase.",
            type
          );
          break;

        case "open_questions": {
          const questions = Array.isArray(event.questions) ? (event.questions as string[]) : [];
          const suggested = Array.isArray(event.suggested_answers) ? (event.suggested_answers as string[]) : [];
          const stage = typeof event.stage === "string" ? event.stage : "Reverse Engineering";
          if (questions.length > 0) {
            // Accumulate questions from multiple pipeline stages
            setOpenQuestions((prev) => [...prev, ...questions]);
            setOpenQuestionsSuggested((prev) => [...prev, ...suggested]);
            setOpenQuestionsStatus("pending");
            addMessage(
              "assistant",
              `**${stage}**: Found **${questions.length}** question${questions.length > 1 ? "s" : ""} with suggested answers. Please review and click **Confirm & Continue** to proceed.`,
              type,
              { questions, suggested_answers: suggested, stage }
            );
          }
          break;
        }

        case "thinking":
          addMessage(
            "assistant",
            `${String(event.agent ?? "agent")}: ${String(event.message ?? "")}`,
            type
          );
          break;

        case "manifest":
        case "manifest_updated": {
          const files = Array.isArray(event.files)
            ? (event.files as Array<{ path: string; description: string }>)
            : [];
          setManifest(files);
          addMessage(
            "assistant",
            `Planned ${files.length} target files for the modernization output.`,
            type
          );
          break;
        }

        case "file_start": {
          const path = String(event.path ?? "");
          setGeneratingFiles((prev) => [
            ...prev.filter((item) => item !== path),
            path,
          ]);
          addMessage("assistant", `Generating \`${path}\`...`, type);
          break;
        }

        case "file_created":
        case "folder_created":
          refreshFileTree();
          try { qc.invalidateQueries({ queryKey: queryKeys.legacyMod.projects() }); } catch {}
          break;

        case "file_complete": {
          const path = String(event.path ?? "");
          setGeneratingFiles((prev) => prev.filter((item) => item !== path));
          setCompletedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
          addMessage(
            "assistant",
            Boolean((event as Record<string, unknown>).resumed)
              ? `Reused previously generated \`${path}\` and continuing from the next file.`
              : `Completed \`${path}\` (${Number(event.size ?? 0)} bytes).`,
            type
          );
          refreshFileTree();
          try { qc.invalidateQueries({ queryKey: queryKeys.legacyMod.projects() }); } catch {}
          break;
        }

        case "generation_complete": {
          const filesGenerated = Number(
            (event as Record<string, unknown>).files_generated ?? 0
          );
          const totalPlanned = manifest.length;
          addMessage(
            "assistant",
            `Generated **${filesGenerated}**${totalPlanned > 0 ? ` of ${totalPlanned} planned` : ""} files.`,
            type
          );
          break;
        }

        case "review_complete":
          addMessage(
            "assistant",
            String(event.summary ?? "Review complete."),
            type,
            event as Record<string, unknown>
          );
          break;

        case "source_stack_ready": {
          const sourceStackContent = String((event as Record<string, unknown>).source_stack_content ?? "").trim();
          const wsRoot =
            String((event as Record<string, unknown>).workspace_root ?? "") ||
            workspaceRootRef.current;

          setSourceStack(sourceStackContent);
          setSourceStackStatus("ready");
          setSourceStackNotes("");
          setSummary((prev) => ({
            ...(prev ?? {}),
            workspace_root: wsRoot || ((prev ?? {}) as Record<string, unknown>).workspace_root,
            source_stack: sourceStackContent,
            source_stack_status: "ready",
            source_stack_confirmed: false,
            source_stack_confirmation_required: true,
            source_stack_artifacts: {
              ...((((prev ?? {}) as Record<string, unknown>).source_stack_artifacts as Record<string, string> | undefined) ?? {}),
              ...((((event as Record<string, unknown>).artifact_paths as Record<string, string> | undefined) ?? {})),
            },
          }));
          addMessage(
            "assistant",
            sourceStackContent
              ? `I've detected the following tech stack in your uploaded repository:\n\n${sourceStackContent}\n\nReply **"confirm source stack"** if this looks correct, or describe any corrections needed.`
              : 'Source tech stack detection is ready. Reply **"confirm source stack"** if correct, or describe corrections.',
            type,
            event as Record<string, unknown>
          );
          break;
        }

        case "specifications_complete":
          addMessage(
            "assistant",
            "Functional and technical specifications generated successfully.",
            type
          );
          refreshFileTree();
          break;

        case "techstack_ready": {
          const techstackContent = String((event as Record<string, unknown>).techstack_content ?? "").trim();
          const wsRoot =
            String((event as Record<string, unknown>).workspace_root ?? "") ||
            workspaceRootRef.current;
          const target =
            String((event as Record<string, unknown>).target_stack ?? "") ||
            requestedTargetStackRef.current;
          const goal =
            String((event as Record<string, unknown>).modernization_goal ?? "") ||
            requestedModernizationGoalRef.current;

          if (wsRoot && target) {
            roadmapContextRef.current = {
              project_id:
                requestedProjectIdRef.current ??
                (typeof summary?.project_id === "number" ? summary.project_id : undefined),
              workspace_root: wsRoot,
              target_stack: target,
              modernization_goal: goal || undefined,
            };
          }
          setTechstack(techstackContent);
          setTechstackStatus("ready");
          setTechstackNotes("");
          setSummary((prev) => ({
            ...(prev ?? {}),
            workspace_root: wsRoot || ((prev ?? {}) as Record<string, unknown>).workspace_root,
            target_stack: target || ((prev ?? {}) as Record<string, unknown>).target_stack,
            modernization_goal: goal || ((prev ?? {}) as Record<string, unknown>).modernization_goal,
            techstack: techstackContent,
            techstack_status: "ready",
            techstack_approved: false,
            techstack_approval_required: true,
            techstack_artifacts: {
              ...((((prev ?? {}) as Record<string, unknown>).techstack_artifacts as Record<string, string> | undefined) ?? {}),
              ...((((event as Record<string, unknown>).artifact_paths as Record<string, string> | undefined) ?? {})),
            },
          }));
          addMessage(
            "assistant",
            techstackContent
              ? `Tech stack recommendation is ready for your review.\n\n${techstackContent}\n\nReply **"approve techstack"** to proceed with roadmap generation, or describe the changes you want.`
              : 'Tech stack recommendation is ready. Reply **"approve techstack"** to proceed, or describe changes.',
            type,
            event as Record<string, unknown>
          );
          break;
        }

        case "roadmap_ready": {
          const roadmapContent = String(event.roadmap_content ?? "").trim();
          const roadmapManifest = Array.isArray((event as Record<string, unknown>).roadmap_manifest)
            ? ((event as Record<string, unknown>).roadmap_manifest as Array<{ path: string; description: string }>)
            : [];
          const roadmapManifestCount = Number(
            (event as Record<string, unknown>).roadmap_manifest_count ?? roadmapManifest.length
          );
          const wsRoot =
            String((event as Record<string, unknown>).workspace_root ?? "") ||
            workspaceRootRef.current;
          const target =
            String((event as Record<string, unknown>).target_stack ?? "") ||
            requestedTargetStackRef.current;
          const goal =
            String((event as Record<string, unknown>).modernization_goal ?? "") ||
            requestedModernizationGoalRef.current;

          if (wsRoot && target) {
            roadmapContextRef.current = {
              project_id:
                requestedProjectIdRef.current ??
                (typeof summary?.project_id === "number" ? summary.project_id : undefined),
              workspace_root: wsRoot,
              target_stack: target,
              modernization_goal: goal || undefined,
            };
          }
          approvedRoadmapRef.current = "";
          setRoadmap(roadmapContent);
          if (roadmapManifest.length > 0) setManifest(roadmapManifest);
          setRoadmapStatus("ready");
          setRoadmapNotes("");
          setSummary((prev) => ({
            ...(prev ?? {}),
            workspace_root: wsRoot || ((prev ?? {}) as Record<string, unknown>).workspace_root,
            target_stack: target || ((prev ?? {}) as Record<string, unknown>).target_stack,
            modernization_goal: goal || ((prev ?? {}) as Record<string, unknown>).modernization_goal,
            roadmap: roadmapContent,
            roadmap_status: "ready",
            roadmap_approved: false,
            roadmap_manifest: roadmapManifest,
            roadmap_manifest_count: roadmapManifestCount,
            approval_required: true,
            roadmap_artifacts: {
              ...((((prev ?? {}) as Record<string, unknown>).roadmap_artifacts as Record<string, string> | undefined) ?? {}),
              ...((((event as Record<string, unknown>).artifact_paths as Record<string, string> | undefined) ?? {})),
            },
          }));
          addMessage(
            "assistant",
            roadmapContent
              ? `Modernization roadmap is ready for your approval.\n\nPlanned target files: **${roadmapManifestCount || roadmapManifest.length}**.\n\n${roadmapContent}\n\nReply "approve" to proceed with code generation, or describe the roadmap changes you want.`
              : 'Modernization roadmap is ready for your approval. Reply "approve" to proceed with code generation, or describe the roadmap changes you want.',
            type,
            event as Record<string, unknown>
          );
          refreshFileTree();
          break;
        }

        case "pipeline_complete":
          // Treat pipeline_complete as terminal for the websocket lifecycle. Some environments
          // may close the socket before a final "done" frame is processed on the client.
          seenDoneRef.current = true;
          setGeneratingFiles([]);
          setSummary((prev) => {
            const prevObj = (prev ?? {}) as Record<string, unknown>;
            const nextObj = { ...prevObj, ...(event as Record<string, unknown>) };
            // Preserve target stack across stage transitions if later events omit it.
            if (!("target_stack" in (event as Record<string, unknown>)) && prevObj.target_stack) {
              nextObj.target_stack = prevObj.target_stack;
            }
            if (!("modernization_goal" in (event as Record<string, unknown>)) && prevObj.modernization_goal) {
              nextObj.modernization_goal = prevObj.modernization_goal;
            }
            return nextObj;
          });

          if (runKindRef.current === "reverse") {
            const eventPayload = event as Record<string, unknown>;
            const wsRoot =
              String(eventPayload.workspace_root ?? "") ||
              workspaceRootRef.current;
            const target =
              String(eventPayload.target_stack ?? "") ||
              requestedTargetStackRef.current;
            const goal =
              String(eventPayload.modernization_goal ?? "") ||
              requestedModernizationGoalRef.current;

            if (wsRoot && target) {
              reverseEngineeringCompletedRef.current = {
                project_id:
                  requestedProjectIdRef.current ??
                  (typeof summary?.project_id === "number"
                    ? summary.project_id
                    : undefined),
                workspace_root: wsRoot,
                target_stack: target,
                modernization_goal: goal || undefined,
              };
            }
          }
          addMessage(
            "assistant",
            runKindRef.current === "reverse"
              ? "Reverse engineering pipeline complete. Waiting for roadmap approval before code generation."
              : "Code generation pipeline complete. Browse the generated project in the explorer.",
            type,
            event as Record<string, unknown>
          );
          refreshFileTree();
          try { qc.invalidateQueries({ queryKey: queryKeys.legacyMod.projects() }); } catch {}
          break;

        case "pipeline_stopped":
          seenDoneRef.current = true;
          pipelineStoppedRef.current = true;
          setGeneratingFiles([]);
          setStatus("complete");
          setSummary((prev) => ({
            ...(prev ?? {}),
            repository_validation_status: "stopped",
            pipeline_stopped: true,
          }));
          addMessage(
            "assistant",
            String(event.message ?? "Pipeline stopped."),
            type,
            event as Record<string, unknown>
          );
          break;

        case "done":
          seenDoneRef.current = true;
          setGeneratingFiles([]);
          if (hadTerminalErrorRef.current) {
            addMessage(
              "system",
              "Modernization stopped because the pipeline failed.",
              type
            );
            break;
          }
          if (pipelineStoppedRef.current) {
            setStatus("complete");
            addMessage("system", "Modernization stopped before reverse engineering.", type);
            pipelineStoppedRef.current = false;
            break;
          }
          if (reverseEngineeringCompletedRef.current) {
            setStatus("complete");
            roadmapContextRef.current = reverseEngineeringCompletedRef.current;
            addMessage(
              "system",
              "Reverse engineering finished. Review the roadmap and approve it before code generation starts.",
              type
            );
            reverseEngineeringCompletedRef.current = null;
          } else {
            setStatus("complete");
            addMessage(
              "system",
              "Modernization complete. Generated files are ready to inspect.",
              type
            );
          }
          break;

        case "error":
          // Prevent the onclose handler from adding an extra "closed before completion" message.
          seenDoneRef.current = true;
          hadTerminalErrorRef.current = true;
          setGeneratingFiles([]);
          setStatus("error");
          addMessage(
            "assistant",
            `Error: ${String(event.message ?? "Unknown error")}`,
            type
          );
          break;

        case "heartbeat":
          break;

        default:
          addMessage(
            "system",
            `[${type}] ${JSON.stringify(event).slice(0, 200)}`,
            type
          );
      }
    },
    [addMessage, refreshFileTree, summary, qc, manifest.length]
  );

  const startModernization = useCallback(
    (request: LegacyModernizationStartRequest) => {
      const isResume = !!request.resume_from_run_id;
      const workspaceRoot = typeof request.workspace_root === "string" ? request.workspace_root.trim() : "";
      if (!isResume) {
        resetState({ preserveExplorer: Boolean(workspaceRoot) });
        if (workspaceRoot) {
          void refreshFileTree(workspaceRoot);
        }
      } else {
        historyRunIdRef.current = "";
      }
      setStatus("connecting");
      runKindRef.current = "reverse";
      requestedProjectIdRef.current = request.project_id;
      requestedTargetStackRef.current = request.target_stack;
      requestedModernizationGoalRef.current = request.modernization_goal ?? "";
      if (!isResume) {
        setSummary({
          project_id: request.project_id,
          target_stack: request.target_stack,
          modernization_goal: request.modernization_goal ?? "",
          ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
          ...(request.source_path ? { source_path: request.source_path } : {}),
          ...(request.source_kind ? { source_kind: request.source_kind } : {}),
        });
      }

      addMessage(
        "user",
        isResume
          ? `Resuming pipeline for project ${request.project_id} from run ${request.resume_from_run_id}`
          : `Start reverse engineering for project ${request.project_id}. Target stack: ${request.target_stack}`,
        isResume ? "legacy_modernization_resume" : "legacy_modernization_start",
        request as unknown as Record<string, unknown>
      );

      closeEventStream();

      void (async () => {
        const startUrl = getLegacyModernizationSseUrl("/legacy-modernization/sse/modernize/start");
        try {
          seenDoneRef.current = false;
          pipelineStoppedRef.current = false;
          const startResponse = await fetch(startUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          });
          const payload = await startResponse.json().catch(() => ({}));
          if (!startResponse.ok) {
            throw new Error(String((payload as { error?: unknown; detail?: unknown }).error ?? (payload as { detail?: unknown }).detail ?? startResponse.statusText));
          }
          const runId = String((payload as { run_id?: unknown }).run_id ?? "").trim();
          if (!runId) throw new Error("SSE start did not return a run_id");

          // Persist the active SSE run so we can reconnect on browser refresh.
          savePersistedSseRun({
            runId,
            kind: "reverse",
            projectId: request.project_id,
            workspaceRoot: typeof request.workspace_root === "string" ? request.workspace_root : undefined,
            targetStack: request.target_stack,
            modernizationGoal: request.modernization_goal,
            lastEventId: -1,
            startedAt: Date.now(),
          });

          const eventsUrl = getLegacyModernizationSseUrl(`/legacy-modernization/sse/events/${encodeURIComponent(runId)}`);
          const source = new EventSource(eventsUrl);
          eventSourceRef.current = source;
          setStatus("running");
          addMessage("system", `Connected to legacy modernization SSE stream (${eventsUrl}).`);

          source.addEventListener("pipeline", (ev) => {
            try {
              const msg = ev as MessageEvent;
              const parsedId = Number.parseInt(msg.lastEventId ?? "", 10);
              if (Number.isFinite(parsedId)) {
                updatePersistedLastEventId(runId, parsedId);
              }
              const event = JSON.parse(msg.data) as LegacyModernizationEvent;
              handleEvent(event);
              const terminalEvent =
                event.type === "done" ||
                event.type === "pipeline_complete" ||
                event.type === "error";
              if (terminalEvent) {
                clearPersistedSseRun();
              }
              if (event.type === "done") {
                source.close();
                if (eventSourceRef.current === source) eventSourceRef.current = null;
              }
            } catch {
              // Ignore malformed events.
            }
          });

          source.onerror = () => {
            if (seenDoneRef.current) {
              source.close();
              if (eventSourceRef.current === source) eventSourceRef.current = null;
              return;
            }
            setStatus("error");
            addMessage(
              "system",
              `SSE error while connecting to ${eventsUrl}. Check that the legacy modernization backend is reachable from this browser.`,
              "error"
            );
          };
        } catch (error) {
          setStatus("error");
          addMessage(
            "system",
            `Failed to start legacy modernization stream: ${error instanceof Error ? error.message : "Unknown error"}`,
            "error"
          );
        }
      })();
    },
    [addMessage, closeEventStream, handleEvent, refreshFileTree, resetState]
  );

  const startCodeGeneration = useCallback(
    (request: LegacyModernizationCodegenRequest) => {
      if (!request.confirmed) {
        addMessage("system", "Code generation cancelled (not confirmed).", "codegen_cancelled");
        return;
      }
      const isResume = !!request.resume_from_run_id;
      runKindRef.current = "codegen";

      const workspaceRoot = request.workspace_root.trim();
      if (!workspaceRoot) {
        addMessage("system", "workspace_root is required for code generation.", "codegen_error");
        return;
      }

      closeEventStream();

      workspaceRootRef.current = workspaceRoot;
      seenDoneRef.current = false;
      pipelineStoppedRef.current = false;
      setStatus("connecting");
      const roadmapInstruction = (request.user_prompt ?? approvedRoadmapRef.current ?? "").trim();
      const normalizedRequest = {
        ...request,
        user_prompt: roadmapInstruction || undefined,
      };
      addMessage(
        "user",
        isResume
          ? `Resume code generation for project ${request.project_id ?? "unknown"} from run ${request.resume_from_run_id}`
          : roadmapInstruction
            ? `Proceed to code generation. Target stack: ${request.target_stack}\nApproved roadmap:\n${roadmapInstruction}`
            : `Proceed to code generation. Target stack: ${request.target_stack}`,
        "codegen_start"
      );

      void (async () => {
        const startUrl = getLegacyModernizationSseUrl("/legacy-modernization/sse/generate/start");
        try {
          const startResponse = await fetch(startUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(normalizedRequest),
          });
          const payload = await startResponse.json().catch(() => ({}));
          if (!startResponse.ok) {
            throw new Error(String((payload as { error?: unknown; detail?: unknown }).error ?? (payload as { detail?: unknown }).detail ?? startResponse.statusText));
          }
          const runId = String((payload as { run_id?: unknown }).run_id ?? "").trim();
          if (!runId) throw new Error("SSE start did not return a run_id");

          // Persist the active SSE run so we can reconnect on browser refresh.
          savePersistedSseRun({
            runId,
            kind: "codegen",
            projectId: request.project_id,
            workspaceRoot,
            targetStack: request.target_stack,
            modernizationGoal: request.modernization_goal,
            lastEventId: -1,
            startedAt: Date.now(),
          });

          const eventsUrl = getLegacyModernizationSseUrl(`/legacy-modernization/sse/events/${encodeURIComponent(runId)}`);
          const source = new EventSource(eventsUrl);
          eventSourceRef.current = source;
          setStatus("running");
          addMessage("system", `Connected to legacy code generation SSE stream (${eventsUrl}).`, "codegen_connected");

          source.addEventListener("pipeline", (ev) => {
            try {
              const msg = ev as MessageEvent;
              const parsedId = Number.parseInt(msg.lastEventId ?? "", 10);
              if (Number.isFinite(parsedId)) {
                updatePersistedLastEventId(runId, parsedId);
              }
              const event = JSON.parse(msg.data) as LegacyModernizationEvent;
              handleEvent(event);
              const terminalEvent =
                event.type === "done" ||
                event.type === "pipeline_complete" ||
                event.type === "error";
              if (terminalEvent) {
                clearPersistedSseRun();
              }
              if (event.type === "done") {
                source.close();
                if (eventSourceRef.current === source) eventSourceRef.current = null;
              }
            } catch {
              // Ignore malformed events.
            }
          });

          source.onerror = () => {
            if (seenDoneRef.current) {
              source.close();
              if (eventSourceRef.current === source) eventSourceRef.current = null;
              return;
            }
            setStatus("error");
            addMessage(
              "system",
              `SSE error while connecting to ${eventsUrl}. Check that the legacy modernization backend is reachable from this browser.`,
              "codegen_error"
            );
          };
        } catch (error) {
          setStatus("error");
          addMessage(
            "system",
            `Failed to start legacy code generation stream: ${error instanceof Error ? error.message : "Unknown error"}`,
            "codegen_error"
          );
        }
      })();
    },
    [addMessage, closeEventStream, handleEvent]
  );

  const generateSpecs = useCallback(
    async (
      workspaceRoot: string,
      specTypes: Array<"functional" | "technical">
    ) => {
      try {
        addMessage(
          "user",
          `Generate ${specTypes.join(" + ")} specification document(s)`
        );
        const res = await fetch(
          `${getLegacyModernizationApiRoot()}/api/legacy-modernization/generate-specs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspace_root: workspaceRoot,
              spec_types: specTypes,
            }),
          }
        );
        const payload = await res.json();
        if (!res.ok) {
          addMessage(
            "assistant",
            `Specification generation failed: ${String(payload?.error ?? res.statusText)}`,
            "error"
          );
          return null;
        }
        addMessage(
          "assistant",
          `Specification generation complete for ${specTypes.join(" + ")}.`,
          "specs_complete",
          payload as Record<string, unknown>
        );
        await refreshFileTree();
        setSummary((prev) => ({
          ...(prev ?? {}),
          workspace_root: workspaceRoot,
          analysis_artifacts: {
            ...(((prev ?? {}) as Record<string, unknown>).analysis_artifacts as
              | Record<string, string>
              | undefined),
            ...((payload.artifacts as Record<string, string> | undefined) ?? {}),
          },
        }));
        return payload as Record<string, unknown>;
      } catch (error) {
        addMessage(
          "assistant",
          `Specification generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "error"
        );
        return null;
      }
    },
    [addMessage, refreshFileTree]
  );

  const loadRunFromHistory = useCallback(
    async (run: {
      run_id?: string;
      workspace_root?: string;
      target_stack?: string;
      project_id?: number;
      prompt_description?: string;
      project_name?: string;
    }) => {
      const runId = String(run.run_id ?? "").trim();
      const workspaceRoot = String(run.workspace_root ?? "").trim();
      if (!workspaceRoot && !runId) return;

      // Store run_id so refreshFileTree / fetchFileContent use blob-fallback endpoints
      historyRunIdRef.current = runId;
      workspaceRootRef.current = workspaceRoot;
      if (run.target_stack?.trim()) {
        requestedTargetStackRef.current = run.target_stack.trim();
      }

      // Reset prior state so the UI starts fresh before populating
      setMessages([]);
      setGeneratingFiles([]);
      setCompletedFiles([]);
      setManifest([]);
      setOpenQuestions([]);
      setOpenQuestionsSuggested([]);
      setOpenQuestionsStatus("idle");

      setSummary((prev) => ({
        ...(prev ?? {}),
        ...(run.run_id ? { run_id: run.run_id } : {}),
        ...(run.project_id ? { project_id: run.project_id } : {}),
        ...(run.project_name ? { project_name: run.project_name } : {}),
        ...(run.prompt_description ? { prompt_description: run.prompt_description } : {}),
        workspace_root: workspaceRoot,
        ...(run.target_stack ? { target_stack: run.target_stack } : {}),
      }));

      // Fetch full restorable state from the backend
      if (runId) {
        try {
          const res = await fetchFromModernizationApi(
            `/legacy-modernization/runs/${encodeURIComponent(runId)}/restore`
          );
          if (res.ok) {
            const data = await res.json();

            // Update run metadata from backend even when historical workspace paths are not local.
            const restoredWorkspace = String(data.workspace_root ?? "").trim();
            if (data.target_stack) {
              requestedTargetStackRef.current = String(data.target_stack).trim();
            }
            if (data.modernization_goal) {
              requestedModernizationGoalRef.current = String(data.modernization_goal).trim();
            }
            setSummary((prev) => ({
              ...(prev ?? {}),
              ...(data.target_stack ? { target_stack: data.target_stack } : {}),
              ...(data.modernization_goal ? { modernization_goal: data.modernization_goal } : {}),
              ...(data.project_name ? { project_name: data.project_name } : {}),
              ...(data.current_phase ? { current_phase: data.current_phase } : {}),
              ...(data.status ? { restored_status: data.status } : {}),
              ...(data.analysis_artifacts ? { analysis_artifacts: data.analysis_artifacts } : {}),
              ...(Array.isArray(data.roadmap_manifest) ? { roadmap_manifest: data.roadmap_manifest } : {}),
              ...(typeof data.roadmap_manifest_count === "number" ? { roadmap_manifest_count: data.roadmap_manifest_count } : {}),
            }));
            if (restoredWorkspace) {
              workspaceRootRef.current = restoredWorkspace;
              setSummary((prev) => ({
                ...(prev ?? {}),
                workspace_root: restoredWorkspace,
              }));
            }

            // Restore source stack
            if (data.source_stack_content) {
              setSourceStack(data.source_stack_content);
              setSourceStackStatus(data.source_stack_confirmed ? "approved" : "ready");
              addMessage(
                "assistant",
                `**Source Stack** (restored from previous session):\n\n${data.source_stack_content}`,
                "source_stack_ready"
              );
            }

            // Restore techstack
            if (data.techstack_content) {
              setTechstack(data.techstack_content);
              setTechstackStatus(data.techstack_approved ? "approved" : "ready");
              addMessage(
                "assistant",
                `**Target Tech Stack** (restored from previous session):\n\n${data.techstack_content}`,
                "techstack_ready"
              );
            }

            // Restore roadmap
            if (data.roadmap_content) {
              setRoadmap(data.roadmap_content);
              if (Array.isArray(data.roadmap_manifest)) {
                setManifest(data.roadmap_manifest as Array<{ path: string; description: string }>);
              }
              const isApproved = !!data.roadmap_approved;
              setRoadmapStatus(isApproved ? "approved" : "ready");
              if (isApproved) {
                approvedRoadmapRef.current = data.roadmap_content;
              }
              addMessage(
                "assistant",
                `**Modernization Roadmap** (restored from previous session):\n\n${data.roadmap_content}${
                  isApproved
                    ? "\n\n✅ *Roadmap was previously approved.*"
                    : '\n\nReply **"approve"** to proceed with code generation, or describe changes.'
                }`,
                "roadmap_ready"
              );
            }

            // Restore analysis metrics
            if (data.analysis_metrics) {
              setAnalysisMetrics(data.analysis_metrics);
            }

            // Restore roadmap context ref for codegen
            if (data.workspace_root && data.target_stack) {
              roadmapContextRef.current = {
                project_id: run.project_id,
                workspace_root: data.workspace_root,
                target_stack: data.target_stack,
                modernization_goal: data.modernization_goal || undefined,
              };
            }

            // Restore generated file counts so the UI shows progress
            if (data.files_generated > 0 || data.files_planned > 0) {
              setSummary((prev) => ({
                ...(prev ?? {}),
                files_planned: data.files_planned || prev?.files_planned || 0,
                files_generated: data.files_generated || prev?.files_generated || 0,
              }));
            }

            // Update status based on run state
            const runStatus = data.status || "unknown";
            if (runStatus === "completed") {
              setStatus("complete");
              setCurrentPhase("Completed");
              addMessage(
                "system",
                "Session restored from history. You can browse files in the explorer, or start a new pipeline.",
                "restore_complete"
              );
            } else if (runStatus === "running" || runStatus === "waiting_approval" || runStatus === "waiting_confirmation") {
              // Restored sessions do not have a live websocket stream attached.
              // Keep the agent interactive so users can approve/revise/resume via chat.
              setStatus("idle");
              setCurrentPhase(data.current_phase || "Ready to Resume");
              const phase = String(data.current_phase || "").toLowerCase();
              const hasSourceStack = !!data.source_stack_content;
              const hasTechstack = !!data.techstack_content;
              const hasRoadmap = !!data.roadmap_content;
              const sourceConfirmed = !!data.source_stack_confirmed;
              const techstackApproved = !!data.techstack_approved;
              const roadmapApproved = !!data.roadmap_approved;
              const isResumable = !!data.resumable;

              let hint = "Session restored.";
              if (isResumable) {
                const resumePhase = String(data.resume_phase || "").replace(/_/g, " ");
                hint += ` The pipeline can be resumed from **${resumePhase || "the last checkpoint"}**. Click **Resume Pipeline** or type **"resume"** to continue.`;
              } else if (!sourceConfirmed && hasSourceStack) {
                hint += ' Reply **"confirm source stack"** or request source-stack changes.';
              } else if (!techstackApproved && hasTechstack) {
                hint += ' Review the target stack and reply **"confirm tech stack"**, or request changes.';
              } else if (!roadmapApproved && hasRoadmap) {
                hint += ' Review the roadmap and reply **"approve"** to continue, or describe changes.';
              } else if (phase.includes("running")) {
                hint += " Use Start Reverse Engineering to continue from current artifacts if needed.";
              } else {
                hint += " Live updates are paused after restore, but you can continue from chat.";
              }

              // Store resume info in summary for the panel to use
              if (isResumable) {
                setSummary((prev) => ({
                  ...(prev ?? {}),
                  resumable: true,
                  resume_from_run_id: runId,
                  resume_phase: data.resume_phase,
                  last_completed_phase: data.last_completed_phase,
                  completed_stages: data.completed_stages,
                  total_stages: data.total_stages,
                }));
              }

              addMessage("system", hint, "restore_active");
            } else if (runStatus === "failed") {
              // Pipeline was interrupted — restore what we have so the user can resume
              setStatus("idle");
              setCurrentPhase("");
              const hasRoadmap = !!data.roadmap_content;
              const roadmapApproved = !!data.roadmap_approved;
              const hasGenerated = (data.files_generated || 0) > 0;
              const isResumable = !!data.resumable;
              let hint = "Session restored from an interrupted run.";
              if (isResumable) {
                const resumePhase = String(data.resume_phase || "").replace(/_/g, " ");
                hint += ` The pipeline can be resumed from **${resumePhase || "the last checkpoint"}**. Click **Resume Pipeline** or type **"resume"** to continue.`;
                setSummary((prev) => ({
                  ...(prev ?? {}),
                  resumable: true,
                  resume_from_run_id: runId,
                  resume_phase: data.resume_phase,
                  last_completed_phase: data.last_completed_phase,
                  completed_stages: data.completed_stages,
                  total_stages: data.total_stages,
                }));
              } else if (hasGenerated) {
                hint += " Some files were generated before the interruption — check the file explorer.";
              } else if (hasRoadmap && roadmapApproved) {
                hint += ' The roadmap was approved. You can start code generation by typing **"approve"** or **/codegen**.'
              } else if (hasRoadmap) {
                hint += ' A roadmap was generated. Reply **"approve"** to proceed, or describe changes.';
              } else {
                hint += " You can restart the pipeline from the current state.";
              }
              addMessage("system", hint, "restore_failed");
            } else {
              setStatus("idle");
              addMessage(
                "system",
                "Session restored from history.",
                "restore_info"
              );
            }
          }
        } catch {
          // Restore endpoint not available — fall back to basic file tree only
        }
      }

      await refreshFileTree();
    },
    [refreshFileTree, addMessage]
  );

  const sendChat = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return null;

      // --- Resume pipeline from last checkpoint ---
      const isResume = /^(\/resume|resume\s*pipeline|resume)$/i.test(trimmed);
      if (isResume) {
        const resumeRunId =
          typeof summary?.resume_from_run_id === "string"
            ? summary.resume_from_run_id
            : undefined;
        if (!resumeRunId) {
          addMessage(
            "system",
            "No resumable run found. Start a new reverse engineering run instead.",
            "resume_unavailable"
          );
          return null;
        }
        const projectId =
          typeof summary?.project_id === "number" ? summary.project_id : 0;
        const targetStack =
          (typeof summary?.target_stack === "string" ? summary.target_stack : "") ||
          requestedTargetStackRef.current;
        const modernizationGoal =
          (typeof summary?.modernization_goal === "string"
            ? summary.modernization_goal
            : "") || requestedModernizationGoalRef.current;
        const workspaceRoot =
          workspaceRootRef.current ||
          (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");

        addMessage("user", trimmed, "resume_pipeline_user");
        addMessage("system", "Resuming pipeline from last checkpoint…", "resume_pipeline_start");
        if (String(summary?.resume_phase ?? "") === "code_generation") {
          startCodeGeneration({
            project_id: projectId || undefined,
            workspace_root: workspaceRoot,
            target_stack: targetStack,
            modernization_goal: modernizationGoal || undefined,
            user_prompt: approvedRoadmapRef.current || roadmap || undefined,
            resume_from_run_id: resumeRunId,
            confirmed: true,
          });
        } else {
          startModernization({
            project_id: projectId,
            target_stack: targetStack,
            modernization_goal: modernizationGoal || undefined,
            workspace_root: workspaceRoot || undefined,
            resume_from_run_id: resumeRunId,
          });
        }
        return null;
      }

      const codegenMatch = trimmed.match(/^\/(codegen|generate)\b\s*(.*)$/i);
      if (codegenMatch) {
        const userPrompt = (codegenMatch[2] ?? "").trim();
        if (roadmapStatus !== "approved" || !roadmap.trim()) {
          addMessage(
            "system",
            "Roadmap approval is required before code generation can start. Please review the roadmap and reply with approve, or request changes.",
            "codegen_locked"
          );
          return null;
        }
        if (!userPrompt) {
          addMessage(
            "system",
            "Usage: /codegen <what to generate>. Example: /codegen Generate the modernized code with auth + docker + CI.",
            "codegen_usage"
          );
          return null;
        }

        const workspaceRoot =
          workspaceRootRef.current ||
          (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");
        const targetStack =
          (typeof summary?.target_stack === "string" ? summary.target_stack : "") ||
          requestedTargetStackRef.current;
        const modernizationGoal =
          (typeof summary?.modernization_goal === "string"
            ? summary.modernization_goal
            : "") || requestedModernizationGoalRef.current;

        if (!workspaceRoot) {
          addMessage(
            "system",
            "Code generation is not available yet. Start reverse engineering first so a workspace is created.",
            "codegen_unavailable"
          );
          return null;
        }

        if (!targetStack.trim()) {
          addMessage(
            "system",
            "Target stack is missing. Select a target stack in Setup and start reverse engineering first.",
            "codegen_missing_target_stack"
          );
          return null;
        }

        startCodeGeneration({
          project_id:
            typeof summary?.project_id === "number"
              ? summary.project_id
              : undefined,
          workspace_root: workspaceRoot,
          target_stack: targetStack,
          modernization_goal: modernizationGoal.trim() ? modernizationGoal.trim() : undefined,
          user_prompt: `${approvedRoadmapRef.current || roadmap}\n\nAdditional instructions:\n${userPrompt}`,
          confirmed: true,
        });
        return null;
      }

      const workspaceRoot =
        workspaceRootRef.current ||
        (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");

      if (!workspaceRoot) {
        addMessage(
          "system",
          "Chat is not available yet. Start a reverse engineering run first so a workspace is created.",
          "chat_unavailable"
        );
        return null;
      }

      if (roadmapStatus === "generating") {
        addMessage(
          "system",
          "The roadmap is still being generated. Please wait a moment before requesting changes or approval.",
          "roadmap_generating"
        );
        return null;
      }

      // --- Repository validation proceed / stop flow ---
      if (String(summary?.repository_validation_status ?? "") === "pending") {
        addMessage("user", trimmed, "repository_validation_chat_user");
        const normalized = trimmed.toLowerCase();
        const action =
          normalized === "proceed" ||
          normalized === "proceed anyway" ||
          normalized === "continue" ||
          normalized === "continue anyway" ||
          normalized.startsWith("proceed")
            ? "proceed"
            : normalized === "stop" ||
              normalized === "stop pipeline" ||
              normalized === "cancel" ||
              normalized.startsWith("stop")
              ? "stop"
              : "";

        if (!action) {
          addMessage(
            "assistant",
            "Please reply **Proceed anyway** to continue with best-effort analysis, or **Stop pipeline** to stop before reverse engineering.",
            "repository_validation_decision_needed"
          );
          return null;
        }

        try {
          const projectId =
            (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
            requestedProjectIdRef.current;
          const res = await fetchFromModernizationApi("/legacy-modernization/repository-validation/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project_id: projectId ?? 0,
              workspace_root: workspaceRoot,
              action,
            }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
            addMessage("assistant", `Repository validation decision failed: ${err}`, "repository_validation_error");
            return null;
          }
          setSummary((prev) => ({
            ...(prev ?? {}),
            repository_validation_status: action === "proceed" ? "proceeding" : "stopping",
          }));
          addMessage(
            "assistant",
            action === "proceed"
              ? "Proceeding with best-effort repository analysis..."
              : "Stopping before reverse engineering...",
            "repository_validation_decision"
          );
        } catch (error) {
          addMessage(
            "assistant",
            `Repository validation decision failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            "repository_validation_error"
          );
        }
        return null;
      }

      // --- Open Questions answer / skip flow ---
      if (openQuestions.length > 0 && openQuestionsStatus === "pending") {
        addMessage("user", trimmed, "open_questions_chat_user");

        const isSkip = (() => {
          const n = trimmed.toLowerCase();
          return n === "skip questions" || n === "skip" || n.startsWith("skip question");
        })();

        if (isSkip) {
          try {
            const projectId =
              (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
              requestedProjectIdRef.current;
            await fetchFromModernizationApi("/legacy-modernization/open-questions/skip", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_id: projectId ?? 0,
                workspace_root: workspaceRoot,
              }),
            });
            setOpenQuestionsStatus("answered");
            addMessage("assistant", "Open questions skipped. Continuing with the pipeline...", "open_questions_skipped");
          } catch (error) {
            addMessage("assistant", `Failed to skip questions: ${error instanceof Error ? error.message : "Unknown error"}`, "open_questions_error");
          }
          return null;
        }

        // Parse numbered answers from user message (e.g. "1. answer\n2. answer")
        const answerMap: Record<string, string> = {};
        const answerLines = trimmed.split(/\n/);
        const numberedPattern = /^\s*(\d+)[.):\s-]+\s*(.+)/;
        let currentIdx: number | null = null;
        for (const line of answerLines) {
          const m = numberedPattern.exec(line);
          if (m) {
            currentIdx = parseInt(m[1], 10) - 1; // 0-based index
            answerMap[String(currentIdx)] = m[2].trim();
          } else if (currentIdx !== null && line.trim()) {
            // Continuation of previous answer
            answerMap[String(currentIdx)] = (answerMap[String(currentIdx)] ?? "") + " " + line.trim();
          }
        }

        // If no numbered answers detected, treat the whole message as an answer to all questions
        if (Object.keys(answerMap).length === 0) {
          openQuestions.forEach((_, i) => {
            answerMap[String(i)] = trimmed;
          });
        }

        try {
          const projectId =
            (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
            requestedProjectIdRef.current;
          const res = await fetchFromModernizationApi("/legacy-modernization/open-questions/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project_id: projectId ?? 0,
              workspace_root: workspaceRoot,
              answers: answerMap,
            }),
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
            addMessage("assistant", `Failed to submit answers: ${err}`, "open_questions_error");
            return null;
          }
          setOpenQuestionsStatus("answered");
          addMessage("assistant", "Thank you for the clarifications! Your answers have been noted and the pipeline is continuing...", "open_questions_answered");
        } catch (error) {
          addMessage("assistant", `Failed to submit answers: ${error instanceof Error ? error.message : "Unknown error"}`, "open_questions_error");
        }
        return null;
      }

      // --- Source Stack confirmation / revision flow ---
      if (sourceStack.trim() && sourceStackStatus !== "approved" && sourceStackStatus !== "idle") {
        addMessage("user", trimmed, "source_stack_chat_user");

        const isSourceStackConfirmation = (() => {
          const n = trimmed.toLowerCase();
          return (
            n === "confirm source stack" ||
            n === "confirm source" ||
            n === "confirm stack" ||
            n.startsWith("confirm source stack") ||
            n.startsWith("looks correct") ||
            n.startsWith("looks good") ||
            n === "correct" ||
            n === "confirmed"
          );
        })();

        if (isSourceStackConfirmation) {
          const contextWorkspace =
            workspaceRoot ||
            (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");

          if (!contextWorkspace) {
            addMessage("assistant", "Cannot confirm source stack — workspace context is missing.", "source_stack_error");
            return null;
          }
          try {
            const projectId =
              (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
              requestedProjectIdRef.current;
            if (!projectId) {
              addMessage("assistant", "Project context is missing, so I cannot confirm the source stack yet.", "source_stack_error");
              return null;
            }
            const res = await fetchFromModernizationApi("/legacy-modernization/source-stack/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_id: projectId,
                workspace_root: contextWorkspace,
              }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
              addMessage("assistant", `Source stack confirmation failed: ${err}`, "source_stack_error");
              return null;
            }
            const confirmedContent = String((payload as { source_stack_content?: unknown }).source_stack_content ?? sourceStack).trim();
            setSourceStack(confirmedContent);
            setSourceStackStatus("approved");
            setSourceStackNotes("");
            setSummary((prev) => ({
              ...(prev ?? {}),
              source_stack: confirmedContent,
              source_stack_status: "approved",
              source_stack_notes: undefined,
              source_stack_confirmed: true,
              source_stack_confirmation_required: false,
            }));
            addMessage(
              "assistant",
              "Source tech stack confirmed! Proceeding with the next pipeline steps...",
              "source_stack_confirmed"
            );
            return null;
          } catch (error) {
            addMessage(
              "assistant",
              `Source stack confirmation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
              "source_stack_error"
            );
            return null;
          }
        }

        // Source stack revision / correction request
        const ssRevisionRequest = trimmed;
        const ssContextWorkspace =
          workspaceRoot ||
          (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");

        if (!ssContextWorkspace) {
          addMessage("assistant", "Cannot revise the source stack — context is unavailable.", "source_stack_error");
          return null;
        }

        setSourceStackStatus("revising");
        addMessage("assistant", "Checking your source stack corrections...", "source_stack_revision_started");
        try {
          const projectId =
            (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
            requestedProjectIdRef.current;
          if (!projectId) {
            addMessage("assistant", "Project context is missing, so I cannot revise the source stack.", "source_stack_error");
            setSourceStackStatus("blocked");
            return null;
          }
          const res = await fetchFromModernizationApi("/legacy-modernization/source-stack/revise", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project_id: projectId,
              workspace_root: ssContextWorkspace,
              requested_changes: ssRevisionRequest,
            }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
            addMessage("assistant", `Source stack revision failed: ${err}`, "source_stack_error");
            setSourceStackStatus("blocked");
            setSourceStackNotes(err);
            return null;
          }

          const accepted = Boolean((payload as { accepted?: unknown }).accepted);
          const reason = String((payload as { reason?: unknown }).reason ?? "").trim();
          const nextSourceStack = String((payload as { source_stack_content?: unknown }).source_stack_content ?? sourceStack).trim();
          if (!accepted) {
            setSourceStackStatus("blocked");
            setSourceStackNotes(reason || "Requested source stack correction could not be applied.");
            addMessage(
              "assistant",
              `${reason || "That correction could not be verified."}\n\nThe detected stack remains unchanged. Reply **"confirm source stack"** to proceed, or suggest another correction.`,
              "source_stack_rejected"
            );
            return null;
          }

          setSourceStack(nextSourceStack);
          setSourceStackStatus("ready");
          setSourceStackNotes(reason);
          setSummary((prev) => ({
            ...(prev ?? {}),
            source_stack: nextSourceStack,
            source_stack_status: "ready",
            source_stack_notes: reason || undefined,
            source_stack_confirmed: false,
            source_stack_confirmation_required: true,
          }));
          addMessage(
            "assistant",
            `${reason || "Source stack updated with your corrections."}\n\n${nextSourceStack}\n\nReply **"confirm source stack"** to proceed, or suggest more corrections.`,
            "source_stack_revised"
          );
          return null;
        } catch (error) {
          const err = error instanceof Error ? error.message : "Unknown error";
          addMessage("assistant", `Source stack revision failed: ${err}`, "source_stack_error");
          setSourceStackStatus("blocked");
          setSourceStackNotes(err);
          return null;
        }
      }

      // --- Tech Stack approval / revision flow ---
      if (techstack.trim() && techstackStatus !== "approved" && techstackStatus !== "idle") {
        addMessage("user", trimmed, "techstack_chat_user");

        const isTechstackApproval = (() => {
          const n = trimmed.toLowerCase();
          return (
            n === "approve techstack" ||
            n === "approve tech stack" ||
            n === "approve stack" ||
            n.startsWith("approve techstack") ||
            n.startsWith("approve tech stack")
          );
        })();

        if (isTechstackApproval) {
          const context = roadmapContextRef.current ?? reverseEngineeringCompletedRef.current;
          const contextWorkspace =
            context?.workspace_root ||
            workspaceRoot ||
            (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");

          if (!contextWorkspace) {
            addMessage("assistant", "Cannot approve tech stack — workspace context is missing.", "techstack_error");
            return null;
          }
          try {
            const projectId =
              (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
              requestedProjectIdRef.current ??
              context?.project_id;
            if (!projectId) {
              addMessage("assistant", "Project context is missing, so I cannot approve the tech stack yet.", "techstack_error");
              return null;
            }
            const res = await fetchFromModernizationApi("/legacy-modernization/techstack/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_id: projectId,
                workspace_root: contextWorkspace,
              }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
              addMessage("assistant", `Tech stack approval failed: ${err}`, "techstack_error");
              return null;
            }
            const approvedTechstack = String((payload as { techstack_content?: unknown }).techstack_content ?? techstack).trim();
            setTechstack(approvedTechstack);
            setTechstackStatus("approved");
            setTechstackNotes("");
            setSummary((prev) => ({
              ...(prev ?? {}),
              techstack: approvedTechstack,
              techstack_status: "approved",
              techstack_notes: undefined,
              techstack_approved: true,
              techstack_approval_required: false,
            }));
            addMessage(
              "assistant",
              "Tech stack recommendation approved! The roadmap is being generated using this approved stack. Please wait...",
              "techstack_approved"
            );
            return null;
          } catch (error) {
            addMessage(
              "assistant",
              `Tech stack approval failed: ${error instanceof Error ? error.message : "Unknown error"}`,
              "techstack_error"
            );
            return null;
          }
        }

        // Tech stack revision request
        const tsRevisionRequest = trimmed;
        const context = roadmapContextRef.current ?? reverseEngineeringCompletedRef.current;
        const contextForRevision = context
          ? context
          : workspaceRoot
            ? {
                project_id:
                  typeof summary?.project_id === "number"
                    ? summary.project_id
                    : requestedProjectIdRef.current ?? undefined,
                workspace_root: workspaceRoot,
                target_stack:
                  (typeof summary?.target_stack === "string" ? summary.target_stack : "") ||
                  requestedTargetStackRef.current,
                modernization_goal:
                  (typeof summary?.modernization_goal === "string"
                    ? summary.modernization_goal
                    : "") ||
                  requestedModernizationGoalRef.current ||
                  undefined,
              }
            : null;

        if (!contextForRevision) {
          addMessage("assistant", "Cannot revise the tech stack — context is unavailable.", "techstack_error");
          return null;
        }

        setTechstackStatus("revising");
        addMessage("assistant", "Checking whether that tech stack change is valid...", "techstack_revision_started");
        try {
          const projectId =
            (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
            requestedProjectIdRef.current ??
            contextForRevision.project_id;
          if (!projectId) {
            addMessage("assistant", "Project context is missing, so I cannot revise the tech stack.", "techstack_error");
            setTechstackStatus("blocked");
            return null;
          }
          const res = await fetchFromModernizationApi("/legacy-modernization/techstack/revise", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project_id: projectId,
              workspace_root: contextForRevision.workspace_root,
              requested_changes: tsRevisionRequest,
            }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
            addMessage("assistant", `Tech stack revision failed: ${err}`, "techstack_error");
            setTechstackStatus("blocked");
            setTechstackNotes(err);
            return null;
          }

          const accepted = Boolean((payload as { accepted?: unknown }).accepted);
          const reason = String((payload as { reason?: unknown }).reason ?? "").trim();
          const nextTechstack = String((payload as { techstack_content?: unknown }).techstack_content ?? techstack).trim();
          if (!accepted) {
            setTechstackStatus("blocked");
            setTechstackNotes(reason || "Requested tech stack change is not possible.");
            addMessage(
              "assistant",
              `${reason || "That tech stack change is not feasible for this codebase."}\n\nThe recommendation remains unchanged. Reply **"approve techstack"** to proceed, or request another change.`,
              "techstack_rejected"
            );
            return null;
          }

          setTechstack(nextTechstack);
          setTechstackStatus("ready");
          setTechstackNotes(reason);
          setSummary((prev) => ({
            ...(prev ?? {}),
            techstack: nextTechstack,
            techstack_status: "ready",
            techstack_notes: reason || undefined,
            techstack_approved: false,
            techstack_approval_required: true,
          }));
          refreshFileTree();
          addMessage(
            "assistant",
            `${reason || "Tech stack recommendation updated."}\n\n${nextTechstack}\n\nReply **"approve techstack"** to proceed with roadmap generation, or request more changes.`,
            "techstack_revised"
          );
          return null;
        } catch (error) {
          const err = error instanceof Error ? error.message : "Unknown error";
          addMessage("assistant", `Tech stack revision failed: ${err}`, "techstack_error");
          setTechstackStatus("blocked");
          setTechstackNotes(err);
          return null;
        }
      }

      if (roadmap.trim() && roadmapStatus !== "approved") {
        addMessage("user", trimmed, "roadmap_chat_user");

        if (isApprovalCommand(trimmed)) {
          const context = roadmapContextRef.current ?? reverseEngineeringCompletedRef.current;
          const contextWorkspace =
            context?.workspace_root ||
            workspaceRoot ||
            (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");
          const contextTarget =
            context?.target_stack ||
            (typeof summary?.target_stack === "string" ? summary.target_stack : "") ||
            requestedTargetStackRef.current;
          const contextGoal =
            context?.modernization_goal ||
            (typeof summary?.modernization_goal === "string" ? summary.modernization_goal : "") ||
            requestedModernizationGoalRef.current;

          if (!contextWorkspace || !contextTarget) {
            addMessage(
              "assistant",
              "I cannot start code generation yet because the roadmap context is incomplete.",
              "roadmap_error"
            );
            return null;
          }
          try {
            const projectId =
              (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
              requestedProjectIdRef.current ??
              context?.project_id;
            if (!projectId) {
              addMessage("assistant", "Project context is missing, so I cannot approve the roadmap yet.", "roadmap_error");
              return null;
            }
            const res = await fetchFromModernizationApi("/legacy-modernization/roadmap/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_id: projectId,
                workspace_root: contextWorkspace,
              }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
              addMessage("assistant", `Roadmap approval failed: ${err}`, "roadmap_error");
              return null;
            }
            const approvedRoadmap = String((payload as { roadmap_content?: unknown }).roadmap_content ?? roadmap).trim();
            const approvedManifest = Array.isArray((payload as { roadmap_manifest?: unknown }).roadmap_manifest)
              ? ((payload as { roadmap_manifest: Array<{ path: string; description: string }> }).roadmap_manifest)
              : [];
            if (approvedManifest.length > 0) setManifest(approvedManifest);
            approvedRoadmapRef.current = approvedRoadmap;
            setRoadmap(approvedRoadmap);
            setRoadmapStatus("approved");
            setRoadmapNotes("");
            setSummary((prev) => ({
              ...(prev ?? {}),
              workspace_root: contextWorkspace,
              target_stack: contextTarget,
              modernization_goal: contextGoal,
              roadmap: approvedRoadmap,
              roadmap_status: "approved",
              roadmap_notes: undefined,
              roadmap_approved: true,
              roadmap_manifest: approvedManifest,
              roadmap_manifest_count: Number((payload as { roadmap_manifest_count?: unknown }).roadmap_manifest_count ?? approvedManifest.length),
              approval_required: false,
            }));
            addMessage(
              "assistant",
              "Roadmap approved. Starting code generation now and keeping the approved plan as the implementation guide.",
              "roadmap_approved"
            );
            startCodeGeneration({
              project_id: projectId,
              workspace_root: contextWorkspace,
              target_stack: contextTarget,
              modernization_goal: contextGoal.trim() ? contextGoal.trim() : undefined,
              user_prompt: approvedRoadmap,
              confirmed: true,
            });
            return null;
          } catch (error) {
            addMessage(
              "assistant",
              `Roadmap approval failed: ${error instanceof Error ? error.message : "Unknown error"}`,
              "roadmap_error"
            );
            return null;
          }
        }

        const revisionRequest = isRoadmapRevisionRequest(trimmed)
          ? trimmed.replace(/^(revise|change|update|modify|adjust)\s+/i, "").trim() || trimmed
          : trimmed;
        const context = roadmapContextRef.current ?? reverseEngineeringCompletedRef.current;
        const contextForRevision: RoadmapContext | null = context
          ? context
          : workspaceRoot
            ? {
                project_id:
                  typeof summary?.project_id === "number"
                    ? summary.project_id
                    : requestedProjectIdRef.current ?? undefined,
                workspace_root: workspaceRoot,
                target_stack:
                  (typeof summary?.target_stack === "string" ? summary.target_stack : "") ||
                  requestedTargetStackRef.current,
                modernization_goal:
                  (typeof summary?.modernization_goal === "string"
                    ? summary.modernization_goal
                    : "") ||
                  requestedModernizationGoalRef.current ||
                  undefined,
              }
            : null;

        if (!contextForRevision) {
          addMessage(
            "assistant",
            "I cannot revise the roadmap because the roadmap context is unavailable.",
            "roadmap_error"
          );
          return null;
        }

        setRoadmapStatus("revising");
        addMessage("assistant", "I'm checking whether that roadmap change is valid...", "roadmap_revision_started");
        try {
          const projectId =
            (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
            requestedProjectIdRef.current ??
            contextForRevision.project_id;
          if (!projectId) {
            addMessage("assistant", "Project context is missing, so I cannot revise the roadmap yet.", "roadmap_error");
            setRoadmapStatus("blocked");
            return null;
          }
          const res = await fetchFromModernizationApi("/legacy-modernization/roadmap/revise", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project_id: projectId,
              workspace_root: contextForRevision.workspace_root,
              requested_changes: revisionRequest,
            }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
            addMessage("assistant", `Roadmap revision failed: ${err}`, "roadmap_error");
            setRoadmapStatus("blocked");
            setRoadmapNotes(err);
            return null;
          }

          const accepted = Boolean((payload as { accepted?: unknown }).accepted);
          const reason = String((payload as { reason?: unknown }).reason ?? "").trim();
          const nextRoadmap = String((payload as { roadmap_content?: unknown }).roadmap_content ?? roadmap).trim();
          const revisedManifest = Array.isArray((payload as { roadmap_manifest?: unknown }).roadmap_manifest)
            ? ((payload as { roadmap_manifest: Array<{ path: string; description: string }> }).roadmap_manifest)
            : [];
          if (!accepted) {
            setRoadmapStatus("blocked");
            setRoadmapNotes(reason || "Requested roadmap change is not possible.");
            addMessage(
              "assistant",
              `${reason || "That roadmap change is not possible with the current legacy system and target architecture."}\n\nThe roadmap remains unchanged. Reply "approve" to proceed with the current roadmap, or request another valid change.`,
              "roadmap_rejected"
            );
            return null;
          }

          approvedRoadmapRef.current = "";
          setRoadmap(nextRoadmap);
          if (revisedManifest.length > 0) setManifest(revisedManifest);
          setRoadmapStatus("ready");
          setRoadmapNotes(reason);
          setSummary((prev) => ({
            ...(prev ?? {}),
            roadmap: nextRoadmap,
            roadmap_status: "ready",
            roadmap_notes: reason || undefined,
            roadmap_approved: false,
            roadmap_manifest: revisedManifest,
            roadmap_manifest_count: Number((payload as { roadmap_manifest_count?: unknown }).roadmap_manifest_count ?? revisedManifest.length),
            approval_required: true,
          }));
          // Refresh explorer so updated roadmap files are visible.
          refreshFileTree();
          addMessage(
            "assistant",
            `${reason || "Roadmap updated."}\n\nPlanned target files: **${Number((payload as { roadmap_manifest_count?: unknown }).roadmap_manifest_count ?? revisedManifest.length)}**.\n\n${nextRoadmap}\n\nReply "approve" to proceed, or request more roadmap changes.`,
            "roadmap_revised"
          );
          return null;
        } catch (error) {
          const err = error instanceof Error ? error.message : "Unknown error";
          addMessage("assistant", `Roadmap revision failed: ${err}`, "roadmap_error");
          setRoadmapStatus("blocked");
          setRoadmapNotes(err);
          return null;
        }
      }

      // Keep a small rolling window to help with continuity.
      const history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));

      const projectIdForChat =
        (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
        requestedProjectIdRef.current ??
        undefined;

      if (isGeneratedCodeChangeRequest(trimmed)) {
        addMessage("user", trimmed, "chat_code_change_user");
        addMessage("assistant", "Analyzing the generated codebase and preparing a change proposal...", "chat_code_change_started");

        const result = await applyChatCodebaseChange(trimmed, projectIdForChat, history);
        if (!result) {
          addMessage(
            "assistant",
            "I could not apply that generated-code change. Try naming the class, component, API, or file more explicitly.",
            "chat_code_change_error"
          );
          return null;
        }

        const suggestions = result.suggestions.length > 0
          ? `\n\nSuggestions:\n${result.suggestions.slice(0, 3).map((item) => `- ${item}`).join("\n")}`
          : "";
        const impactPlan = result.impactPlan.length > 0
          ? `\n\nApplication impact:\n${result.impactPlan.slice(0, 8).map((item) => `- ${item}`).join("\n")}`
          : "";
        const fileSummary = result.changedFiles.length > 0
          ? `${result.changedFiles.length} proposed file change${result.changedFiles.length === 1 ? "" : "s"} are ready for review below.`
          : "No files needed to be changed.";
        const reply = `**Review Generated Code Changes**\n\n${result.summary}${impactPlan}\n\n${fileSummary}${suggestions}\n\nReview the file list and diff previews below, then approve to apply the changes.`;
        addMessage("assistant", reply, "chat_code_change_proposed", {
          proposalId: result.proposalId,
          changedFiles: result.changedFiles,
          impactPlan: result.impactPlan,
          suggestions: result.suggestions,
          status: "pending",
        });
        return reply;
      }

      addMessage("user", trimmed, "chat_user");

      try {
        const res = await fetchFromModernizationApi("/legacy-modernization/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_id: projectIdForChat,
            workspace_root: workspaceRoot,
            run_id: historyRunIdRef.current || undefined,
            message: trimmed,
            history,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = String(payload?.error ?? res.statusText ?? "Unknown error");
          addMessage("assistant", `Chat failed: ${err}`, "chat_error");
          return null;
        }
        const reply = String(payload?.reply ?? "").trim();
        addMessage("assistant", reply || "(empty response)", "chat_reply");
        return reply || null;
      } catch (error) {
        addMessage(
          "assistant",
          `Chat failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "chat_error"
        );
        return null;
      }
    },
    [addMessage, messages, roadmap, roadmapStatus, techstack, techstackStatus, sourceStack, sourceStackStatus, startCodeGeneration, startModernization, summary, refreshFileTree, openQuestions, openQuestionsStatus, applyChatCodebaseChange]
  );

  const submitOpenQuestionAnswers = useCallback(
    async (answers: Record<string, string>, stage?: string) => {
      const workspaceRoot =
        workspaceRootRef.current ||
        (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");
      const projectId =
        (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
        requestedProjectIdRef.current;
      try {
        const res = await fetchFromModernizationApi("/legacy-modernization/open-questions/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_id: projectId ?? 0,
            workspace_root: workspaceRoot,
            answers,
            stage: stage || null,
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          const err = String((payload as { error?: unknown }).error ?? res.statusText ?? "Unknown error");
          addMessage("assistant", `Failed to submit answers: ${err}`, "open_questions_error");
          return;
        }
        setOpenQuestionsStatus("answered");
        addMessage("assistant", `Thank you! ${stage ? `**${stage}** answers` : "Answers"} have been updated and the pipeline is continuing...`, "open_questions_answered");
      } catch (error) {
        addMessage("assistant", `Failed to submit answers: ${error instanceof Error ? error.message : "Unknown error"}`, "open_questions_error");
      }
    },
    [addMessage, summary]
  );

  const skipOpenQuestions = useCallback(
    async () => {
      const workspaceRoot =
        workspaceRootRef.current ||
        (typeof summary?.workspace_root === "string" ? summary.workspace_root : "");
      const projectId =
        (typeof summary?.project_id === "number" ? summary.project_id : undefined) ??
        requestedProjectIdRef.current;
      try {
        await fetchFromModernizationApi("/legacy-modernization/open-questions/skip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_id: projectId ?? 0,
            workspace_root: workspaceRoot,
          }),
        });
        setOpenQuestionsStatus("answered");
        addMessage("assistant", "Open questions skipped. Continuing with the pipeline...", "open_questions_skipped");
      } catch (error) {
        addMessage("assistant", `Failed to skip questions: ${error instanceof Error ? error.message : "Unknown error"}`, "open_questions_error");
      }
    },
    [addMessage, summary]
  );

  // Reconnect to an in-flight legacy modernization / code-generation SSE
  // stream after a browser refresh.  The backend keeps running and supports
  // resume via the `last_id` query param, so we can pick up where we left off
  // without losing progress.
  const didAttemptSseReconnectRef = useRef(false);
  useEffect(() => {
    if (didAttemptSseReconnectRef.current) return;
    didAttemptSseReconnectRef.current = true;
    if (typeof window === "undefined") return;

    const persisted = loadPersistedSseRun();
    if (!persisted) return;

    // If a fresh start is already in progress (mount-then-immediate-start),
    // do not interfere with it.
    if (eventSourceRef.current) return;

    const { runId, kind, workspaceRoot, lastEventId } = persisted;
    if (workspaceRoot) {
      workspaceRootRef.current = workspaceRoot;
    }
    runKindRef.current = kind;
    seenDoneRef.current = false;
    pipelineStoppedRef.current = false;
    hadTerminalErrorRef.current = false;

    const baseUrl = getLegacyModernizationSseUrl(
      `/legacy-modernization/sse/events/${encodeURIComponent(runId)}`
    );
    const eventsUrl = `${baseUrl}?last_id=${encodeURIComponent(String(lastEventId))}`;

    let source: EventSource;
    try {
      source = new EventSource(eventsUrl);
    } catch {
      clearPersistedSseRun();
      return;
    }
    eventSourceRef.current = source;
    setStatus("running");
    addMessage(
      "system",
      kind === "codegen"
        ? "Reconnected to in-progress legacy code generation after refresh."
        : "Reconnected to in-progress legacy modernization after refresh.",
      kind === "codegen" ? "codegen_reconnected" : "reverse_reconnected"
    );

    source.addEventListener("pipeline", (ev) => {
      try {
        const msg = ev as MessageEvent;
        const parsedId = Number.parseInt(msg.lastEventId ?? "", 10);
        if (Number.isFinite(parsedId)) {
          updatePersistedLastEventId(runId, parsedId);
        }
        const event = JSON.parse(msg.data) as LegacyModernizationEvent;
        handleEvent(event);
        const terminalEvent =
          event.type === "done" ||
          event.type === "pipeline_complete" ||
          event.type === "error";
        if (terminalEvent) {
          clearPersistedSseRun();
        }
        if (event.type === "done") {
          source.close();
          if (eventSourceRef.current === source) eventSourceRef.current = null;
        }
      } catch {
        // Ignore malformed events.
      }
    });

    source.onerror = () => {
      if (seenDoneRef.current) {
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
        return;
      }
      // If the backend no longer knows this run (e.g. server was restarted),
      // the GET endpoint returns 404 which surfaces here as a connection
      // error.  Drop the persisted state so we don't keep retrying forever.
      addMessage(
        "system",
        "Lost SSE connection to the in-progress legacy modernization run. It may have finished, failed, or the server was restarted. Use the history view to inspect the run.",
        kind === "codegen" ? "codegen_reconnect_failed" : "reverse_reconnect_failed"
      );
      clearPersistedSseRun();
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      setStatus("idle");
    };
    // We intentionally run this only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    messages,
    fileTree,
    fileCount,
    currentPhase,
    generatingFiles,
    completedFiles,
    manifest,
    summary,
    roadmap,
    roadmapStatus,
    roadmapNotes: roadmapNotes || null,
    techstack,
    techstackStatus,
    techstackNotes: techstackNotes || null,
    sourceStack,
    sourceStackStatus,
    sourceStackNotes: sourceStackNotes || null,
    openQuestions,
    openQuestionsSuggested,
    openQuestionsStatus,
    phaseProgress,
    phaseTimings,
    pipelineStartTime,
    analysisMetrics,
    startModernization,
    sendChat,
    startCodeGeneration,
    generateSpecs,
    refreshFileTree,
    loadRunFromHistory,
    fetchFileContent,
    saveFile,
    applyAIChange,
    applyChatCodebaseChange,
    approveChatCodebaseChange,
    rejectChatCodebaseChange,
    resetState,
    submitOpenQuestionAnswers,
    skipOpenQuestions,
  };
}
