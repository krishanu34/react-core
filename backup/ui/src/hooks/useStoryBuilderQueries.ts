"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import {
  listJobs,
  getJobStatus,
  getJobResult,
  getJobArtifactMap,
  getStoryImpact,
  decideStoryImpact,
  submitPipeline,
  deleteJob,
  markJobFlags,
  approveArtifact,
  unapproveArtifact,
  refineArtifact,
  selectVersion,
  publishJob,
  getPublishStatus,
  getArtifactVersions,
  type PipelineOptions,
  type JobListItem,
  type JobStatus,  type ArtifactMap, type StoryImpactDecision,} from "@/lib/api";
import {
  getDocumentJobStatus,
  type DocJobStatus,
} from "@/lib/document-api";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Returns true while the job is still in progress */
function isJobActive(status?: string): boolean {
  return status === "running" || status === "pending" || status === "queued";
}

function isJobCompleted(status?: string): boolean {
  return status === "completed" || status === "updated";
}

const jobListQueryFilter = {
  predicate: (query: { queryKey: readonly unknown[] }) => {
    const key = query.queryKey;
    return (
      key[0] === "jobs" &&
      (key.length === 1 || (key.length === 2 && typeof key[1] === "object" && key[1] !== null))
    );
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  QUERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List pipeline jobs for a project (and optionally a session).
 * Polls every `refetchInterval` ms while any job is running.
 */
export function useJobs(
  projectId?: number,
  sessionId?: number,
  opts?: { refetchInterval?: number },
) {
  const interval = opts?.refetchInterval ?? 15_000;

  return useQuery({
    queryKey: queryKeys.jobs.list(projectId, sessionId),
    queryFn: () => listJobs(projectId, sessionId),
    staleTime: 10_000,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      if (!jobs) return interval;
      const hasActive = jobs.some((j) => isJobActive(j.status));
      return hasActive ? interval : false; // stop polling once all done
    },
  });
}

/**
 * Fetch the status of a single pipeline job.
 * Polls every `refetchInterval` ms (default 3 s) while running.
 */
export function useJobStatus(jobId: string | null, opts?: { refetchInterval?: number }) {
  const interval = opts?.refetchInterval ?? 3_000;

  return useQuery({
    queryKey: queryKeys.jobs.status(jobId ?? ""),
    queryFn: () => getJobStatus(jobId!),
    enabled: !!jobId,
    staleTime: 2_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return isJobActive(status) ? interval : false;
    },
  });
}

/**
 * Fetch job result (epics, features, stories).
 * Only fires once the job has completed.
 */
export function useJobResult(jobId: string | null, jobStatus?: JobStatus) {
  return useQuery({
    queryKey: queryKeys.jobs.result(jobId ?? ""),
    queryFn: () => getJobResult(jobId!),
    enabled: !!jobId && isJobCompleted(jobStatus),
    staleTime: Infinity, // result never changes once done
    refetchOnWindowFocus: false,
  });
}

export function useStoryImpact(jobId: string | null, jobStatus?: JobStatus) {
  return useQuery({
    queryKey: queryKeys.jobs.storyImpact(jobId ?? ""),
    queryFn: () => getStoryImpact(jobId!),
    enabled: !!jobId && isJobCompleted(jobStatus),
    staleTime: 30_000,
  });
}

/**
 * Fetch the artifact map (content-id → db artifact) for a job.
 */
export function useArtifactMap(jobId: string | null, jobStatus?: JobStatus) {
  return useQuery({
    queryKey: queryKeys.jobs.artifactMap(jobId ?? ""),
    queryFn: () => getJobArtifactMap(jobId!),
    enabled: !!jobId && isJobCompleted(jobStatus),
    staleTime: 30_000,
  });
}

/**
 * Fetch publish status for a job.
 */
export function usePublishStatus(jobId: string | null, jobStatus?: JobStatus) {
  return useQuery({
    queryKey: queryKeys.jobs.publishStatus(jobId ?? ""),
    queryFn: () => getPublishStatus(jobId!),
    enabled: !!jobId && isJobCompleted(jobStatus),
    staleTime: 10_000,
  });
}

/**
 * Fetch version history for an artifact.
 */
export function useArtifactVersions(artifactId: number | null) {
  return useQuery({
    queryKey: queryKeys.artifactVersions(artifactId ?? 0),
    queryFn: () => getArtifactVersions(artifactId!),
    enabled: (artifactId ?? 0) > 0,
    staleTime: 30_000,
  });
}

/**
 * Document job status polling (replaces setInterval in DocumentProgress).
 * Polls every `pollInterval` ms while the document job is active.
 */
