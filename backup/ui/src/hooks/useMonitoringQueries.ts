"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import {
  getHealth,
  getDbMonitorSummary,
  getDbMonitorRecent,
  getStandards,
  type HealthResponse,
  type DbMonitorSummary,
  type DbMonitorRecent,
  type StandardsInfo,
} from "@/lib/api";
import { authFetch } from "@/lib/auth";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

export interface StandardsSummaryItem {
  type: string;
  total_entities: number;
  with_embeddings: number;
  embedding_coverage_pct: number;
}

export interface StandardsSummaryData {
  summary: StandardsSummaryItem[];
  tmfStandards: StandardsInfo[];
}

export interface CodeStatus {
  stored: boolean;
  total_files?: number;
  total_chunks?: number;
  files?: string[];
  graph_summary?: { total_nodes: number; total_edges: number };
  message?: string;
  error?: string;
}

export interface DocStatus {
  stored: boolean;
  total_chunks?: number;
  total_source_files?: number;
  source_files?: string[];
  content_type_counts?: Record<string, number>;
  message?: string;
  error?: string;
}

export interface FigmaStatus {
  stored: boolean;
  files_processed?: number;
  total_chunks?: number;
  chunks_added?: number;
  files?: string[];
  message?: string;
  error?: string;
}

export interface IngestStatusData {
  code: CodeStatus | null;
  docs: DocStatus | null;
  figma: FigmaStatus | null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════════════════════════════

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: queryKeys.health(),
    queryFn: getHealth,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  DB MONITOR
// ═══════════════════════════════════════════════════════════════════════════

export function useDbMonitorSummary() {
  return useQuery<DbMonitorSummary>({
    queryKey: queryKeys.admin.dbMonitor(),
    queryFn: getDbMonitorSummary,
    refetchInterval: 60_000,
  });
}

export function useDbMonitorRecent(filters: {
  errorsOnly?: boolean;
  queryType?: string;
  tableName?: string;
}, enabled = true) {
  const filterKey: Record<string, unknown> = {};
  if (filters.errorsOnly) filterKey.errorsOnly = true;
  if (filters.queryType) filterKey.queryType = filters.queryType;
  if (filters.tableName) filterKey.tableName = filters.tableName;

  return useQuery<DbMonitorRecent>({
    queryKey: queryKeys.admin.dbRecent(filterKey),
    queryFn: () => getDbMonitorRecent({
      limit: 100,
      errorsOnly: filters.errorsOnly,
      queryType: filters.queryType || undefined,
      tableName: filters.tableName || undefined,
    }),
    enabled,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  STANDARDS
// ═══════════════════════════════════════════════════════════════════════════

export function useStandardsSummary() {
  return useQuery<StandardsSummaryData>({
    queryKey: queryKeys.standardsSummary(),
    queryFn: async () => {
      const [summaryRes, tmfData] = await Promise.all([
        authFetch(`${API}/api/v1/standards`, {}, { silent: true }).then(r => r.ok ? r.json() : { standards: [] }),
        getStandards().catch(() => [] as StandardsInfo[]),
      ]);
      return {
        summary: summaryRes.standards ?? [],
        tmfStandards: Array.isArray(tmfData) ? tmfData : [],
      };
    },
    staleTime: 5 * 60_000, // 5 minutes — standards change only via explicit ingest
    refetchOnWindowFocus: false,
  });
}

export function useTriggerStandardsIngest() {
  const qc = useQueryClient();
  return useMutation<
    { message: string },
    Error,
    { standards_type: string; force_reingest: boolean }
  >({
    mutationFn: async (payload) => {
      const res = await authFetch(`${API}/api/v1/standards/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Ingest failed");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.standardsSummary() });
      qc.invalidateQueries({ queryKey: queryKeys.standards() });
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  INGEST STATUS
// ═══════════════════════════════════════════════════════════════════════════

export function useIngestStatus(projectId: number) {
  return useQuery<IngestStatusData>({
    queryKey: queryKeys.ingest.status(projectId),
    queryFn: async () => {
      const [codeRes, docRes, figmaRes] = await Promise.allSettled([
        authFetch(`${API}/api/v1/ingest/code/status?project_id=${projectId}`, {}, { silent: true }).then(r => r.json()),
        authFetch(`${API}/api/v1/ingest/docs/status?project_id=${projectId}`, {}, { silent: true }).then(r => r.json()),
        authFetch(`${API}/api/v1/ingest/figma/status?project_id=${projectId}`, {}, { silent: true }).then(r => r.json()),
      ]);
      return {
        code: codeRes.status === "fulfilled" ? codeRes.value : null,
        docs: docRes.status === "fulfilled" ? docRes.value : null,
        figma: figmaRes.status === "fulfilled" ? figmaRes.value : null,
      };
    },
    enabled: projectId > 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  HISTORY PANEL (CBv2 / Legacy Modernization runs)
// ═══════════════════════════════════════════════════════════════════════════

const CODEBUILDER_API_BASE = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";
const LEGACY_API_BASE = "/lm-api";

export function useHistoryPanelRuns(
  mode: "codebuilder" | "legacy-modernization",
  projectId?: number | null,
  sessionId?: number | null,
) {
  return useQuery<import("@/types/code-builder-v2").CBv2PipelineRun[]>({
    queryKey: queryKeys.historyPanel(mode, projectId, sessionId),
    queryFn: async () => {
      let url = mode === "legacy-modernization"
        ? `${LEGACY_API_BASE}/legacy-modernization/runs`
        : `${CODEBUILDER_API_BASE}/runs`;
      const params = new URLSearchParams();
      if (projectId) params.set("project_id", String(projectId));
      if (sessionId) params.set("session_id", String(sessionId));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      const res = await authFetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : data.runs || [];
    },
    // The list of pipeline runs is short-lived data that the user expects to
    // always reflect the latest backend state. Override the global 60s
    // staleTime so manual refreshes and focus/reconnect refetches actually
    // hit the network.
    staleTime: 0,
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (!runs) return 10_000;
      const hasActive = runs.some(
        (r) => r.status === "running" || r.status === "pending",
      );
      return hasActive ? 10_000 : false;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CODE GRAPH (on-demand fetch for ingest page)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch code dependency graph for a project.
 * Disabled by default — enable via `enabled` option or refetch on demand.
 */
export function useCodeGraph(projectId: number | null, opts?: { enabled?: boolean }) {
  return useQuery<Record<string, unknown>>({
    queryKey: queryKeys.ingest.codeGraph(projectId ?? 0),
    queryFn: async () => {
      const res = await authFetch(`${API}/api/v1/ingest/code/graph?project_id=${projectId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail ?? "Failed to load graph");
      }
      return res.json();
    },
    enabled: (opts?.enabled ?? false) && projectId != null && projectId > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
