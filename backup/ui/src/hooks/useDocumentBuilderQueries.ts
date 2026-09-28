"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import {
  listDocumentJobsFromDB,
  getDocumentJobResult,
  getDocumentJobStatus,
  submitDocumentGeneration,
  deleteDocumentJobFromDB,
  markDocumentJobFlags,
  publishDocumentJob,
  getDocumentPublishStatus,
  analyzeRequirementInventory,
  uploadSourceDocument,
  fetchApprovedStories,
  fetchApprovedStorySessions,
  type DbDocumentJobItem,
  type DocJobStatus,
  type DocumentGenerationRequest,
  type RequirementInventoryAnalysisRequest,
} from "@/lib/document-api";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Unified row type that merges in-memory (DDG store) and DB-persisted jobs */
export interface DocumentJobRow {
  job_id: string;
  status: DocJobStatus;
  submitted_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  document_type: string | null;
  architecture_mode: string | null;
  quality: string | null;
  project_id: number | null;
  session_id: number | null;
  session_name: string | null;
  request_options: Record<string, unknown> | null;
  /** "memory" = from in-memory DDG store, "db" = from generation_runs table */
  _source: "memory" | "db";
  /** Max version number from document_versions table (>1 means regenerated) */
  version_count: number | null;
  /** Star flag inherited from generation_runs.is_selected. */
  is_selected: boolean;
  /** Review flag inherited from generation_runs.review_flag. */
  review_flag: boolean;
}

export type DocumentJobDisplayStatus =
  | "pending"
  | "running"
  | "completed"
  | "updated"
  | "failed"
  | "cancelled"
  | "regenerated";

export function getDocumentJobDisplayStatus(job: Pick<DocumentJobRow, "status" | "version_count">): DocumentJobDisplayStatus {
  if (job.status === "completed" && (job.version_count ?? 0) > 1) {
    return "regenerated";
  }
  return job.status;
}

export function getDocumentJobSummaryBucket(job: Pick<DocumentJobRow, "status" | "version_count">): "running" | "completed" | "failed" | "other" {
  if (job.status === "running" || job.status === "pending") {
    return "running";
  }
  if (job.status === "completed") {
    return "completed";
  }
  if (job.status === "failed" || job.status === "cancelled") {
    return "failed";
  }
  return "other";
}

function isDocJobActive(status?: string): boolean {
  return status === "running" || status === "pending";
}

const documentJobListQueryFilter = {
  predicate: (query: { queryKey: readonly unknown[] }) => {
    const key = query.queryKey;
    return (
      key[0] === "document-jobs" &&
      (key.length === 1 || (key.length === 2 && typeof key[1] === "object" && key[1] !== null))
    );
  },
};

/** Map DB-persisted document generation runs into rows for the jobs dashboard. */
function mapDbJobs(dbJobs: DbDocumentJobItem[]): DocumentJobRow[] {
  const rows: DocumentJobRow[] = [];

  for (const d of dbJobs) {
    const opts = d.request_options ?? {};
    rows.push({
      job_id: d.job_id,
      status: d.status as DocJobStatus,
      submitted_at: d.submitted_at,
      completed_at: d.completed_at,
      duration_seconds: d.duration_seconds,
      document_type: typeof opts.document_type === "string" ? opts.document_type : null,
      architecture_mode: typeof opts.architecture_mode === "string" ? opts.architecture_mode : null,
      quality: typeof opts.quality === "string" ? opts.quality : null,
      project_id: d.project_id,
      session_id: d.session_id,
      session_name: d.session_name,
      request_options: opts as Record<string, unknown>,
      _source: "db",
      version_count: d.version_count ?? null,
      is_selected: !!d.is_selected,
      review_flag: !!d.review_flag,
    });
  }
  rows.sort(
    (a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch DB-persisted document jobs.
 * Polls every `refetchInterval` ms while any job is active.
 */
export function useDocumentJobs(
  projectId?: number,
  opts?: { refetchInterval?: number },
) {
  const interval = opts?.refetchInterval ?? 15_000;

  return useQuery({
    queryKey: queryKeys.documents.jobs(projectId),
    queryFn: async (): Promise<DocumentJobRow[]> => {
      const dbJobs = await listDocumentJobsFromDB(projectId);
      return mapDbJobs(dbJobs);
    },
    staleTime: 10_000,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      if (!jobs) return interval;
      const hasActive = jobs.some((j) => isDocJobActive(j.status));
      return hasActive ? interval : false;
    },
  });
}

/**
 * Fetch document job result (sections, validation, execution summary).
 * Only fires once the job has completed. Results are cached indefinitely.
 */
export function useDocumentJobResult(
  jobId: string | null,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: queryKeys.documents.result(jobId ?? ""),
    queryFn: () => getDocumentJobResult(jobId!),
    enabled: (opts?.enabled ?? true) && !!jobId,
    staleTime: Infinity, // result never changes once done
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch document job status. Used by the result page for initial load
 * to determine if the job is completed/running/failed before fetching the result.
 */
export function useDocumentJobStatusOnce(jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.documents.status(jobId ?? ""),
    queryFn: () => getDocumentJobStatus(jobId!),
    enabled: !!jobId,
    staleTime: 5_000,
  });
}

/**
 * Fetch publish status for a document job.
 */
export function useDocumentPublishStatus(jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.documents.publishStatus(jobId ?? ""),
    queryFn: () => getDocumentPublishStatus(jobId!),
    enabled: !!jobId,
    staleTime: 10_000,
  });
}

/**
 * Fetch approved user stories for a project (LLD story-selection mode).
 */