export function useDocumentJobStatus(
  jobId: string | null,
  opts?: { pollInterval?: number },
) {
  const interval = opts?.pollInterval ?? 2_000;

  return useQuery({
    queryKey: queryKeys.documents.status(jobId ?? ""),
    queryFn: () => getDocumentJobStatus(jobId!),
    enabled: !!jobId,
    staleTime: 1_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status as DocJobStatus | undefined;
      return status === "completed" || status === "updated" || status === "failed" || status === "cancelled" ? false : interval;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MUTATION HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Submit a pipeline (story generation).
 * On success, invalidates the jobs list so the new job appears.
 */
export function useSubmitPipeline() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ files, options, confluenceUrls }: { files: File[]; options: PipelineOptions; confluenceUrls?: string[] }) =>
      submitPipeline(files, options, confluenceUrls ?? []),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.list(vars.options.project_id) });
    },
  });
}

/**
 * Delete a pipeline job.
 * Optimistically removes from all job list caches with rollback on error.
 */
export function useDeleteJob() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => deleteJob(jobId),
    onMutate: async (jobId) => {
      await qc.cancelQueries(jobListQueryFilter);
      const previousCaches = qc.getQueriesData<JobListItem[]>(jobListQueryFilter);
      qc.setQueriesData<JobListItem[]>(
        jobListQueryFilter,
        (old) => Array.isArray(old) ? old.filter((j) => j.job_id !== jobId) : old,
      );
      return { previousCaches };
    },
    onError: (_err, _jobId, context) => {
      if (context?.previousCaches) {
        for (const [key, data] of context.previousCaches) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: (_data, _error, jobId) => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      if (jobId) {
        qc.removeQueries({ queryKey: queryKeys.jobs.status(jobId) });
        qc.removeQueries({ queryKey: queryKeys.jobs.result(jobId) });
        qc.removeQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
        qc.removeQueries({ queryKey: queryKeys.jobs.publishStatus(jobId) });
      }
    },
  });
}

/**
 * Approve an artifact (with optional cascade).
 * Optimistically marks the artifact as approved in the cache, then
 * revalidates on settle. Rolls back on error.
 */
export function useApproveArtifact(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ artifactId, cascade }: { artifactId: number; cascade?: boolean }) =>
      approveArtifact(artifactId, cascade ?? true),
    onMutate: async ({ artifactId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
      const previous = qc.getQueryData<ArtifactMap>(queryKeys.jobs.artifactMap(jobId));
      if (previous) {
        qc.setQueryData<ArtifactMap>(queryKeys.jobs.artifactMap(jobId), (old) => {
          if (!old) return old;
          const updated = { ...old };
          for (const [key, entry] of Object.entries(updated)) {
            if (entry.db_id === artifactId || entry.parent_artifact_db_id === artifactId) {
              updated[key] = { ...entry, is_approved: true };
            }
          }
          return updated;
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(queryKeys.jobs.artifactMap(jobId), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
      qc.invalidateQueries({ queryKey: queryKeys.jobs.publishStatus(jobId) });
    },
  });
}

/**
 * Unapprove an artifact (with optional cascade).
 * Optimistically marks the artifact as unapproved in the cache, then
 * revalidates on settle. Rolls back on error.
 */
export function useUnapproveArtifact(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ artifactId, cascade }: { artifactId: number; cascade?: boolean }) =>
      unapproveArtifact(artifactId, cascade ?? true),
    onMutate: async ({ artifactId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
      const previous = qc.getQueryData<ArtifactMap>(queryKeys.jobs.artifactMap(jobId));
      if (previous) {
        qc.setQueryData<ArtifactMap>(queryKeys.jobs.artifactMap(jobId), (old) => {
          if (!old) return old;
          const updated = { ...old };
          for (const [key, entry] of Object.entries(updated)) {
            if (entry.db_id === artifactId || entry.parent_artifact_db_id === artifactId) {
              updated[key] = { ...entry, is_approved: false };
            }
          }
          return updated;
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(queryKeys.jobs.artifactMap(jobId), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
      qc.invalidateQueries({ queryKey: queryKeys.jobs.publishStatus(jobId) });
    },
  });
}

export function useStoryImpactDecision(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ changeId, decision }: { changeId: string; decision: StoryImpactDecision }) =>
      decideStoryImpact(jobId, changeId, decision),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.storyImpact(jobId) });
    },
  });
}

/**
 * Select a specific version as the active/latest version.
 * Invalidates artifact map + versions.
 */
export function useSelectVersion(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ artifactId, versionId }: { artifactId: number; versionId: number }) =>
      selectVersion(artifactId, versionId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
      qc.invalidateQueries({ queryKey: queryKeys.artifactVersions(vars.artifactId) });
    },
  });
}

