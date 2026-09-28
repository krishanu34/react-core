"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import { authFetch } from "@/lib/auth";
import {
  getFileTree,
  getPipelineHistory,
  getPipelineStatus,
  getPipelineModes,
  getOutputTree,
  listProjects,
  deletePipelineRun,
  startPipeline,
  getRunReports,
} from "@/lib/code-builder-api";
import type { PipelineMode, PipelineRun } from "@/types/code-builder";
import type { CBv2PipelineConfig } from "@/types/code-builder-v2";

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function isRunActive(status?: string): boolean {
  return status === "running" || status === "pending";
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch project file tree. High staleTime — files rarely change outside of
 * pipeline runs.
 */
export function useFileTree(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.codeBuilder.fileTree(projectId ?? ""),
    queryFn: () => getFileTree(projectId!),
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

/**
 * Fetch all pipeline runs. Polls while any run is active, stops when all
 * are idle. Cache is shared across PipelineManager and PipelineHistoryTab.
 */
export function usePipelineRuns(opts?: { refetchInterval?: number }) {
  const interval = opts?.refetchInterval ?? 5_000;

  return useQuery<any[]>({
    queryKey: queryKeys.codeBuilder.runs(),
    queryFn: () => getPipelineHistory(),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (!runs) return interval;
      return runs.some((r: any) => isRunActive(r.status)) ? interval : false;
    },
  });
}

/**
 * Fetch single pipeline run status. Polls only while the run is active
 * (running / pending) AND WebSocket is not connected. When `wsConnected`
 * is true, polling is disabled to avoid duplicate updates — the WebSocket
 * pushes real-time status and polling acts only as a fallback.
 */
export function usePipelineRunStatus(
  runId: string | null,
  opts?: { refetchInterval?: number; wsConnected?: boolean },
) {
  const interval = opts?.refetchInterval ?? 4_000;
  const wsActive = opts?.wsConnected ?? false;

  return useQuery({
    queryKey: queryKeys.codeBuilder.runStatus(runId ?? ""),
    queryFn: () => getPipelineStatus(runId!),
    enabled: !!runId,
    staleTime: 2_000,
    refetchInterval: (query) => {
      // Disable polling when WebSocket is actively connected
      if (wsActive) return false;
      const data = query.state.data as PipelineRun | undefined;
      if (!data) return interval;
      return isRunActive(data.status) ? interval : false;
    },
  });
}

/**
 * Fetch output tree for a completed pipeline run. Result is cached
 * indefinitely — generated output doesn't change.
 */
export function useOutputTree(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.codeBuilder.outputTree(runId ?? ""),
    queryFn: () => getOutputTree(runId!),
    enabled: !!runId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch available pipeline modes. Static data → very high staleTime.
 */
export function usePipelineModes() {
  return useQuery({
    queryKey: queryKeys.codeBuilder.modes(),
    queryFn: () => getPipelineModes(),
    staleTime: 30 * 60 * 1000, // 30 min
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch code builder projects list.
 */
export function useCBProjects(enabled = true) {
  return useQuery({
    queryKey: queryKeys.codeBuilder.projects(),
    queryFn: async () => {
      const res = await listProjects();
      return res.projects ?? [];
    },
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Fetch reports for a pipeline run.
 */
export function useRunReports(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.codeBuilder.reports(runId ?? ""),
    queryFn: async () => {
      const res = await getRunReports(runId!);
      return res.reports ?? [];
    },
    enabled: !!runId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MUTATION HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start a new pipeline run. Invalidates the runs list on success.
 */
export function useStartPipeline() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (args: {
      mode: PipelineMode;
      request: string;
      projectId?: string;
      projectDir?: string;
    }) => startPipeline(args.mode, args.request, args.projectId, args.projectDir),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.codeBuilder.runs() });
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CBv2 — MODEL CONFIG STATUS
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelConfigStatus {
  configured: boolean;
  message?: string;
  model_name?: string;
  context_window_tokens?: number | null;
  reserved_output_tokens?: number | null;
  input_budget_tokens?: number | null;
  budget_source?: string | null;
}

/**
 * Check whether a project has a valid model configuration for CBv2.
 * Only enabled when a project ID is provided.
 */
export function useCBv2ModelConfigStatus(projectId: number | null) {
  return useQuery<ModelConfigStatus>({
    queryKey: queryKeys.cbv2.modelConfigStatus(projectId ?? 0),
    queryFn: async () => {
      const res = await authFetch(`/cb-api/model-config-status?project_id=${projectId}`);
      if (!res.ok) return { configured: true };
      return res.json();
    },
    enabled: projectId != null && projectId > 0,
    staleTime: 60_000,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CBv2 — PIPELINE CONFIGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch saved pipeline configurations.
 */
export function useCBv2Configs() {
  return useQuery<CBv2PipelineConfig[]>({
    queryKey: queryKeys.cbv2.configs(),
    queryFn: async () => {
      const res = await authFetch(`/cb-api/configs`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : data.configs || [];
    },
    staleTime: 30_000,
  });
}

/**
 * Save a new pipeline configuration.
 */
export function useSaveCBv2Config() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await authFetch(`/cb-api/configs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save config");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.cbv2.configs() });
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CBv2 — SOURCE FILES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch workspace source files for the source control panel.
 */
export function useCBv2SourceFiles() {
  return useQuery<string[]>({
    queryKey: queryKeys.cbv2.sourceFiles(),
    queryFn: async () => {
      const res = await authFetch(`/cb-api/files`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : data.files || [];
    },
    staleTime: 30_000,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CBv2 — APPROVED ARTIFACTS (stories for a project)
// ═══════════════════════════════════════════════════════════════════════════

export interface CBv2ArtifactItem {
  id: number;
  artifact_type: string;
  title: string | null;
  content_id: string | null;
  is_approved: boolean;
  /** Star flag inherited from the source generation_run (Jobs dashboard). */
  run_is_selected?: boolean;
  /** Review flag inherited from the source generation_run (Jobs dashboard). */
  run_review_flag?: boolean;
  /** Extra fields that the backend may include and the UI surfaces. */
  description?: string | null;
  version?: number | null;
  run_id?: number | null;
  approval_status?: string | null;
  created_at?: string | null;
}

/**
 * Fetch approved story artifacts for a project (used by ChatContextSelector and ConfigPanel).
 */
export function useCBv2ApprovedArtifacts(projectId: number | null) {
  return useQuery<CBv2ArtifactItem[]>({
    queryKey: queryKeys.cbv2.approvedArtifacts(projectId ?? 0),
    queryFn: async () => {
      const res = await authFetch(
        `/api/v1/projects/${projectId}/artifacts?artifact_type=story&latest_only=true&approval_status=approved`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.artifacts ?? (Array.isArray(data) ? data : []);
    },
    enabled: projectId != null && projectId > 0,
    staleTime: 30_000,
  });
}

/**
 * Fetch ALL artifacts for a project (epics, features, stories) regardless
 * of approval status, so the User Stories picker shows the *full*
 * hierarchy — exactly like the User Stories Job Dashboard.
 *
 * Filtering by `approval_status=approved` here used to drop unapproved
 * child stories, which made approved features look like they had "0
 * stories". We rely on the UI to surface approval / star / flag state
 * via badges and filter chips instead.
 */
export function useCBv2AllApprovedArtifacts(projectId: number | null) {
  return useQuery<CBv2ArtifactItem[]>({
    queryKey: queryKeys.cbv2.allApprovedArtifacts(projectId ?? 0),
    queryFn: async () => {
      const res = await authFetch(
        `/api/v1/projects/${projectId}/artifacts?latest_only=true`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.artifacts ?? (Array.isArray(data) ? data : []);
    },
    enabled: projectId != null && projectId > 0,
    staleTime: 30_000,
  });
}

/**
 * Fetch design document artifacts from starred/selected runs. In Code Builder,
 * a Document Builder star is the approval signal for downstream consumption.
 *
 * NOTE: `architecture_synthesis` artifacts are *sibling metadata* that the
 * design pipeline saves alongside each HLD/LLD with a `parent_artifact_id`
 * pointing to the real document. The Document Builder dashboard hides them
 * and so do we — surfacing them as separate "documents" in the picker just
 * adds duplicates and confuses users.
 */
const DOCUMENT_ARTIFACT_TYPES = [
  "hld_document", "lld_document", "req_document", "requirements_document",
  "srs_document", "ddd_document", "api_spec_document", "test_plan_document",
] as const;

export function useProjectDocumentArtifacts(projectId: number | null) {
  return useQuery<CBv2ArtifactItem[]>({
    queryKey: queryKeys.cbv2.documentArtifacts(projectId ?? 0),
    queryFn: async () => {
      const res = await authFetch(
        `/api/v1/projects/${projectId}/artifacts?latest_only=true&selected_only=true`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      const arts: CBv2ArtifactItem[] = data.artifacts ?? (Array.isArray(data) ? data : []);
      // Keep only the canonical document types. We deliberately allow any
      // artifact_type that ends in `_document` so ad-hoc / custom doc
      // pipelines still surface; we only blacklist the synthesis sidecar.
      return arts.filter((a) => {
        const t = a.artifact_type ?? "";
        if (t === "architecture_synthesis") return false;
        return (
          DOCUMENT_ARTIFACT_TYPES.includes(t as typeof DOCUMENT_ARTIFACT_TYPES[number]) ||
          t.endsWith("_document")
        );
      });
    },
    enabled: projectId != null && projectId > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Delete a pipeline run. Optimistically removes from cache, then
 * invalidates to re-sync with the server.
 */
export function useDeletePipelineRun() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (runId: string) => deletePipelineRun(runId),
    onSuccess: (_data, runId) => {
      qc.setQueriesData<any[]>(
        { queryKey: queryKeys.codeBuilder.runs() },
        (old) => old?.filter((r) => r.run_id !== runId),
      );
      qc.invalidateQueries({ queryKey: queryKeys.codeBuilder.runs() });
    },
  });
}