export function useApprovedStories(projectId: number | null) {
  return useQuery({
    queryKey: queryKeys.documents.approvedStories(projectId ?? 0),
    queryFn: () => fetchApprovedStories(projectId!),
    enabled: (projectId ?? 0) > 0,
    staleTime: 30_000,
  });
}

/**
 * Fetch starred Story Builder sessions with approved user stories for a project.
 */
export function useApprovedStorySessions(projectId: number | null) {
  return useQuery({
    queryKey: queryKeys.documents.approvedStorySessions(projectId ?? 0),
    queryFn: () => fetchApprovedStorySessions(projectId!),
    enabled: (projectId ?? 0) > 0,
    staleTime: 30_000,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MUTATION HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Submit a document generation job.
 * On success, invalidates the document jobs list.
 */
export function useSubmitDocument() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (body: DocumentGenerationRequest) => submitDocumentGeneration(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.documents.jobs() });
    },
  });
}

export function useAnalyzeRequirementInventory() {
  return useMutation({
    mutationFn: (body: RequirementInventoryAnalysisRequest) => analyzeRequirementInventory(body),
  });
}

/**
 * Delete a document job.
 * Handles both in-memory and DB-persisted jobs.
 * Optimistically removes from cache with rollback on error.
 */
export function useDeleteDocumentJob() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      jobId,
    }: {
      jobId: string;
      source?: "memory" | "db";
    }) => {
      await deleteDocumentJobFromDB(jobId);
    },
    onMutate: async ({ jobId }) => {
      await qc.cancelQueries(documentJobListQueryFilter);
      const previousCaches = qc.getQueriesData<DocumentJobRow[]>(documentJobListQueryFilter);
      qc.setQueriesData<DocumentJobRow[]>(
        documentJobListQueryFilter,
        (old) => Array.isArray(old) ? old.filter((j) => j.job_id !== jobId) : old,
      );
      return { previousCaches };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousCaches) {
        for (const [key, data] of context.previousCaches) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: (_data, _error, variables) => {
      qc.invalidateQueries({ queryKey: queryKeys.documents.jobs() });
      if (variables?.jobId) {
        qc.removeQueries({ queryKey: queryKeys.documents.status(variables.jobId) });
        qc.removeQueries({ queryKey: queryKeys.documents.result(variables.jobId) });
        qc.removeQueries({ queryKey: queryKeys.documents.publishStatus(variables.jobId) });
      }
    },
  });
}

/**
 * Mark document job flags (star / review) with optimistic cache updates.
 * Uses the shared pipeline job flags endpoint backed by generation_runs.
 */
export function useMarkDocumentJobFlags() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({
      jobId,
      flags,
    }: {
      jobId: string;
      flags: { is_selected?: boolean; review_flag?: boolean };
    }) => markDocumentJobFlags(jobId, flags),
    onMutate: async ({ jobId, flags }) => {
      await qc.cancelQueries(documentJobListQueryFilter);
      const previousCaches = qc.getQueriesData<DocumentJobRow[]>(documentJobListQueryFilter);

      let affectedProjectId: number | null = null;
      for (const [, jobs] of previousCaches) {
        const match = jobs?.find((job) => job.job_id === jobId);
        if (match?.project_id != null) {
          affectedProjectId = match.project_id;
          break;
        }
      }

      qc.setQueriesData<DocumentJobRow[]>(
        documentJobListQueryFilter,
        (old) => {
          if (!Array.isArray(old)) return old;

          return old.map((job) => {
            if (job.job_id === jobId) {
              return {
                ...job,
                ...(flags.is_selected !== undefined ? { is_selected: flags.is_selected } : {}),
                ...(flags.review_flag !== undefined ? { review_flag: flags.review_flag } : {}),
              };
            }

            return job;
          });
        },
      );

      return { previousCaches, affectedProjectId };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousCaches) {
        for (const [key, data] of context.previousCaches) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: (_data, _error, _variables, context) => {
      qc.invalidateQueries({ queryKey: queryKeys.documents.jobs() });
      if (context?.affectedProjectId != null) {
        qc.invalidateQueries({ queryKey: queryKeys.cbv2.documentArtifacts(context.affectedProjectId) });
      } else {
        qc.invalidateQueries({ queryKey: ["cbv2", "document-artifacts"] });
      }
    },
  });
}

/**
 * Publish a document to Azure DevOps.
 * On success, invalidates publish status + jobs list.
 */
export function usePublishDocument(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: () => publishDocumentJob(jobId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.documents.publishStatus(jobId),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.documents.result(jobId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.documents.jobs() });
    },
  });
}

/**
 * Upload a source document for requirements generation.
 */
export function useUploadSourceDocument() {
  return useMutation({
    mutationFn: (params: { file: File; projectId?: number }) => uploadSourceDocument(params),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PREFETCH HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns a prefetch handler for hovering over a document job row.
 * Warms the status + result caches so navigation to the detail page
 * feels instant.
 */
export function usePrefetchDocumentJob() {
  const qc = useQueryClient();

  return (job: Pick<DocumentJobRow, "job_id" | "status">) => {
    qc.prefetchQuery({
      queryKey: queryKeys.documents.status(job.job_id),
      queryFn: () => getDocumentJobStatus(job.job_id),
      staleTime: 10_000,
    });

    if (job.status === "completed") {
      qc.prefetchQuery({
        queryKey: queryKeys.documents.result(job.job_id),
        queryFn: () => getDocumentJobResult(job.job_id),
        staleTime: 30_000,
      });
    }
  };
}
