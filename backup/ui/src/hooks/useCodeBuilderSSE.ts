"use client";

/**
 * SSE-based hook for the Code Builder pipeline.
 *
 * Replaces the WebSocket hook with Server-Sent Events:
 *  - POST /cb-api/sse/start           → kicks off pipeline, returns { run_id }
 *  - GET  /cb-api/sse/events/{run_id} → text/event-stream (auto-reconnects)
 *  - POST /cb-api/sse/confirm/{run_id}→ send user confirmation
 *  - GET  /cb-api/sse/runs            → list active runs (explorer sidebar)
 *
 * Benefits over WebSocket:
 *  - Survives page navigation — just re-subscribe with ?last_id=
 *  - No proxy/CDN config needed (plain HTTP GET)
 *  - Browser-native auto-reconnect via EventSource
 *  - Zero socket lifecycle management
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CBv2PipelineEvent,
  CBv2ChatMessage,
  CBv2FileNode,
  CBv2GenerationStatus,
  CBv2ChatContext,
} from "@/types/code-builder-v2";
import { authFetch, getToken } from "@/lib/auth";

// Use direct backend URL — Next.js rewrites don't work with output:"standalone" + next start
const API_BASE = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";

/** Helper: build headers with JWT Authorization for Code Builder API calls. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// ── Active run type for explorer sidebar ─────────────────────────────────
export interface SSEActiveRun {
  run_id: string;
  pipeline_type: string;
  project_name: string;
  project_id: number | null;
  output_dir: string;
  started_at: number;
  done: boolean;
  event_count: number;
}

interface UseCodeBuilderSSEReturn {
  status: CBv2GenerationStatus;
  messages: CBv2ChatMessage[];
  fileTree: CBv2FileNode[];
  fileCount: number;
  currentPhase: string;
  generatingFiles: string[];
  completedFiles: string[];
  fileActions: Record<string, string>;
  manifest: Array<{ path: string; description: string }>;
  summary: Record<string, unknown> | null;
  runId: string;
  outputDir: string;
  pipelineType: string;
  pendingConfirmation: boolean;
  awaitingUserInput: boolean;
  sessionId: number | null;

  startGeneration: (description: string, projectName?: string, context?: CBv2ChatContext) => void;
  answerPendingInput: (text: string) => Promise<void>;
  sendConfirmation: (approved: boolean, selectedTaskIds?: string[]) => void;
  /** Cancel the in-flight pipeline run (Stop Generation). */
  cancelRun: () => Promise<void>;
  /** Resolve a `batch_review_required` event with bulk or per-file decisions. */
  respondBatchReview: (decision: { acceptAll?: boolean; rejectAll?: boolean; fileDecisions?: Array<{ file_path: string; approved: boolean }> }) => Promise<void>;
  runTasksSubset: (taskIds: string[]) => Promise<{ ok: boolean; detail?: string }>;
  refreshFileTree: () => Promise<string | null>;
  /** Save a generated file from the editor */
  saveFile: (path: string, content: string) => Promise<boolean>;
  loadRunFiles: (runId: string, pipelineType?: string) => Promise<void>;
  /** Load files for a historical run by downloading the run's ZIP and
   * unpacking it client-side. Used by the History panel's "View Files"
   * action so completed runs whose on-disk workspace has been cleaned up
   * still expose their generated artefacts in the explorer. */
  loadRunFilesFromZip: (runId: string, pipelineType?: string) => Promise<{ ok: boolean; fileCount: number; error?: string }>;
  fetchFileContent: (path: string) => Promise<{ content: string; language: string; originalContent?: string; fileAction?: string } | null>;
  /** Re-subscribe to an existing run (e.g. after page navigation) */
  resumeRun: (runId: string) => void;
  /** List all active/recent runs */
  fetchActiveRuns: () => Promise<SSEActiveRun[]>;
  /** Reset session state — call when project changes to start fresh */
  resetSession: () => void;
  /** Explicitly create a new session for a project (called on project open). */
  createNewSession: (projectId: number, projectName: string, pipelineType?: string) => Promise<number | null>;
  /** Clear chat history for the active session (server-side + local state).
   * Pass `{ deleteArtifacts: true }` to also remove the session's run dirs. */
  clearHistory: (opts?: { deleteArtifacts?: boolean }) => Promise<void>;
  /** Load messages from an existing session and restore its file tree */
  loadSession: (sessionId: number, lastOutputDir?: string | null, lastRunId?: string | null) => Promise<void>;
  onWorkspaceUpdated: React.MutableRefObject<(() => void) | null>;
}

let msgId = 0;
function makeId() {
  msgId += 1;
  return `cbv2-sse-${msgId}-${Date.now()}`;
}

type PendingInputState =
  | {
      kind: "intake";
      questions: Array<{ id: string; question: string }>;
    }
  | {
      kind: "clarify";
      options: string[];
      conflicts: Array<Record<string, unknown>>;
    };

type PendingApprovalState =
  | { kind: "plan" }
  | { kind: "file"; taskId: number; filePath: string };

interface PendingDiffEntry {
  taskId: number;
  filePath: string;
  action: string;
  original: string;
  proposed: string;
  description: string;
  language: string;
}

const V3_SSE_EVENT_NAMES = [
  "run_started",
  "intake_screening",
  "intake_stream",
  "intake_questions",
  "intake_response_received",
  "intake_complete",
  "validating",
  "validating_stream",
  "validation_result",
  "validation_conflict",
  "clarification_received",
  "compacting",
  "compaction_complete",
  "kb_build_started",
  "kb_build_complete",
  "kb_build_failed",
  "reasoning",
  "planning",
  "planning_stream",
  "planning_complete",
  "approval_required",
  "approval_received",
  "task_started",
  "task_stream",
  "task_complete",
  "file_diff_pending",
  "file_change_proposed",
  "batch_review_required",
  "batch_review_received",
  "batch_reverted",
  "file_skipped",
  "file_created",
  "file_modified",
  "file_deleted",
  "file_applied",
  "plan_compliance",
  "task_verify_started",
  "task_verify_finding",
  "task_verify_complete",
  "task_repair_started",
  "task_repair_failed",
  "remediation_started",
  "remediation_stream",
  "remediation_pass_complete",
  "remediation_budget_extended",
  "remediation_stagnated",
  "remediation_giveup",
  "remediation_complete",
  "security_scan_complete",
  "architecture_review_complete",
  "qa_review_complete",
  "review_started",
  "review_stream",
  "review_complete",
  "pipeline_complete",
  "error",
  "cancelled",
  "done",
];

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const byExt: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    java: "java",
    go: "go",
    rs: "rust",
    cs: "csharp",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    sh: "shell",
    ps1: "powershell",
  };
  return byExt[ext] || "text";
}

function countTreeFiles(nodes: CBv2FileNode[]): number {
  return nodes.reduce((total, node) => {
    if (node.type === "file") return total + 1;
    return total + countTreeFiles(node.children || []);
  }, 0);
}

function sortTreeNodes(nodes: CBv2FileNode[]): void {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) {
    if (node.children) sortTreeNodes(node.children);
  }
}

function upsertPendingFileNode(tree: CBv2FileNode[], filePath: string): void {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length === 0) return;

  let cursor = tree;
  let currentPath = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const isLeaf = index === parts.length - 1;
    const expectedType = isLeaf ? "file" : "folder";
    let nextNode = cursor.find((node) => node.path === currentPath && node.type === expectedType);

    if (!nextNode) {
      nextNode = {
        name: part,
        path: currentPath,
        type: expectedType,
        ...(isLeaf ? {} : { children: [] }),
      };
      cursor.push(nextNode);
    }

    if (!isLeaf) {
      nextNode.children = nextNode.children || [];
      cursor = nextNode.children;
    }
  }
}

function mergePendingDiffsIntoTree(
  baseTree: CBv2FileNode[],
  pendingDiffs: Record<string, PendingDiffEntry>,
): CBv2FileNode[] {
  const merged = JSON.parse(JSON.stringify(baseTree || [])) as CBv2FileNode[];
  for (const filePath of Object.keys(pendingDiffs)) {
    upsertPendingFileNode(merged, filePath);
  }
  sortTreeNodes(merged);
  return merged;
}

// ── Helpers used by loadRunFilesFromZip ────────────────────────────────
function buildTreeFromPaths(paths: string[]): CBv2FileNode[] {
  const tree: CBv2FileNode[] = [];
  for (const p of paths) {
    if (!p) continue;
    upsertPendingFileNode(tree, p);
  }
  sortTreeNodes(tree);
  return tree;
}

const _LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", pyi: "python",
  java: "java", kt: "kotlin", go: "go", rs: "rust", rb: "ruby",
  cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", hpp: "cpp",
  swift: "swift", php: "php", scala: "scala", sh: "shell", bash: "shell",
  ps1: "powershell", yml: "yaml", yaml: "yaml", json: "json", xml: "xml",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", sql: "sql", toml: "toml",
  ini: "ini", env: "ini", dockerfile: "dockerfile", makefile: "makefile",
  vue: "vue", svelte: "svelte",
};

function languageFromPath(path: string): string {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() || lower;
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = base.slice(dot + 1);
  return _LANGUAGE_BY_EXT[ext] || "plaintext";
}