/**
 * Refine an artifact with user feedback.
 * Invalidates artifact map + versions.
 */
export function useRefineArtifact(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ artifactId, body }: { artifactId: number; body: Parameters<typeof refineArtifact>[1] }) =>
      refineArtifact(artifactId, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
      qc.invalidateQueries({ queryKey: queryKeys.artifactVersions(vars.artifactId) });
    },
  });
}

/**
 * Publish a job to Jira / ADO.
 * Invalidates publish status.
 */
export function usePublishJob(jobId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (options?: { projectKey?: string }) => publishJob(jobId, options),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.jobs.publishStatus(jobId) });
      qc.invalidateQueries({ queryKey: queryKeys.jobs.artifactMap(jobId) });
    },
  });
}

/**
 * Mark job flags (is_selected / review_flag) with optimistic cache update.
 */
export function useMarkJobFlags() {
  const qc = useQueryClient();

  // Predicate that matches only job *list* queries — ["jobs", { projectId, sessionId }].
  // Excludes individual job sub-queries such as ["jobs", jobId, "status"] / "result" / etc.
  // whose cached value is NOT a JobListItem[] array, which would cause old.map() to throw
  // inside the setQueriesData updater if left unfiltered.
  const jobListFilter = {
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const key = query.queryKey;
      return (
        key.length === 2 &&
        key[0] === "jobs" &&
        typeof key[1] === "object" &&
        key[1] !== null &&
        !Array.isArray(key[1])
      );
    },
  };

  return useMutation({
    mutationFn: ({ jobId, flags }: { jobId: string; flags: { is_selected?: boolean; review_flag?: boolean } }) =>
      markJobFlags(jobId, flags),
    onMutate: async ({ jobId, flags }) => {
      // Cancel any outgoing list refetches so they don't overwrite our optimistic update.
      // Scoped to list queries only — avoids interrupting individual job status polling.
      await qc.cancelQueries(jobListFilter);

      // Snapshot all job list caches
      const previousCaches = qc.getQueriesData<JobListItem[]>(jobListFilter);
      let affectedProjectId: number | null = null;
      for (const [, jobs] of previousCaches) {
        const match = jobs?.find((job) => job.job_id === jobId);
        if (match?.project_id != null) {
          affectedProjectId = match.project_id;
          break;
        }
      }

      // Optimistically update every matching job list cache.
      // Guard with Array.isArray instead of truthiness check: non-list caches (status objects,
      // result objects) are truthy but not arrays — calling .map() on them would throw and
      // abort onMutate before the mutation function ever fires.
      qc.setQueriesData<JobListItem[]>(jobListFilter, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map((j) => {
          if (j.job_id === jobId) {
            return { ...j, ...flags };
          }
          // When starring a job, unstar other jobs in the same session
          if (flags.is_selected) {
            const target = old.find((x) => x.job_id === jobId);
            if (target && j.session_id === target.session_id && j.job_id !== jobId) {
              return { ...j, is_selected: false };
            }
          }
          return j;
        });
      });

      return { previousCaches, affectedProjectId };
    },
    onError: (_err, _vars, context) => {
      // Roll back on error
      if (context?.previousCaches) {
        for (const [key, data] of context.previousCaches) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: (_data, _error, _variables, context) => {
      // Invalidate only list queries so individual job status/result polling is not disrupted.
      qc.invalidateQueries(jobListFilter);
      if (context?.affectedProjectId != null) {
        qc.invalidateQueries({ queryKey: queryKeys.cbv2.approvedArtifacts(context.affectedProjectId) });
        qc.invalidateQueries({ queryKey: queryKeys.cbv2.allApprovedArtifacts(context.affectedProjectId) });
      } else {
        qc.invalidateQueries({ queryKey: ["cbv2", "approved-artifacts"] });
        qc.invalidateQueries({ queryKey: ["cbv2", "all-approved-artifacts"] });
      }
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PREFETCH HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns a prefetch handler for hovering over a job row in the list.
 * Warms the job-status + job-result caches so navigation feels instant.
 */
export function usePrefetchJobDetail() {
  const qc = useQueryClient();

  return (jobId: string, jobStatus?: JobStatus) => {
    qc.prefetchQuery({
      queryKey: queryKeys.jobs.status(jobId),
      queryFn: () => getJobStatus(jobId),
      staleTime: 10_000,
    });

    if (!isJobCompleted(jobStatus)) {
      return;
    }

    qc.prefetchQuery({
      queryKey: queryKeys.jobs.result(jobId),
      queryFn: () => getJobResult(jobId),
      staleTime: 30_000,
    });
  };
}
