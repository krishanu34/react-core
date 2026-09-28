"use client";

import { useCallback, useRef, useState } from "react";
import type {
  CBv2PipelineEvent,
  CBv2ChatMessage,
  CBv2FileNode,
  CBv2GenerationStatus,
  CBv2ChatContext,
} from "@/types/code-builder-v2";
import { getToken } from "@/lib/auth";

/* ── URLs — always connect directly to the code-builder backend for WebSocket.
   Next.js does not reliably proxy WS upgrades in turbopack dev or standalone. ── */
function _cbWsUrl(): string {
  if (typeof window === "undefined") {
    return "ws://localhost:8001/ws/generate";
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const port = new URL(
    process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL || "http://localhost:8001"
  ).port || "8001";
  const base = `${proto}//${window.location.hostname}:${port}/ws/generate`;
  // Append JWT token as query parameter for WebSocket authentication
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
const API_BASE = "/cb-api"; // proxied via next.config.ts → http://localhost:8001/api

interface UseCodeBuilderAgentReturn {
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

  startGeneration: (description: string, projectName?: string, context?: CBv2ChatContext) => void;
  sendConfirmation: (approved: boolean, selectedTaskIds?: string[]) => void;
  refreshFileTree: () => Promise<string | null>;
  loadRunFiles: (runId: string, pipelineType?: string) => Promise<void>;
  fetchFileContent: (
    path: string
  ) => Promise<{ content: string; language: string } | null>;
  onWorkspaceUpdated: React.MutableRefObject<(() => void) | null>;
}

let msgId = 0;
function makeId() {
  msgId += 1;
  return `cbv2-msg-${msgId}-${Date.now()}`;
}

export function useCodeBuilderAgent(): UseCodeBuilderAgentReturn {
  const [status, setStatus] = useState<CBv2GenerationStatus>("idle");
  const [messages, setMessages] = useState<CBv2ChatMessage[]>([]);
  const [fileTree, setFileTree] = useState<CBv2FileNode[]>([]);
  const [fileCount, setFileCount] = useState(0);
  const [currentPhase, setCurrentPhase] = useState("");
  const [generatingFiles, setGeneratingFiles] = useState<string[]>([]);
  const [completedFiles, setCompletedFiles] = useState<string[]>([]);
  const [fileActions, setFileActions] = useState<Record<string, string>>({});
  const [pipelineType, setPipelineType] = useState<string>("greenfield");
  const [manifest, setManifest] = useState<
    Array<{ path: string; description: string }>
  >([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [runId, setRunId] = useState<string>("");
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const outputDirRef = useRef<string>("");
  const runIdRef = useRef<string>("");
  const onWorkspaceUpdated = useRef<(() => void) | null>(null);
  const statusRef = useRef<CBv2GenerationStatus>("idle");
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep statusRef in sync with status state
  statusRef.current = status;

  // ── Add a chat message ────────────────────────────────────────────────
  const addMessage = useCallback(
    (
      role: CBv2ChatMessage["role"],
      content: string,
      eventType?: string,
      data?: Record<string, unknown>
    ) => {
      setMessages((prev: CBv2ChatMessage[]) => [
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

  // ── Refresh file tree from REST API ───────────────────────────────────
  const refreshFileTree = useCallback(async (): Promise<string | null> => {
    try {
      const params = new URLSearchParams();
      if (runIdRef.current) {
        params.set("run_id", runIdRef.current);
      }
      if (outputDirRef.current) {
        params.set("output_dir", outputDirRef.current);
      }
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/files${qs ? `?${qs}` : ""}`, {
        headers: { Authorization: `Bearer ${getToken() || ""}` },
      });
      const data = await res.json();
      setFileTree(data.tree || []);
      setFileCount(data.count || 0);
      // If the backend reports the run's pipeline type, update it
      if (data.pipeline_type) {
        setPipelineType(data.pipeline_type);
      }
      return data.error || null;
    } catch {
      // Silent — might not be ready yet
      return null;
    }
  }, []);

  // ── Load files for a specific historical run ──────────────────────────
  const loadRunFiles = useCallback(async (historicalRunId: string, historicalPipelineType?: string) => {
    runIdRef.current = historicalRunId;
    outputDirRef.current = "";
    setRunId(historicalRunId);
    if (historicalPipelineType) {
      setPipelineType(historicalPipelineType);
    }
    await refreshFileTree();
  }, [refreshFileTree]);

  // ── Fetch single file content ─────────────────────────────────────────
  const fetchFileContent = useCallback(
    async (
      path: string
    ): Promise<{ content: string; language: string } | null> => {
      try {
        const params = new URLSearchParams();
        if (runIdRef.current) {
          params.set("run_id", runIdRef.current);
        }
        if (outputDirRef.current) {
          params.set("output_dir", outputDirRef.current);
        }
        const qs = params.toString();
        const res = await fetch(
          `${API_BASE}/files/${encodeURIComponent(path)}${qs ? `?${qs}` : ""}`,
          { headers: { Authorization: `Bearer ${getToken() || ""}` } }
        );
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    []
  );

  // ── Handle each WebSocket event ───────────────────────────────────────
  const handleEvent = useCallback(
    (event: CBv2PipelineEvent) => {
      const t = event.type;

      switch (t) {
        case "accepted":
          if ((event as any).output_dir) {
            outputDirRef.current = String((event as any).output_dir);
          }
          if ((event as any).run_id) {
            runIdRef.current = String((event as any).run_id);
            setRunId(String((event as any).run_id));
          }
          addMessage("system", event.message as string, t);
          break;

        case "context_compacted": {
          const data = event as any;
          const notes = Array.isArray(data.notes) ? data.notes : [];
          const compactedStories = Number(data.compacted_story_count || 0) + Number(data.omitted_story_count || 0);
          const compactedDocuments = Number(data.compacted_document_count || 0) + Number(data.omitted_document_count || 0);
          const parts = [`**Context optimized** — ready for generation`];
          if (compactedStories > 0) parts.push(`Stories summarized: ${compactedStories}`);
          if (compactedDocuments > 0) parts.push(`Documents summarized: ${compactedDocuments}`);
          if (data.smart_context_compacted) parts.push("Existing codebase context summarized");
          if (notes.length > 0) parts.push(...notes);
          addMessage("system", parts.join("\n"), t, data);
          break;
        }

        case "pipeline_started":
          addMessage(
            "assistant",
            "Pipeline initialized. Agents starting...",
            t,
            event as Record<string, unknown>
          );
          setStatus("running");
          break;

        case "phase":
          setCurrentPhase(
            (event as any).label || (event as any).phase || ""
          );
          addMessage("assistant", `${(event as any).label}`, t);
          break;

        case "thinking":
          addMessage(
            "assistant",
            `${(event as any).message}`,
            t
          );
          break;

        case "manifest":
        case "manifest_updated": {
          const files = (event as any).files || [];
          const count = (event as any).count || files.length;
          setManifest(files);
          addMessage(
            "assistant",
            `**${count} files** planned\n\n${files
              .map(
                (f: any) => `  • \`${f.path}\` — ${f.description}`
              )
              .join("\n")}`,
            t
          );
          break;
        }

        case "approval":
          addMessage(
            "assistant",
            `Manifest ${(event as any).status}`,
            t
          );
          break;

        case "folder_created":
          refreshFileTree();
          break;

        case "schedule_info":
          addMessage(
            "assistant",
            `Scheduler: ${(event as any).total} files, max ${(event as any).max_concurrent} concurrent`,
            t
          );
          break;

        case "batch_start":
          addMessage(
            "assistant",
            `**Batch ${(event as any).batch}** — generating ${((event as any).files || []).length} file(s):\n${((event as any).files || [])
              .map((f: string) => `  • \`${f}\``)
              .join("\n")}`,
            t
          );
          break;

        case "file_start":
          setGeneratingFiles((prev: string[]) => [
            ...prev.filter((f: string) => f !== (event as any).path),
            (event as any).path,
          ]);
          addMessage(
            "assistant",
            `Generating \`${(event as any).path}\`...`,
            t
          );
          break;

        case "file_created":
          refreshFileTree();
          break;

        case "file_complete": {
          const fp = (event as any).path;
          const action = (event as any).action || "create";
          const actionLabel = action === "create" ? "Created" : action === "delete" ? "Removed" : "Updated";
          setGeneratingFiles((prev: string[]) => prev.filter((f: string) => f !== fp));
          setCompletedFiles((prev: string[]) => [...prev, fp]);
          setFileActions((prev) => ({ ...prev, [fp]: action }));
          addMessage(
            "assistant",
            `${actionLabel} \`${fp}\``,
            t,
            { action }
          );
          refreshFileTree();
          break;
        }

        case "batch_complete":
          addMessage(
            "assistant",
            `Batch ${(event as any).batch} complete — ${(event as any).remaining} remaining`,
            t
          );
          break;

        case "dependency_found":
          addMessage(
            "assistant",
            `Found ${(event as any).count} missing dependencies — adding to manifest`,
            t
          );
          break;

        case "generation_complete":
          addMessage(
            "assistant",
            `Generation complete — **${(event as any).files_generated}** files generated`,
            t
          );
          break;

        case "review_complete": {
          const issues = (event as any).issues || [];
          const sum = (event as any).summary || "";
          if (issues.length > 0) {
            const issueList = issues
              .map(
                (i: any) =>
                  `  \`${i.file}\`: ${i.description}`
              )
              .join("\n");
            addMessage(
              "assistant",
              `**Code Review**: ${sum}\n\n${issueList}`,
              t
            );
          } else {
            addMessage("assistant", `**Code Review**: ${sum}`, t);
          }
          break;
        }

        case "pipeline_complete": {
          const d = event as any;
          if (d.output_dir) {
            outputDirRef.current = String(d.output_dir);
          }
          setSummary(d);
          if (d.pipeline_type === "brownfield") {
            setPipelineType("brownfield");
            // Brownfield modifies workspace in-place — clear generated tree
            setFileTree([]);
            setCompletedFiles([]);
            setFileActions({});
            addMessage(
              "assistant",
              `**Changes Applied**\n\n` +
                `  ${d.files_generated} file(s) updated\n` +
                `  ${d.total_files} total files in workspace\n` +
                `  ${d.errors > 0 ? `${d.errors} error(s)` : "No errors"}`,
              t,
              d
            );
            // For brownfield, workspace was updated — trigger refresh
            onWorkspaceUpdated.current?.();
          } else {
            addMessage(
              "assistant",
              `**Generation Complete**\n\n` +
                `  ${d.files_generated}/${d.files_planned} files generated\n` +
                `  ${d.files_on_disk} files on disk\n` +
                `  ${d.elapsed_s}s total\n` +
                `  ${d.errors > 0 ? `${d.errors} error(s)` : "No errors"}\n` +
                (d.zip_size_kb ? `  ZIP: ${d.zip_size_kb} KB` : ""),
              t,
              d
            );
            refreshFileTree();
          }
          break;
        }

        case "workspace_updated": {
          // Brownfield: changes were synced back to workspace
          const changed = (event as any).changed_files || [];
          if (changed.length > 0) {
            addMessage(
              "assistant",
              `Workspace synced — ${changed.length} file(s) updated`,
              t
            );
          }
          onWorkspaceUpdated.current?.();
          break;
        }

        case "done":
          setStatus("complete");
          if (pipelineType === "brownfield") {
            addMessage(
              "system",
              "Changes applied to your workspace. Follow-up requests will keep editing the same files.",
              t
            );
          } else {
            addMessage(
              "system",
              "Generation complete. Workspace saved for this session — follow-up requests will continue using these files.",
              t
            );
          }
          refreshFileTree();
          break;

        case "error":
          if ((event as any).error_code === "MODEL_CONFIG_MISSING") {
            addMessage(
              "assistant",
              `**LLM Model Not Configured**\n\n${(event as any).message}\n\nPlease go to **Project Settings > AI Models** and select a model for **Code Builder** before generating code.`,
              t,
              { error_code: "MODEL_CONFIG_MISSING" }
            );
            setStatus("error");
          } else if ((event as any).error_code === "CONTENT_FILTER") {
            // Content filter is followed by "done" — don't set "error" status
            // so the UI correctly transitions to "complete" when "done" arrives.
            addMessage(
              "assistant",
              `**Content Safety Notice**\n\n${(event as any).message}`,
              t,
              { error_code: "CONTENT_FILTER" }
            );
          } else {
            addMessage(
              "assistant",
              `**Error**: ${(event as any).message}`,
              t
            );
          }
          break;

        case "warning":
          addMessage(
            "assistant",
            `⚠️ ${(event as any).message}`,
            t
          );
          break;

        case "heartbeat":
          break;

        case "confirmation_required": {
          setPendingConfirmation(true);
          const proposed = (event as any).proposed_changes || [];
          const summary = (event as any).summary || "";
          const diffLines = proposed.map((c: any) => {
            return `  \`${c.file_path}\` — ${c.diff_summary || c.action}`;
          }).join("\n");
          addMessage(
            "assistant",
            `**Proposed Changes**\n\n${summary ? summary + "\n\n" : ""}${diffLines}`,
            t,
            { proposed_changes: proposed, summary, needs_confirmation: true }
          );
          break;
        }

        case "plan_approval_required": {
          setPendingConfirmation(true);
          const steps = (event as any).steps || (event as any).plan_steps || [];
          const summary = (event as any).summary || "";
          const planContent = (event as any).plan_content || "";
          const tasks = (event as any).tasks || [];
          const selectedStories = (event as any).selected_stories || [];
          const selectedDocuments = (event as any).selected_documents || [];
          addMessage(
            "assistant",
            `**Execution Plan**\n\n${summary}`,
            t,
            {
              needs_confirmation: true, plan_approval: true,
              plan_steps: steps, plan_content: planContent,
              tasks, selected_stories: selectedStories, selected_documents: selectedDocuments,
            }
          );
          break;
        }

        case "feasibility_confirmation_required": {
          setPendingConfirmation(true);
          const verdict = (event as any).verdict || "";
          const suggestions = ((event as any).suggestions || []) as string[];
          const suggestionLines = suggestions.length > 0
            ? `\n\n**Suggestions:**\n${suggestions.map((s: string) => `  • ${s}`).join("\n")}`
            : "";
          addMessage(
            "assistant",
            `**Feasibility Concern**\n\n${verdict}${suggestionLines}`,
            t,
            { needs_confirmation: true }
          );
          break;
        }

        default:
          if (t !== "heartbeat") {
            addMessage(
              "system",
              `[${t}] ${JSON.stringify(event).slice(0, 200)}`,
              t
            );
          }
      }
    },
    [addMessage, refreshFileTree, pipelineType]
  );

  // ── Send confirmation response back through WebSocket ──────────────────
  const sendConfirmation = useCallback(
    (approved: boolean, selectedTaskIds?: string[]) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "confirmation_response",
            approved,
            selected_task_ids: selectedTaskIds || [],
          })
        );
      }
      setPendingConfirmation(false);
      const subsetNote = (selectedTaskIds && selectedTaskIds.length > 0)
        ? ` (subset: ${selectedTaskIds.join(", ")})`
        : "";
      addMessage(
        "user",
        approved ? `Changes approved${subsetNote}` : "Changes rejected"
      );
    },
    [addMessage]
  );

  // ── Start generation via WebSocket ────────────────────────────────────
  const startGeneration = useCallback(
    (description: string, projectName?: string, context?: CBv2ChatContext) => {
      const isFollowUp = !!context?.previous_output_dir;

      if (isFollowUp) {
        // Follow-up: preserve chat messages, just reset generation state
        setFileTree([]);
        setFileCount(0);
        setCurrentPhase("");
        setGeneratingFiles([]);
        setCompletedFiles([]);
        setFileActions({});
        setManifest([]);
        setSummary(null);
        setPipelineType("brownfield");
        setPendingConfirmation(false);
        // Keep outputDirRef pointing to previous output for file viewing
        runIdRef.current = "";
        setRunId("");
      } else {
        // Fresh generation: full reset
        setMessages([]);
        setFileTree([]);
        setFileCount(0);
        setCurrentPhase("");
        setGeneratingFiles([]);
        setCompletedFiles([]);
        setFileActions({});
        setManifest([]);
        setSummary(null);
        setPipelineType(context?.pipeline_type ?? "greenfield");
        setPendingConfirmation(false);
        outputDirRef.current = "";
        runIdRef.current = "";
        setRunId("");
      }
      setStatus("connecting");

      addMessage("user", description);

      // Close existing WS
      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = new WebSocket(_cbWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("running");

        // Build story summaries to send alongside the prompt
        const storyPayloads = (context?.selected_stories ?? []).map((s) => ({
          id: s.id,
          type: s.artifact_type,
          title: s.title,
          description: s.description ?? "",
          content: s.content ?? {},
        }));
        const documentPayloads = (context?.selected_documents ?? []).map((d) => ({
          id: d.id,
          type: d.artifact_type,
          title: d.title,
          description: d.description ?? "",
          content: d.content ?? {},
        }));

        ws.send(
          JSON.stringify({
            description,
            project_name: projectName || "generated_app",
            project_id: context?.project_id ?? null,
            pipeline_type: isFollowUp ? "brownfield" : (context?.pipeline_type ?? "greenfield"),
            story_artifact_ids: context?.selected_story_ids ?? [],
            document_types: context?.selected_doc_types ?? [],
            stories: storyPayloads,
            documents: documentPayloads,
            previous_output_dir: context?.previous_output_dir ?? null,
          })
        );
        addMessage("system", isFollowUp
          ? "Connected — applying changes to existing project..."
          : "Connected to AI Code Builder...");
      };

      ws.onmessage = (ev) => {
        try {
          const event: CBv2PipelineEvent = JSON.parse(ev.data);
          handleEvent(event);
        } catch {
          // Ignore parse errors
        }
      };

      // Client-side ping keepalive — prevents proxies/browsers from
      // dropping WebSocket connections during long-running jobs.
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25_000);

      ws.onerror = () => {
        setStatus("error");
        addMessage(
          "system",
          "WebSocket connection error. Is the Code Builder backend running on port 8001?",
          "error"
        );
      };

      ws.onclose = () => {
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        // Use ref to avoid stale closure — status may have changed since
        // startGeneration was created.
        const current = statusRef.current;
        if (current === "running" || current === "connecting") {
          setStatus("complete");
        }
      };
    },
    [addMessage, handleEvent]
  );

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
    outputDir: outputDirRef.current,
    pipelineType,
    pendingConfirmation,
    startGeneration,
    sendConfirmation,
    refreshFileTree,
    loadRunFiles,
    fetchFileContent,
    onWorkspaceUpdated,
  };
}