function isProbablyBinary(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|tar|gz|tgz|bz2|7z|rar|exe|dll|so|dylib|class|jar|war|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|mkv)$/i.test(name);
}

function buildIntakeAnswers(
  questions: Array<{ id: string; question: string }>,
  rawAnswer: string,
): Array<{ id: string; question: string; answer: string }> {
  const trimmed = rawAnswer.trim();
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*\d.)\s]+/, ""))
    .filter(Boolean);

  if (questions.length <= 1) {
    const first = questions[0] || { id: "clarification", question: "Clarification" };
    return [{ id: first.id, question: first.question, answer: trimmed }];
  }

  return questions.map((question, index) => ({
    id: question.id,
    question: question.question,
    answer: lines[index] || (index === 0 ? trimmed : ""),
  }));
}

export function useCodeBuilderSSE(): UseCodeBuilderSSEReturn {
  const [status, setStatus] = useState<CBv2GenerationStatus>("idle");
  const [messages, setMessages] = useState<CBv2ChatMessage[]>([]);
  const [fileTree, setFileTree] = useState<CBv2FileNode[]>([]);
  const [fileCount, setFileCount] = useState(0);
  const [currentPhase, setCurrentPhase] = useState("");
  const [generatingFiles, setGeneratingFiles] = useState<string[]>([]);
  const [completedFiles, setCompletedFiles] = useState<string[]>([]);
  const [fileActions, setFileActions] = useState<Record<string, string>>({});
  const [pipelineType, setPipelineType] = useState<string>("greenfield");
  const [manifest, setManifest] = useState<Array<{ path: string; description: string }>>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [runId, setRunId] = useState<string>("");
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [awaitingUserInput, setAwaitingUserInput] = useState(false);
  const [outputDirState, setOutputDirState] = useState<string>("");
  const [sessionId, setSessionId] = useState<number | null>(null);

  const outputDirRef = useRef<string>("");
  const runIdRef = useRef<string>("");
  const sessionIdRef = useRef<number | null>(null);
  const fileTreeRef = useRef<CBv2FileNode[]>([]);
  const pendingInputRef = useRef<PendingInputState | null>(null);
  const pendingApprovalRef = useRef<PendingApprovalState | null>(null);
  const pendingDiffsRef = useRef<Record<string, PendingDiffEntry>>({});
  // Virtual filesystem populated by loadRunFilesFromZip. Keyed by file path
  // (forward-slash, relative to zip root). When set, the explorer and
  // fetchFileContent serve content from here instead of hitting the API.
  const virtualZipFilesRef = useRef<Map<string, string> | null>(null);
  const lastPlanRef = useRef<Record<string, unknown> | null>(null);
  const onWorkspaceUpdated = useRef<(() => void) | null>(null);
  const statusRef = useRef<CBv2GenerationStatus>("idle");
  const pipelineTypeRef = useRef<string>("greenfield");
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseRetryRef = useRef<number>(0);

  /** User-friendly message when the Code Builder backend is unreachable or saturated. */
  const BUSY_MESSAGE =
    "Code Builder portal is busy due to high traffic. Please wait a moment and try again.";

  /** Translate raw network/HTTP failures into a friendly message for the chat. */
  function _friendlyBackendError(status: number | null, raw: string): string {
    if (status === 0 || status === null) return BUSY_MESSAGE;       // network unreachable
    if (status === 429) return BUSY_MESSAGE;                          // rate-limited
    if (status === 503 || status === 504) return BUSY_MESSAGE;        // overloaded / gateway timeout
    if (status >= 500) return BUSY_MESSAGE;                           // any other 5xx
    return raw || "Unknown error";
  }
  const lastEventIdRef = useRef<number>(-1);

  statusRef.current = status;
  pipelineTypeRef.current = pipelineType;

  useEffect(() => {
    fileTreeRef.current = fileTree;
    setFileCount(countTreeFiles(fileTree));
  }, [fileTree]);

  // ── Add a chat message ────────────────────────────────────────────────
  const addMessage = useCallback(
    (role: CBv2ChatMessage["role"], content: string, eventType?: string, data?: Record<string, unknown>) => {
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role, content, timestamp: Date.now(), eventType, data },
      ]);
    },
    []
  );

  // ── Refresh file tree from REST API ───────────────────────────────────
  const refreshFileTree = useCallback(async (): Promise<string | null> => {
    try {
      const params = new URLSearchParams();
      if (runIdRef.current) params.set("run_id", runIdRef.current);
      if (outputDirRef.current) params.set("output_dir", outputDirRef.current);
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/files${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
      const data = await res.json();
      setFileTree(mergePendingDiffsIntoTree(data.tree || [], pendingDiffsRef.current));
      if (data.pipeline_type) setPipelineType(data.pipeline_type);
      return data.error || null;
    } catch {
      return null;
    }
  }, []);

  // ── Load files for a specific historical run ──────────────────────────
  const loadRunFiles = useCallback(
    async (historicalRunId: string, historicalPipelineType?: string) => {
      runIdRef.current = historicalRunId;
      outputDirRef.current = "";
      setOutputDirState("");
      setRunId(historicalRunId);
      if (historicalPipelineType) setPipelineType(historicalPipelineType);
      // Drop any virtual ZIP cache from a previous "view files" action so
      // a live run isn't mixed with historical content.
      virtualZipFilesRef.current = null;
      await refreshFileTree();
    },
    [refreshFileTree]
  );

  // ── Load files for a historical run by downloading + unzipping ─────────
  // History panel "View Files" uses this so completed runs whose on-disk
  // workspace has been cleaned/expired still expose their artefacts in the
  // explorer. We hit the same /runs/{run_id}/download endpoint the "Download
  // ZIP" button uses, unpack the archive in the browser, build a virtual
  // file tree from the entries, and serve subsequent fetchFileContent calls
  // from the in-memory cache.
  const loadRunFilesFromZip = useCallback(
    async (historicalRunId: string, historicalPipelineType?: string) => {
      try {
        runIdRef.current = historicalRunId;
        outputDirRef.current = "";
        setOutputDirState("");
        setRunId(historicalRunId);
        if (historicalPipelineType) setPipelineType(historicalPipelineType);

        const res = await authFetch(
          `${API_BASE}/runs/${encodeURIComponent(historicalRunId)}/download`
        );
        if (!res.ok) {
          // Try to surface the backend's error message (404 body is JSON).
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body && typeof body.error === "string") detail = body.error;
          } catch {
            /* non-JSON body */
          }
          return { ok: false, fileCount: 0, error: detail };
        }
        const blob = await res.blob();
        if (blob.size === 0) {
          return {
            ok: false,
            fileCount: 0,
            error: "The server returned an empty archive for this run.",
          };
        }
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(blob);

        const cache = new Map<string, string>();
        const paths: string[] = [];
        const entries = Object.values(zip.files);
        await Promise.all(
          entries.map(async (entry) => {
            // JSZip exposes `dir` for folder entries — skip them.
            if ((entry as { dir?: boolean }).dir) return;
            const path = entry.name.replace(/\\/g, "/");
            if (!path || path.endsWith("/")) return;
            paths.push(path);
            if (isProbablyBinary(path)) {
              cache.set(path, "// Binary file — preview not available in the editor.");
              return;
            }
            try {
              const text = await entry.async("string");
              cache.set(path, text);
            } catch {
              cache.set(path, "// Failed to decode file content.");
            }
          })
        );

        virtualZipFilesRef.current = cache;
        const tree = buildTreeFromPaths(paths);
        setFileTree(mergePendingDiffsIntoTree(tree, pendingDiffsRef.current));
        setFileCount(paths.length);
        if (paths.length === 0) {
          // Valid ZIP, just empty (rare — the backend now 404s on empty
          // runs, but older deployments may still stream an empty archive).
          return {
            ok: false,
            fileCount: 0,
            error: "This run produced no files.",
          };
        }
        return { ok: true, fileCount: paths.length };
      } catch (err) {
        virtualZipFilesRef.current = null;
        return { ok: false, fileCount: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },
    []
  );

  // ── Fetch single file content ─────────────────────────────────────────
  const fetchFileContent = useCallback(
    async (path: string): Promise<{ content: string; language: string; originalContent?: string; fileAction?: string } | null> => {
      const pending = pendingDiffsRef.current[path];
      if (pending) {
        return {
          content: pending.action === "delete" ? "" : pending.proposed,
          language: pending.language,
          originalContent: pending.original,
          fileAction: pending.action,
        };
      }

      // Historical "View Files" path — serve from the unpacked ZIP cache
      // populated by loadRunFilesFromZip. This avoids hitting the workspace
      // file endpoint, whose on-disk artefacts may have been cleaned up.
      const virtual = virtualZipFilesRef.current;
      if (virtual && virtual.has(path)) {
        return {
          content: virtual.get(path) || "",
          language: languageFromPath(path),
          fileAction: fileActions[path],
        };
      }

      try {
        const params = new URLSearchParams();
        if (runIdRef.current) params.set("run_id", runIdRef.current);
        if (outputDirRef.current) params.set("output_dir", outputDirRef.current);
        const qs = params.toString();
        const res = await fetch(`${API_BASE}/files/${encodeURIComponent(path)}${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
        if (!res.ok) return null;
        const data = await res.json();
        return {
          content: data.content,
          language: data.language,
          fileAction: fileActions[path],
        };
      } catch {
        return null;
      }
    },
    [fileActions]
  );

  // ── Handle a pipeline event (shared by start + resume) ────────────────
  const handleEvent = useCallback(
    (event: CBv2PipelineEvent) => {
      const t = event.type;

      switch (t) {
        case "run_started": {
          const data = event as Record<string, unknown>;
          const nextPipelineType = String(data.pipeline_type || "greenfield");
          setPipelineType(nextPipelineType);
          addMessage("assistant", "Pipeline initialized. Agents starting...", "pipeline_started", data);
          setStatus("running");
          break;
        }

        case "kb_build_started": {
          // Brownfield / follow-up runs trigger an inline Knowledge Base
          // build (analyzer scan of .devaccel/spec/) before planning.
          // Surface a friendly progress message so the chat doesn't look
          // frozen between "Connected — applying changes…" and the first
          // planning event.
          const msg = String((event as any).message
            || "Preparing the Knowledge Base for the selected project. Please wait…");
          setCurrentPhase("Preparing Knowledge Base");
          setStatus("running");
          addMessage("system", msg, "kb_build_started", event as Record<string, unknown>);
          break;
        }

        case "kb_build_complete": {
          const msg = String((event as any).message
            || "Knowledge Base is ready. Continuing with your requested changes…");
          setCurrentPhase("Knowledge Base ready");
          addMessage("system", msg, "kb_build_complete", event as Record<string, unknown>);
          break;
        }

        case "kb_build_failed": {
          const msg = String((event as any).message
            || "Knowledge Base preparation failed — continuing without codebase context. Results may be less accurate.");
          addMessage("system", msg, "kb_build_failed", event as Record<string, unknown>);
          break;
        }

        case "intake_screening": {
          setCurrentPhase(String((event as any).message || "Screening request..."));
          break;
        }

        case "intake_questions": {
          const rawQuestions = Array.isArray((event as any).questions) ? (event as any).questions : [];
          const questions = rawQuestions.map((question: any, index: number) => ({
            id: String(question?.id || `question_${index + 1}`),
            question: String(question?.question || question?.id || `Question ${index + 1}`),
          }));
          pendingInputRef.current = { kind: "intake", questions };
          setAwaitingUserInput(true);
          setStatus("idle");
          setCurrentPhase("Awaiting clarification");
          const lines = questions.map((question: { id: string; question: string }, index: number) => `${index + 1}. ${question.question}`);
          addMessage(
            "assistant",
            [
              "Before I generate `planning.md`, I need a bit more detail:",
              "",
              ...lines,
              "",
              "Reply in one message. If there are multiple questions, answer them in order on separate lines.",
              "Type `cancel` to stop this run.",
            ].join("\n"),
            "clarification_needed",
            { questions },
          );
          break;
        }

        case "intake_response_received": {
          setAwaitingUserInput(false);
          setStatus("running");
          setCurrentPhase("Validating clarified request...");
          addMessage("system", "Clarification received. Continuing to validation...");
          break;
        }

        case "validating": {
          setCurrentPhase(String((event as any).message || "Validating your request..."));
          break;
        }

        case "validation_result": {
          if ((event as any).valid === false) {
            pendingInputRef.current = { kind: "clarify", options: [], conflicts: [] };
            setAwaitingUserInput(true);
            setStatus("idle");
            setCurrentPhase("Awaiting clarification");
            addMessage(
              "assistant",
              [
                String((event as any).clarification || (event as any).reasoning || "Could you clarify your request?"),
                "",
                "Reply with the missing detail in one message, or type `cancel` to stop this run.",
              ].join("\n"),
              "clarification_needed",
              event as Record<string, unknown>,
            );
          }
          break;
        }

        case "validation_conflict": {
          const options = Array.isArray((event as any).options) ? ((event as any).options as string[]) : [];
          const conflicts = Array.isArray((event as any).conflicts) ? ((event as any).conflicts as Array<Record<string, unknown>>) : [];
          pendingInputRef.current = { kind: "clarify", options, conflicts };
          setAwaitingUserInput(true);
          setStatus("idle");
          setCurrentPhase("Awaiting direction");
          const conflictLines = conflicts.map((conflict) => {
            const topic = String(conflict.topic || "conflict");
            const userSays = String(conflict.user_says || "");
            const sourceSays = String(conflict.source_says || "");
            return `- ${topic}: you asked for \`${userSays}\`, but the source of truth says \`${sourceSays}\``;
          });
          const optionLines = options.map((option, index) => `${index + 1}. ${option}`);
          addMessage(
            "assistant",
            [
              "Your request conflicts with the current project context.",
              "",
              ...conflictLines,
              ...(optionLines.length > 0 ? ["", "Reply with the direction to follow:", ...optionLines] : []),
              "",
              "Type your chosen direction in one message, or `cancel` to stop this run.",
            ].join("\n"),
            "clarification_needed",
            { conflicts, options },
          );
          break;
        }

        case "clarification_received": {
          setAwaitingUserInput(false);
          setStatus("running");
          setCurrentPhase("Generating plan...");
          addMessage("system", "Direction received. Continuing to planning...");
          break;
        }

        case "compacting": {
          setCurrentPhase(String((event as any).message || "Optimising context for the model..."));
          break;
        }

        case "compaction_complete": {
          const data = event as any;
          addMessage(
            "system",
            `Context optimized — ${data.before_tokens || 0} → ${data.after_tokens || 0} tokens`,
            "context_compacted",
            data,
          );
          break;
        }

        case "planning": {
          setCurrentPhase(String((event as any).message || "Generating plan..."));
          break;
        }

        case "planning_complete": {
          lastPlanRef.current = event as Record<string, unknown>;
          setCurrentPhase("Awaiting plan approval");
          break;
        }

        case "approval_required": {
          const plan = lastPlanRef.current || {};
          pendingApprovalRef.current = { kind: "plan" };
          setPendingConfirmation(true);
          addMessage(
            "assistant",
            "**Execution Plan**\n\nReview the plan before any files are changed.",
            "plan_approval_required",
            {
              needs_confirmation: true,
              plan_approval: true,
              plan_content: String(plan.planning_md || (event as any).planning_md || ""),
              tasks: Array.isArray(plan.tasks) ? plan.tasks : [],
              selected_stories: Array.isArray(plan.selected_stories) ? plan.selected_stories : [],
              selected_documents: Array.isArray(plan.selected_documents) ? plan.selected_documents : [],
            },
          );
          break;
        }

        case "approval_received": {
          setPendingConfirmation(false);
          pendingApprovalRef.current = null;
          break;
        }

        case "task_started": {
          const title = String((event as any).title || "Executing task");
          setCurrentPhase(title);
          addMessage("assistant", title, "phase", { label: title });
          break;
        }

        case "file_diff_pending": {
          const filePath = String((event as any).file_path || "");
          const action = String((event as any).action || "modify").toLowerCase();
          const original = String((event as any).original || "");
          const proposed = String((event as any).proposed || "");
          const taskId = Number((event as any).task_id ?? 0);
          const description = String((event as any).description || "");
          const pendingEntry: PendingDiffEntry = {
            taskId,
            filePath,
            action,
            original,
            proposed,
            description,
            language: inferLanguage(filePath),
          };
          pendingDiffsRef.current[filePath] = pendingEntry;
          pendingApprovalRef.current = { kind: "file", taskId, filePath };
          setPendingConfirmation(true);
          setGeneratingFiles((prev) => [...new Set([...prev, filePath])]);
          setFileActions((prev) => ({ ...prev, [filePath]: action }));
          setFileTree((prev) => mergePendingDiffsIntoTree(prev, pendingDiffsRef.current));
          addMessage(
            "assistant",
            `**Review change** — ${action.toUpperCase()} \`${filePath}\``,
            "file_diff_approval_required",
            {
              needs_confirmation: true,
              file_diff_approval: true,
              task_id: taskId,
              file_path: filePath,
              action,
              old_content: original,
              new_content: proposed,
              language: pendingEntry.language,
              step_summary: description,
            },
          );
          break;
        }

        case "file_skipped": {
          const filePath = String((event as any).file_path || "");
          delete pendingDiffsRef.current[filePath];
          pendingApprovalRef.current = null;
          setPendingConfirmation(false);
          setGeneratingFiles((prev) => prev.filter((path) => path !== filePath));
          addMessage("assistant", `**Skipped** \`${filePath}\` — ${String((event as any).reason || "rejected by user")}`, "file_rejected");
          refreshFileTree();
          break;
        }

        case "file_change_proposed": {
          // Copilot-style batch mode: file is already on disk; just
          // surface it in the live pending changes panel.
          const filePath = String((event as any).file_path || "");
          const action = String((event as any).action || "modify").toLowerCase();
          setGeneratingFiles((prev) => [...new Set([...prev, filePath])]);
          setFileActions((prev) => ({ ...prev, [filePath]: action }));
          refreshFileTree();
          break;
        }

        case "batch_review_required": {
          const data = event as any;
          if (data.quality_passed !== true) {
            addMessage(
              "system",
              "Generated changes are still under quality review. The review card will appear only after all checks pass.",
              "batch_review_deferred",
              data,
            );
            break;
          }
          const summary = data.summary || { created: 0, modified: 0, deleted: 0, total: 0 };
          const changes = data.changes || { created: [], modified: [], deleted: [] };
          pendingApprovalRef.current = { kind: "plan" }; // reuse pendingConfirmation flag
          setPendingConfirmation(true);
          addMessage(
            "assistant",
            `**Review Generated Changes**\n\n${summary.total} file(s): ${summary.created} created · ${summary.modified} modified · ${summary.deleted} deleted`,
            "batch_review_required",
            {
              needs_confirmation: true,
              batch_review: true,
              summary,
              changes,
            },
          );
          break;
        }

        case "batch_review_received": {
          setPendingConfirmation(false);
          pendingApprovalRef.current = null;
          const data = event as any;
          addMessage(
            "system",
            `Decision recorded — ${Number(data.approved_count || 0)} approved, ${Number(data.rejected_count || 0)} reverted.`,
            "batch_review_received",
            data,
          );
          break;
        }

        case "batch_reverted": {
          const data = event as any;
          const files: string[] = Array.isArray(data.files) ? data.files : [];
          for (const fp of files) {
            setCompletedFiles((prev) => prev.filter((p) => p !== fp));
            setFileActions((prev) => {
              const next = { ...prev };
              delete next[fp];
              return next;
            });
          }
          if (files.length > 0) {
            addMessage("system", `Reverted ${files.length} file(s) on disk.`, "batch_reverted", data);
          }
          refreshFileTree();
          break;
        }

        case "task_verify_started": {
          const data = event as any;
          const attempt = Number(data.attempt || 1);
          if (attempt > 1) {
            addMessage(
              "system",
              `Verifying task ${data.task_id} (attempt ${attempt})…`,
              "task_verify_started",
              data,
            );
          }
          break;
        }

        case "task_verify_complete": {
          const data = event as any;
          if (data.ok) {
            addMessage(
              "system",
              `Task ${data.task_id} verified clean (${data.warning_count || 0} warnings).`,
              "task_verify_complete",
              data,
            );
          } else {
            addMessage(
              "system",
              `Task ${data.task_id} verification: ${data.error_count} error(s), ${data.warning_count} warning(s).`,
              "task_verify_complete",
              data,
            );
          }
          break;
        }

        case "task_repair_started": {
          const data = event as any;
          addMessage(
            "assistant",
            `Auto-repair pass ${data.attempt} for task ${data.task_id} — fixing ${data.error_count} error(s).`,
            "task_repair_started",
            data,
          );
          break;
        }

        case "task_repair_failed": {
          const data = event as any;
          addMessage(
            "system",
            `Auto-repair gave up on task ${data.task_id} after ${data.attempts} attempt(s).`,
            "task_repair_failed",
            data,
          );
          break;
        }

        case "remediation_started": {
          const data = event as any;
          const targetCount = Array.isArray(data.target_files) ? data.target_files.length : 0;
          addMessage(
            "assistant",
            `Quality checks found blocking issues. Auto-remediation pass ${data.attempt}/${data.max_attempts} is updating ${targetCount} file(s) before review is shown.`,
            "remediation_started",
            data,
          );
          break;
        }

        case "remediation_budget_extended": {
          const data = event as any;
          addMessage(
            "system",
            `Auto-remediation budget extended to ${data.new_max} pass(es): ${String(data.rationale || "more fixes required")}`,
            "remediation_budget_extended",
            data,
          );
          break;
        }

        case "remediation_pass_complete": {
          const data = event as any;
          const filesRepaired = Number(data.files_repaired || 0);
          const remainingIssues = Number(data.blocking_issues_count || 0);
          const updatedText = filesRepaired === 1 ? "1 file" : `${filesRepaired} files`;
          const remainingText = remainingIssues === 1 ? "1 blocking issue" : `${remainingIssues} blocking issues`;
          addMessage(
            "assistant",
            filesRepaired > 0
              ? `Auto-remediation pass ${data.attempt} updated ${updatedText}. ${remainingText} remain.`
              : `Auto-remediation pass ${data.attempt} made no file changes. ${remainingText} remain.`,
            "remediation_pass_complete",
            data,
          );
          refreshFileTree();
          break;
        }

        case "remediation_stagnated": {
          const data = event as any;
          addMessage(
            "system",
            `Auto-remediation detected stalled fixes after pass ${data.attempt}; switching to full file regeneration.`,
            "remediation_stagnated",
            data,
          );
          break;
        }

        case "remediation_giveup": {
          const data = event as any;
          addMessage(
            "system",
            `Auto-remediation stopped before review because ${Number(data.blocking_issues_count || 0)} blocking issue(s) remain (${String(data.reason || "not passed")}).`,
            "remediation_giveup",
            data,
          );
          refreshFileTree();
          break;
        }

        case "remediation_complete": {
          const data = event as any;
          addMessage(
            "assistant",
            `Auto-remediation complete after ${Number(data.attempts || 0)} pass(es). Final generated files are updated and ready for review.`,
            "remediation_complete",
            data,
          );
          refreshFileTree();
          break;
        }

        case "security_scan_complete":
        case "architecture_review_complete":
        case "qa_review_complete": {
          const data = event as any;
          const eventName = String((event as any).event || "");
          const label = String(data.label || eventName);
          const report = data.report || {};
          const findings: any[] = report.findings || report.blocking_issues || [];
          const approved = report.approved !== false && report.deliverable_status !== "needs_fix" && report.deliverable_status !== "blocked";
          const summary = report.summary || (approved ? "Looks good." : "Issues found.");
          addMessage(
            "assistant",
            `**${label.replace(/_/g, " ")}**: ${summary}`,
            eventName,
            { quality: true, label, report, findings, approved },
          );
          break;
        }

        case "file_created": {
          const filePath = String((event as any).file_path || "");
          delete pendingDiffsRef.current[filePath];
          setGeneratingFiles((prev) => prev.filter((path) => path !== filePath));
          setCompletedFiles((prev) => [...new Set([...prev, filePath])]);
          setFileActions((prev) => ({ ...prev, [filePath]: "create" }));
          addMessage("assistant", `Created \`${filePath}\``, "file_written", { action: "create" });
          refreshFileTree();
          break;
        }

        case "file_modified": {
          const filePath = String((event as any).file_path || "");
          delete pendingDiffsRef.current[filePath];
          setGeneratingFiles((prev) => prev.filter((path) => path !== filePath));
          setCompletedFiles((prev) => [...new Set([...prev, filePath])]);
          setFileActions((prev) => ({ ...prev, [filePath]: "modify" }));
          addMessage("assistant", `Updated \`${filePath}\``, "file_written", { action: "modify" });
          refreshFileTree();
          break;
        }

        case "file_deleted": {
          const filePath = String((event as any).file_path || "");
          delete pendingDiffsRef.current[filePath];
          setGeneratingFiles((prev) => prev.filter((path) => path !== filePath));
          setCompletedFiles((prev) => [...new Set([...prev, filePath])]);
          setFileActions((prev) => ({ ...prev, [filePath]: "delete" }));
          addMessage("assistant", `Removed \`${filePath}\``, "file_written", { action: "delete" });
          refreshFileTree();
          break;
        }

        case "plan_compliance": {
          if ((event as any).status === "drift") {
            const missing = Array.isArray((event as any).missing) ? (event as any).missing.length : 0;
            const extra = Array.isArray((event as any).extra) ? (event as any).extra.length : 0;
            addMessage("system", `Plan compliance check found drift — missing ${missing}, extra ${extra}.`, "warning");
          }
          break;
        }

        case "review_started": {
          addMessage("assistant", "Reviewing generated changes...", "review_start");
          break;
        }

        case "review_complete": {
          const issues = Array.isArray((event as any).issues) ? (event as any).issues : [];
          const summaryText = String((event as any).summary || "Review complete");
          if (issues.length > 0) {
            const issueList = issues
              .map((issue: any) => `  \`${String(issue.file || "(global)")}\`: ${String(issue.message || issue.description || issue.issue || "Issue found")}`)
              .join("\n");
            addMessage("assistant", `**Code Review**: ${summaryText}\n\n${issueList}`, "review_complete");
          } else {
            addMessage("assistant", `**Code Review**: ${summaryText}`, "review_complete");
          }
          break;
        }

        case "pipeline_complete": {
          const data = event as any;
          setSummary(data);
          addMessage(
            "assistant",
            `**Pipeline Complete**\n\n${Number(data.total_files || 0)} file(s) processed\n${String(data.summary || "")}`.trim(),
            "pipeline_complete",
            data,
          );
          refreshFileTree();
          break;
        }

        case "cancelled": {
          statusRef.current = "complete";
          setStatus("complete");
          setCurrentPhase("");
          setAwaitingUserInput(false);
          setPendingConfirmation(false);
          pendingInputRef.current = null;
          pendingApprovalRef.current = null;
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          addMessage("system", String((event as any).message || "Run cancelled by user."), "cancelled");
          break;
        }

        case "done": {
          statusRef.current = "complete";
          setStatus("complete");
          setCurrentPhase("");
          setAwaitingUserInput(false);
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          {
            const finalStatus = String((event as any).status || "complete");
            const summaryText = String((event as any).summary || "").trim();
            const doneMessage = finalStatus === "complete"
              ? "Generation complete. Workspace saved for this session — follow-up requests will continue editing these files. Use 'New Session' if you want a fresh workspace."
              : finalStatus === "validation_failed"
                ? `Pipeline paused — please reply with more detail to clarify your request, or start a new run.${summaryText ? ` ${summaryText}` : ""}`
                : finalStatus === "no_tasks"
                  ? `Run stopped — the planner could not derive any executable tasks. Please describe what to build with a bit more detail and start a new run.${summaryText ? ` ${summaryText}` : ""}`
                  : finalStatus === "cancelled_by_user" || finalStatus === "cancelled"
                    ? "Run cancelled."
                    : finalStatus === "blocked"
                      ? `Generation ended with blocking review issues. Pipeline not completed.${summaryText ? ` ${summaryText}` : ""}`
                      : `Generation ended with unresolved review issues. Pipeline not completed.${summaryText ? ` ${summaryText}` : ""}`;
            addMessage("system", doneMessage, "done", event as Record<string, unknown>);
          }
          refreshFileTree();
          onWorkspaceUpdated.current?.();
          break;
        }

        case "accepted": {
          const od = (event as any).output_dir ? String((event as any).output_dir) : "";
          if (od) {
            outputDirRef.current = od;
            setOutputDirState(od);
          }
          if ((event as any).run_id) {
            runIdRef.current = String((event as any).run_id);
            setRunId(String((event as any).run_id));
          }
          addMessage("system", event.message as string, t);
          break;
        }

        case "context_compacted": {
          const d = event as any;
          const notes = Array.isArray(d.notes) ? d.notes : [];
          const compactedStories = Number(d.compacted_story_count || 0) + Number(d.omitted_story_count || 0);
          const compactedDocuments = Number(d.compacted_document_count || 0) + Number(d.omitted_document_count || 0);
          const parts = ["**Context optimized** — ready for generation"];
          if (compactedStories > 0) parts.push(`Stories summarized: ${compactedStories}`);
          if (compactedDocuments > 0) parts.push(`Documents summarized: ${compactedDocuments}`);
          if (d.smart_context_compacted) parts.push("Existing codebase context summarized");
          if (notes.length > 0) parts.push(...notes);
          addMessage("system", parts.join("\n"), t, d);
          break;
        }

        case "pipeline_started":
          addMessage("assistant", "Pipeline initialized. Agents starting...", t, event as Record<string, unknown>);
          setStatus("running");
          break;

        case "phase":
          setCurrentPhase((event as any).label || (event as any).phase || "");
          addMessage("assistant", `${(event as any).label}`, t);
          break;

        case "thinking":
          addMessage("assistant", `${(event as any).message}`, t);
          break;

        case "reasoning": {
          // ReAct-style transparency from agents — show the chain of thought
          // so the user can see WHY the planner decided what it did.
          const e = event as any;
          const stack = e.tech_stack && Object.keys(e.tech_stack).length > 0
            ? `\n\n_Tech stack:_ ${Object.entries(e.tech_stack)
                .map(([layer, techs]) => `${layer}: ${(techs as string[]).join(", ")}`)
                .join(" • ")}`
            : "";
          const sources = Array.isArray(e.tech_sources) && e.tech_sources.length > 0
            ? `\n_Inferred from:_ ${e.tech_sources.join(", ")}`
            : "";
          addMessage("assistant", `🧠 ${e.message || "Reasoning..."}${stack}${sources}`, t, e);
          break;
        }

        case "clarification_needed": {
          // Hard stop — agent refused to hallucinate and asked for input.
          const e = event as any;
          const q = e.question ? `\n\n**${e.question}**` : "";
          addMessage("assistant", `❓ ${e.message || "I need more information to continue."}${q}`, t, e);
          statusRef.current = "error";
          setStatus("error");
          break;
        }

        case "manifest":
        case "manifest_updated": {
          const files = (event as any).files || [];
          const count = (event as any).count || files.length;
          setManifest(files);
          addMessage(
            "assistant",
            `**${count} files** planned\n\n${files.map((f: any) => `  • \`${f.path}\` — ${f.description}`).join("\n")}`,
            t
          );
          break;
        }

        case "approval":
          addMessage("assistant", `Manifest ${(event as any).status}`, t);
          break;

        case "folder_created":
          refreshFileTree();
          break;

        case "schedule_info":
          addMessage("assistant", `Scheduler: ${(event as any).total} files, max ${(event as any).max_concurrent} concurrent`, t);
          break;

        case "batch_start":
          addMessage(
            "assistant",
            `**Batch ${(event as any).batch}** — generating ${((event as any).files || []).length} file(s):\n${((event as any).files || []).map((f: string) => `  • \`${f}\``).join("\n")}`,
            t
          );
          break;

        case "file_start":
          setGeneratingFiles((prev) => [...prev.filter((f) => f !== (event as any).path), (event as any).path]);
          addMessage("assistant", `Generating \`${(event as any).path}\`...`, t);
          break;

        case "file_created":
          refreshFileTree();
          break;

        case "file_complete": {
          const fp = (event as any).path;
          const action = (event as any).action || "create";
          const actionLabel = action === "create" ? "Created" : action === "delete" ? "Removed" : "Updated";
          setGeneratingFiles((prev) => prev.filter((f) => f !== fp));
          setCompletedFiles((prev) => [...prev, fp]);
          setFileActions((prev) => ({ ...prev, [fp]: action }));
          addMessage("assistant", `${actionLabel} \`${fp}\``, t, { action });
          refreshFileTree();
          break;
        }

        case "batch_complete":
          addMessage("assistant", `Batch ${(event as any).batch} complete — ${(event as any).remaining} remaining`, t);
          break;

        case "dependency_found":
          addMessage("assistant", `Found ${(event as any).count} missing dependencies — adding to manifest`, t);
          break;

        case "generation_complete":
          addMessage("assistant", `Generation complete — **${(event as any).files_generated}** files generated`, t);
          break;

        case "review_complete": {
          const issues = (event as any).issues || [];
          const sum = (event as any).summary || "";
          if (issues.length > 0) {
            const issueList = issues.map((i: any) => `  \`${i.file}\`: ${i.description}`).join("\n");
            addMessage("assistant", `**Code Review**: ${sum}\n\n${issueList}`, t);
          } else {
            addMessage("assistant", `**Code Review**: ${sum}`, t);
          }
          break;
        }

        case "pipeline_complete": {
          const d = event as any;
          if (d.output_dir) {
            outputDirRef.current = String(d.output_dir);
            setOutputDirState(String(d.output_dir));
          }
          setSummary(d);
          if (d.pipeline_type === "brownfield") {
            setPipelineType("brownfield");
            // Do NOT wipe the file tree here — the explorer must stay
            // populated so the user sees existing files even before the
            // refresh roundtrip returns. The refresh below will reconcile
            // the tree against disk truth.
            setCompletedFiles([]);
            setFileActions({});
            addMessage(
              "assistant",
              `**Changes Applied**\n\n  ${d.files_generated} file(s) updated\n  ${d.total_files} total files in workspace\n  ${d.errors > 0 ? `${d.errors} error(s)` : "No errors"}`,
              t, d
            );
            refreshFileTree();
            onWorkspaceUpdated.current?.();
          } else {
            addMessage(
              "assistant",
              `**Generation Complete**\n\n  ${d.files_generated}/${d.files_planned} files generated\n  ${d.files_on_disk} files on disk\n  ${d.elapsed_s}s total\n  ${d.errors > 0 ? `${d.errors} error(s)` : "No errors"}\n` +
                (d.zip_size_kb ? `  ZIP: ${d.zip_size_kb} KB` : ""),
              t, d
            );
            refreshFileTree();
          }
          break;
        }

        case "workspace_updated": {
          const changed = (event as any).changed_files || [];
          if (changed.length > 0) addMessage("assistant", `Workspace synced — ${changed.length} file(s) updated`, t);
          onWorkspaceUpdated.current?.();
          break;
        }

        case "done":
          statusRef.current = "complete";
          setStatus("complete");
          // Close EventSource immediately to prevent auto-reconnect
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          if (pipelineTypeRef.current === "brownfield") {
            addMessage("system", "Changes applied to your workspace. Follow-up requests will keep editing the same files.", t);
          } else {
            addMessage("system", "Generation complete. Workspace saved for this session — follow-up requests will continue using these files.", t);
          }
          refreshFileTree();
          // Refresh workspace sources/analysis status (greenfield auto-KB creates a source)
          onWorkspaceUpdated.current?.();
          break;

        case "error":
          if ((event as any).error_code === "MODEL_CONFIG_MISSING") {
            addMessage(
              "assistant",
              `**LLM Model Not Configured**\n\n${(event as any).message}\n\nPlease go to **Project Settings > AI Models** and select a model for **Code Builder** before generating code.`,
              t, { error_code: "MODEL_CONFIG_MISSING" }
            );
            statusRef.current = "error";
            setStatus("error");
          } else if ((event as any).error_code === "CONTENT_FILTER") {
            addMessage("assistant", `**Content Safety Notice**\n\n${(event as any).message}`, t, { error_code: "CONTENT_FILTER" });
          } else {
            addMessage("assistant", `**Error**: ${(event as any).message}`, t);
          }
          break;

        case "warning":
          addMessage("assistant", `⚠️ ${(event as any).message}`, t);
          break;

        case "heartbeat":
          break;

        case "confirmation_required": {
          setPendingConfirmation(true);
          const proposed = (event as any).proposed_changes || [];
          const cSummary = (event as any).summary || "";
          const diffLines = proposed.map((c: any) => `  \`${c.file_path}\` — ${c.diff_summary || c.action}`).join("\n");
          addMessage("assistant", `**Proposed Changes**\n\n${cSummary ? cSummary + "\n\n" : ""}${diffLines}`, t, {
            proposed_changes: proposed, summary: cSummary, needs_confirmation: true,
          });
          break;
        }

        case "plan_approval_required": {
          setPendingConfirmation(true);
          const steps = (event as any).steps || (event as any).plan_steps || [];
          const pSummary = (event as any).summary || "";
          const planContent = (event as any).plan_content || "";
          const tasks = (event as any).tasks || [];
          const selectedStories = (event as any).selected_stories || [];
          const selectedDocuments = (event as any).selected_documents || [];
          addMessage("assistant", `**Execution Plan**\n\n${pSummary}`, t, {
            needs_confirmation: true, plan_approval: true, plan_steps: steps, plan_content: planContent,
            tasks, selected_stories: selectedStories, selected_documents: selectedDocuments,
          });
          break;
        }

        case "plan_ready": {
          const planLabel = (event as any).label || "Execution plan generated";
          addMessage("assistant", `**Plan Ready** — ${planLabel}`, t);
          refreshFileTree();
          break;
        }

        case "feasibility_confirmation_required": {
          setPendingConfirmation(true);
          const verdict = (event as any).verdict || "";
          const suggestions = ((event as any).suggestions || []) as string[];
          const suggestionLines = suggestions.length > 0
            ? `\n\n**Suggestions:**\n${suggestions.map((s: string) => `  • ${s}`).join("\n")}`
            : "";
          addMessage("assistant", `**Feasibility Concern**\n\n${verdict}${suggestionLines}`, t, { needs_confirmation: true });
          break;
        }

        case "file_diff_approval_required": {
          setPendingConfirmation(true);
          const d = event as any;
          const action = (d.action as string) || "modify";
          const fileIndex = d.file_index as number | undefined;
          const filesTotal = d.files_total as number | undefined;
          const progress = (fileIndex && filesTotal)
            ? `[${fileIndex}/${filesTotal}] `
            : "";
          const headline = d.summary
            || `${progress}${action.toUpperCase()} \`${d.file_path}\``;
          addMessage(
            "assistant",
            `**Review change** — ${headline}`,
            t,
            {
              needs_confirmation: true,
              file_diff_approval: true,
              file_path: d.file_path,
              action,
              diff: d.diff || "",
              diff_summary: d.diff_summary || "",
              old_content: d.old_content || "",
              new_content: d.new_content || "",
              language: d.language || "text",
              file_index: fileIndex,
              files_total: filesTotal,
              step_id: d.step_id,
              step_summary: d.step_summary,
            }
          );
          break;
        }

        case "review_start": {
          const total = (event as any).files_total ?? 0;
          if (total > 0) {
            addMessage(
              "assistant",
              `**Reviewing ${total} file change${total === 1 ? "" : "s"}** — approve each one to write to disk.`,
              t
            );
          }
          break;
        }

        case "file_written": {
          const d = event as any;
          const fp = d.file_path;
          const action = (d.action as string) || "modify";
          const actionLabel = action === "create" ? "Created" : action === "delete" ? "Removed" : "Updated";
          setGeneratingFiles((prev) => prev.filter((f) => f !== fp));
          setCompletedFiles((prev) => [...prev, fp]);
          setFileActions((prev) => ({ ...prev, [fp]: action }));
          addMessage("assistant", `${actionLabel} \`${fp}\``, t, { action });
          refreshFileTree();
          break;
        }

        case "file_rejected": {
          const d = event as any;
          addMessage(
            "assistant",
            `**Skipped** \`${d.file_path}\` — ${d.reason || "rejected by user"}`,
            t
          );
          break;
        }

        case "file_failed": {
          const d = event as any;
          addMessage(
            "assistant",
            `**Failed** \`${d.file_path}\` — ${d.error || "write error"}`,
            t
          );
          break;
        }

        case "changes_rejected": {
          addMessage(
            "assistant",
            `All proposed changes were rejected. No files were written.`,
            t
          );
          break;
        }

        default: {
          // Suppress internal/infrastructure events — only log truly unknown types
          const silentEvents = new Set([
            "heartbeat", "checkpoint", "execution_started", "execution_complete",
            "agent_init", "state_update", "context_loaded", "prompt_enriched",
            "tech_stack_detected", "smart_context", "compaction_started",
            "compaction_complete", "batch_queued", "review_started",
            "assembly_started", "assembly_complete", "run_metadata",
          ]);
          if (!silentEvents.has(t)) {
            // Show a friendly label instead of raw JSON
            const msg = (event as any).message || (event as any).label || "";
            if (msg) {
              addMessage("system", msg, t);
            }
            // If truly unknown and no message, silently ignore — don't show raw JSON
          }
          break;
        }
      }
    },
    [addMessage, refreshFileTree]
  );

  // ── Subscribe to SSE event stream ─────────────────────────────────────
  const subscribeToRun = useCallback(
    (targetRunId: string, fromEventId: number = -1) => {
      // Close existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      const token = getToken();
      const url = token
        ? `${API_BASE}/sse/events/${targetRunId}?last_id=${fromEventId}&token=${encodeURIComponent(token)}`
        : `${API_BASE}/sse/events/${targetRunId}?last_id=${fromEventId}`;
      const es = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = es;
      sseRetryRef.current = 0;

      const handleSseEvent = (ev: MessageEvent) => {
        try {
          const eventId = Number(ev.lastEventId);
          if (!isNaN(eventId)) lastEventIdRef.current = eventId;
          sseRetryRef.current = 0;
          const event: CBv2PipelineEvent = JSON.parse(ev.data);
          handleEvent(event);
        } catch {
          // Ignore malformed events.
        }
      };

      es.addEventListener("pipeline", handleSseEvent);
      for (const eventName of V3_SSE_EVENT_NAMES) {
        es.addEventListener(eventName, handleSseEvent);
      }

      es.onerror = () => {
        // EventSource auto-reconnects on error by default. Track
        // consecutive failures so we can surface the friendly busy
        // message instead of a silently-spinning UI when the backend
        // is actually down (deploy / restart / overload).
        if (statusRef.current === "complete" || statusRef.current === "error") {
          es.close();
          eventSourceRef.current = null;
          return;
        }
        sseRetryRef.current += 1;
        if (sseRetryRef.current >= 4) {
          // ~4 reconnect attempts → give up and tell the user.
          setStatus("error");
          addMessage("system", BUSY_MESSAGE);
          es.close();
          eventSourceRef.current = null;
        }
        // Otherwise let the browser retry silently
      };
    },
    [handleEvent]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  // ── Save a generated file via REST POST ────────────────────────────────
  const saveFile = useCallback(
    async (path: string, content: string): Promise<boolean> => {
      try {
        const resp = await fetch(`${API_BASE}/files/save`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            path,
            content,
            output_dir: outputDirRef.current || undefined,
            run_id: runIdRef.current || undefined,
          }),
        });
        return resp.ok;
      } catch {
        return false;
      }
    },
    []
  );

  // ── Answer an intake / clarification gate via the chat input ───────────
  const answerPendingInput = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      const pending = pendingInputRef.current;
      const rid = runIdRef.current;
      if (!trimmed || !pending || !rid) return;

      addMessage("user", trimmed);

      const cancelled = /^cancel$/i.test(trimmed);
      pendingInputRef.current = null;
      setAwaitingUserInput(false);

      try {
        if (pending.kind === "intake") {
          await fetch(`${API_BASE}/v3/intake/${rid}`, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              continue: !cancelled,
              answers: cancelled ? [] : buildIntakeAnswers(pending.questions, trimmed),
            }),
          });
        } else {
          await fetch(`${API_BASE}/v3/clarify/${rid}`, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              continue: !cancelled,
              choice: cancelled ? "" : trimmed,
              note: "",
            }),
          });
        }

        if (cancelled) {
          setStatus("complete");
          addMessage("system", "Run cancelled.");
        } else {
          setStatus("running");
          addMessage("system", "Input received. Continuing...");
        }
      } catch (error) {
        setStatus("error");
        const message = error instanceof Error ? error.message : "Unknown error";
        addMessage("system", `Failed to send clarification: ${message}`);
      }
    },
    [addMessage],
  );

  // ── Send confirmation via REST POST ───────────────────────────────────
  const sendConfirmation = useCallback(
    async (approved: boolean, selectedTaskIds?: string[]) => {
      const rid = runIdRef.current;
      if (!rid) return;

      const pendingApproval = pendingApprovalRef.current;
      try {
        await fetch(`${API_BASE}/sse/confirm/${rid}`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ approved, selected_task_ids: selectedTaskIds ?? [] }),
        });
      } catch (e) {
        console.error("Failed to send confirmation:", e);
      }
      setPendingConfirmation(false);
      pendingApprovalRef.current = null;
      const subsetNote = (selectedTaskIds && selectedTaskIds.length > 0)
        ? ` (subset: ${selectedTaskIds.join(", ")})`
        : "";
      addMessage("user", approved ? `Changes approved${subsetNote}` : "Changes rejected");
    },
    [addMessage]
  );

  // ── Re-run a chosen subset of tasks against the current run ──────────
  const runTasksSubset = useCallback(
    async (taskIds: string[]): Promise<{ ok: boolean; detail?: string }> => {
      const rid = runIdRef.current;
      if (!rid) return { ok: false, detail: "No active run" };
      try {
        const res = await fetch(`${API_BASE}/v3/run-tasks/${rid}`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ task_ids: taskIds }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, detail: body?.detail || `HTTP ${res.status}` };
        addMessage("user", `Re-running tasks: ${taskIds.join(", ")}`);
        return { ok: true };
      } catch (e) {
        console.error("Failed to run task subset:", e);
        return { ok: false, detail: String(e) };
      }
    },
    [addMessage]
  );

  // ── Stop / cancel the in-flight pipeline run ─────────────────────────
  const cancelRun = useCallback(async (): Promise<void> => {
    const rid = runIdRef.current;
    if (!rid) return;
    addMessage("user", "Stop generation requested");
    try {
      await fetch(`${API_BASE}/v3/cancel/${rid}`, { method: "POST", headers: authHeaders() });
    } catch (e) {
      console.error("Failed to cancel run:", e);
    }
    setPendingConfirmation(false);
    setAwaitingUserInput(false);
    pendingInputRef.current = null;
    pendingApprovalRef.current = null;
  }, [addMessage]);

  // ── Clear history for the active session ─────────────────────────────
  // Wipes the persisted chat transcript on the server (session row stays)
  // and resets local state so the next message starts fresh under the same
  // session_id. Pass `deleteArtifacts: true` to also delete the on-disk
  // run directories owned by this session.
  const clearHistory = useCallback(
    async (opts?: { deleteArtifacts?: boolean }): Promise<void> => {
      const sid = sessionIdRef.current;
      if (sid) {
        try {
          await fetch(`${API_BASE}/v3/clear-history/${sid}`, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ delete_artifacts: !!opts?.deleteArtifacts }),
          });
        } catch (e) {
          console.error("Failed to clear history:", e);
        }
      }
      // Reset local UI state (mirrors resetSession but keeps sessionId
      // so subsequent runs continue under the same session bucket).
      pendingInputRef.current = null;
      pendingApprovalRef.current = null;
      pendingDiffsRef.current = {};
      lastPlanRef.current = null;
      setMessages([]);
      setFileTree([]);
      setFileCount(0);
      setCurrentPhase("");
      setGeneratingFiles([]);
      setCompletedFiles([]);
      setFileActions({});
      setManifest([]);
      setSummary(null);
      setPendingConfirmation(false);
      setAwaitingUserInput(false);
      runIdRef.current = "";
      setRunId("");
      outputDirRef.current = "";
      setOutputDirState("");
      setStatus("idle");
    },
    []
  );

  // ── Explicitly create a fresh session for a project ───────────────────
  // Used when the user opens the Code Builder and selects a project so
  // every "open" lands in an isolated session bucket. Returns the new
  // session_id (or null on failure) and stores it on the hook state so
  // subsequent runs continue under the same bucket until the user picks
  // a different session or starts a brand-new one.
  const createNewSession = useCallback(
    async (
      projectId: number,
      projectName: string,
      pipelineType: string = "greenfield",
    ): Promise<number | null> => {
      try {
        const resp = await fetch(`${API_BASE}/v3/sessions`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            project_id: projectId,
            project_name: projectName,
            pipeline_type: pipelineType,
          }),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const sid: number | null = data?.session_id ?? null;
        if (sid != null) {
          sessionIdRef.current = sid;
          setSessionId(sid);
        }
        return sid;
      } catch (e) {
        console.error("Failed to create session:", e);
        return null;
      }
    },
    []
  );

  // ── Resolve a batch_review_required event ──────────────────────────
  const respondBatchReview = useCallback(
    async (decision: {
      acceptAll?: boolean;
      rejectAll?: boolean;
      fileDecisions?: Array<{ file_path: string; approved: boolean }>;
    }): Promise<void> => {
      const rid = runIdRef.current;
      if (!rid) return;
      const label = decision.acceptAll
        ? "Accept all changes"
        : decision.rejectAll
          ? "Reject all changes"
          : `Apply ${(decision.fileDecisions || []).filter((d) => d.approved).length} of ${(decision.fileDecisions || []).length} changes`;
      addMessage("user", label);
      setPendingConfirmation(false);
      pendingApprovalRef.current = null;
      try {
        await fetch(`${API_BASE}/v3/batch-approve/${rid}`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            accept_all: !!decision.acceptAll,
            reject_all: !!decision.rejectAll,
            file_decisions: decision.fileDecisions || [],
          }),
        });
      } catch (e) {
        console.error("Failed to send batch review decision:", e);
      }
    },
    [addMessage]
  );

  // ── Start generation via SSE ──────────────────────────────────────────
  const startGeneration = useCallback(
    async (description: string, projectName?: string, context?: CBv2ChatContext) => {
      // A request is a "follow-up" whenever we have anything that ties it
      // to a prior workspace: an explicit ``previous_output_dir`` from the
      // caller, or an active session with a known output directory from
      // an earlier run. Follow-ups must:
      //   1. Keep the existing file tree visible while the new run streams.
      //   2. Pass ``previous_output_dir`` to the backend so it seeds the
      //      new run dir from the prior generated workspace.
      //   3. Treat the pipeline as brownfield (edit-existing).
      const chosenSessionId = context?.session_id ?? null;
      const inheritedOutputDir =
        context?.previous_output_dir
        || (sessionIdRef.current !== null && outputDirRef.current ? outputDirRef.current : "");
      const isFollowUp = !!inheritedOutputDir;
      const hasSession = sessionIdRef.current !== null;

      // If user explicitly chose an existing session from the context picker,
      // set the ref so the backend continues that session.
      if (chosenSessionId) {
        sessionIdRef.current = chosenSessionId;
        setSessionId(chosenSessionId);
      }

      // Reset pipeline state but preserve chat messages for continuity.
      // For follow-up (brownfield) runs, keep the existing file tree visible
      // so the explorer isn't blank while the new generation runs.
      if (!isFollowUp) {
        setFileTree([]);
        setFileCount(0);
      }
      setCurrentPhase("");
      setGeneratingFiles([]);
      setCompletedFiles([]);
      setFileActions({});
      setManifest([]);
      setSummary(null);
      setPendingConfirmation(false);
      runIdRef.current = "";
      setRunId("");

      if (isFollowUp) {
        setPipelineType("brownfield");
        // Keep messages — user sees the full conversation
      } else if (!hasSession && !chosenSessionId) {
        // Brand new session — clear previous messages
        setMessages([]);
        outputDirRef.current = "";
        setOutputDirState("");
        setPipelineType(context?.pipeline_type ?? "greenfield");
      } else {
        // Existing session, new request — keep messages for history
        setPipelineType(context?.pipeline_type ?? "greenfield");
      }

      setStatus("connecting");
      addMessage("user", description);

      // Build payloads
      const storyPayloads = (context?.selected_stories ?? []).map((s) => ({
        id: s.id, type: s.artifact_type, title: s.title,
        description: s.description ?? "", content: s.content ?? {},
      }));
      const documentPayloads = (context?.selected_documents ?? []).map((d) => ({
        id: d.id, type: d.artifact_type, title: d.title,
        description: d.description ?? "", content: d.content ?? {},
      }));

      try {
        const resp = await fetch(`${API_BASE}/v3/start`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            description,
            project_name: projectName || "generated_app",
            project_id: context?.project_id ?? null,
            pipeline_type: isFollowUp ? "brownfield" : (context?.pipeline_type ?? "greenfield"),
            stories: storyPayloads,
            documents: documentPayloads,
            previous_output_dir: inheritedOutputDir || null,
            session_id: chosenSessionId || sessionIdRef.current,
            // Pass the user's custom session label so the backend creates
            // the new session row with it instead of the default template.
            // Only meaningful when a fresh session is about to be created
            // (no chosenSessionId / sessionIdRef yet).
            session_name: context?.new_session_name?.trim() || undefined,
            auto_apply_files: false,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          let detail = resp.statusText || "Unknown error";
          let errCode = "";
          try {
            const errJson = JSON.parse(errText);
            if (errJson.detail) detail = errJson.detail;
            if (errJson.code) errCode = String(errJson.code);
          } catch {
            if (errText) detail = errText.slice(0, 300);
          }
          setStatus("error");
          // 409 → another pipeline is already running for this project.
          // Surface the validation message verbatim (no "Failed to start"
          // prefix) so the user sees a clean, actionable notice.
          if (resp.status === 409 || errCode === "pipeline_already_running") {
            addMessage("system", detail);
            return;
          }
          // 5xx / 429 → backend overloaded; everything else surfaces the
          // real detail so the user can act on it (bad project_id etc.).
          const friendly = _friendlyBackendError(resp.status, detail);
          if (friendly === BUSY_MESSAGE) {
            addMessage("system", BUSY_MESSAGE);
          } else {
            addMessage("system", `Failed to start pipeline: ${detail}`);
          }
          return;
        }

        const data = await resp.json();
        const { run_id, project_dir, pipeline_type: returnedPipelineType, session_id: returnedSessionId } = data;
        runIdRef.current = run_id;
        outputDirRef.current = project_dir || "";
        setOutputDirState(project_dir || "");
        setRunId(run_id);
        if (returnedPipelineType) setPipelineType(String(returnedPipelineType));
        setStatus("running");
        lastEventIdRef.current = -1;
        pendingInputRef.current = null;
        pendingApprovalRef.current = null;
        pendingDiffsRef.current = {};
        lastPlanRef.current = null;
        setAwaitingUserInput(false);

        // Persist session ID for continuity across runs
        if (returnedSessionId) {
          sessionIdRef.current = returnedSessionId;
          setSessionId(returnedSessionId);
        }

        addMessage("system", isFollowUp
          ? "Connected — applying changes to existing project..."
          : "Connected to AI Code Builder...");

        // Subscribe to SSE stream
        subscribeToRun(run_id);
      } catch (err) {
        setStatus("error");
        // fetch() rejects on DNS / connection refused / CORS preflight
        // failures — the user just sees "TypeError: Failed to fetch"
        // which is meaningless. Surface the friendly busy message.
        const raw = err instanceof Error ? err.message : "Unknown error";
        const isNetwork = /failed to fetch|network|load failed|aborted/i.test(raw);
        addMessage("system", isNetwork ? BUSY_MESSAGE : `Connection error: ${raw}`);
      }
    },
    [addMessage, subscribeToRun]
  );

  // ── Resume an existing run (page navigation recovery) ─────────────────
  const resumeRun = useCallback(
    (targetRunId: string) => {
      runIdRef.current = targetRunId;
      setRunId(targetRunId);
      setStatus("running");
      addMessage("system", "Reconnecting to running pipeline...");
      // Subscribe from the beginning to replay all events
      subscribeToRun(targetRunId, -1);
    },
    [addMessage, subscribeToRun]
  );

  // ── Reset session (call when project changes) ────────────────────────
  const resetSession = useCallback(() => {
    // Detach from any in-flight SSE stream first. Without this, lingering
    // events from the previous run continue firing setRunId / setStatus
    // after the user switches to a different project, which makes the new
    // project appear to "snap back" to the old running pipeline and feels
    // as if project switching is being blocked.
    if (eventSourceRef.current) {
      try { eventSourceRef.current.close(); } catch { /* ignore */ }
      eventSourceRef.current = null;
    }
    sessionIdRef.current = null;
    pendingInputRef.current = null;
    pendingApprovalRef.current = null;
    pendingDiffsRef.current = {};
    lastPlanRef.current = null;
    setSessionId(null);
    setMessages([]);
    setFileTree([]);
    setFileCount(0);
    setCurrentPhase("");
    setGeneratingFiles([]);
    setCompletedFiles([]);
    setFileActions({});
    setManifest([]);
    setSummary(null);
    setPendingConfirmation(false);
    setAwaitingUserInput(false);
    runIdRef.current = "";
    setRunId("");
    outputDirRef.current = "";
    setOutputDirState("");
    setPipelineType("greenfield");
    setStatus("idle");
  }, []);

  // ── Load an existing session (restore its chat messages + file tree) ────
  const loadSession = useCallback(async (sid: number, lastOutputDir?: string | null, lastRunId?: string | null) => {
    sessionIdRef.current = sid;
    pendingInputRef.current = null;
    pendingApprovalRef.current = null;
    pendingDiffsRef.current = {};
    lastPlanRef.current = null;
    setSessionId(sid);
    // Clear pipeline state
    setFileTree([]);
    setFileCount(0);
    setCurrentPhase("");
    setGeneratingFiles([]);
    setCompletedFiles([]);
    setFileActions({});
    setManifest([]);
    setSummary(null);
    setPendingConfirmation(false);
    setAwaitingUserInput(false);
    setStatus("idle");

    // Restore output_dir / run_id from the session's last run
    if (lastOutputDir) {
      outputDirRef.current = lastOutputDir;
      setOutputDirState(lastOutputDir);
    } else {
      outputDirRef.current = "";
      setOutputDirState("");
    }
    if (lastRunId) {
      runIdRef.current = lastRunId;
      setRunId(lastRunId);
    } else {
      runIdRef.current = "";
      setRunId("");
    }

    // Fetch session messages from backend and restore into chat.
    // Persisted history can include raw "system" lines from the SSE
    // stream ("Connected...", "[greenfield] Generated 6 files in 83s.
    // Output: /home/.../workspace/...") which look ugly when re-loaded
    // out of context. Filter the noise and reshape the generation
    // summary into a structured event so the chat panel renders it
    // with the same icon + styling as a live run.
    try {
      const resp = await fetch(`${API_BASE}/session/${sid}/messages`, { headers: authHeaders() });
      if (resp.ok) {
        const data = await resp.json();
        const NOISE = [
          /^connected to ai code builder/i,
          /^connected\s*[-—]\s*applying changes/i,
          /^failed to start pipeline/i,
          /^connection error/i,
          /^pipeline (started|completed)/i,
          // Internal per-run lifecycle summaries persisted by the backend
          // (_persist_summary). When a session is re-opened we don't want
          // stale "Run cancelled."/"Run failed." lines from earlier runs
          // re-appearing in the chat and making the user think the
          // current run was just cancelled. The current run's live SSE
          // stream still surfaces real cancellation events.
          /^run (cancelled|failed|complete|completed)\b/i,
          /^run\s+cancelled\s+by\s+user/i,
        ];
        // Matches: "[greenfield] Generated 6 files in 83s. Output: /path/foo"
        const SUMMARY_RE =
          /^\[(greenfield|brownfield)\]\s+Generated\s+(\d+)\s+files?\s+in\s+([\d.]+s).*?Output:\s*(\S+)/i;

        const msgs: CBv2ChatMessage[] = [];
        for (const m of data.messages || []) {
          const content = (m.content || "").trim();
          if (!content) continue;
          const role = m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant";
          const ts = m.timestamp ? m.timestamp * 1000 : Date.now();

          // Always keep user prompts verbatim
          if (role === "user") {
            msgs.push({ id: makeId(), role, content, timestamp: ts });
            continue;
          }

          // Drop raw connection chatter regardless of role
          if (NOISE.some((re) => re.test(content))) continue;

          // Reshape generation summary into a clean assistant card
          const summary = content.match(SUMMARY_RE);
          if (summary) {
            const [, kind, fileCountStr, duration, outputDir] = summary;
            const folder = outputDir.split(/[\\/]/).pop() || outputDir;
            msgs.push({
              id: makeId(),
              role: "assistant",
              content: `Generated **${fileCountStr}** files in ${duration} (${kind}) — output \`${folder}\``,
              timestamp: ts,
              eventType: "generation_complete",
              data: {
                pipeline_type: kind,
                file_count: Number(fileCountStr),
                duration,
                output_dir: outputDir,
              },
            });
            continue;
          }

          msgs.push({ id: makeId(), role: role as any, content, timestamp: ts });
        }
        setMessages(msgs);
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }

    // Restore file tree from the session's last run
    if (lastOutputDir || lastRunId) {
      await refreshFileTree();
    }
  }, [refreshFileTree]);

  // ── Fetch active runs (for explorer sidebar) ──────────────────────────
  const fetchActiveRuns = useCallback(async (): Promise<SSEActiveRun[]> => {
    try {
      const resp = await fetch(`${API_BASE}/sse/runs`, { headers: authHeaders() });
      if (!resp.ok) return [];
      const data = await resp.json();
      return data.runs || [];
    } catch {
      return [];
    }
  }, []);

  return {
    status,
    messages,
    fileTree,
    fileCount,
    currentPhase,
    generatingFiles,
    completedFiles,
    fileActions,
    manifest,
    summary,
    runId,
    outputDir: outputDirState,
    pipelineType,
    pendingConfirmation,
    awaitingUserInput,
    sessionId,
    startGeneration,
    answerPendingInput,
    sendConfirmation,
    cancelRun,
    respondBatchReview,
    runTasksSubset,
    saveFile,
    refreshFileTree,
    loadRunFiles,
    loadRunFilesFromZip,
    fetchFileContent,
    resumeRun,
    fetchActiveRuns,
    resetSession,
    createNewSession,
    clearHistory,
    loadSession,
    onWorkspaceUpdated,
  };
}
