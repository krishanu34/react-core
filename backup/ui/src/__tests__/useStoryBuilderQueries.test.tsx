import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach } from "vitest";

/* ── Mock api modules ────────────────────────────────────────────────── */

const mockListJobs = vi.fn();
const mockGetJobStatus = vi.fn();
const mockGetJobResult = vi.fn();
const mockGetJobArtifactMap = vi.fn();
const mockSubmitPipeline = vi.fn();
const mockDeleteJob = vi.fn();
const mockApproveArtifact = vi.fn();
const mockUnapproveArtifact = vi.fn();
const mockRefineArtifact = vi.fn();
const mockPublishJob = vi.fn();
const mockGetPublishStatus = vi.fn();
const mockGetArtifactVersions = vi.fn();

vi.mock("@/lib/api", () => ({
  listJobs: (...args: unknown[]) => mockListJobs(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  getJobResult: (...args: unknown[]) => mockGetJobResult(...args),
  getJobArtifactMap: (...args: unknown[]) => mockGetJobArtifactMap(...args),
  submitPipeline: (...args: unknown[]) => mockSubmitPipeline(...args),
  deleteJob: (...args: unknown[]) => mockDeleteJob(...args),
  approveArtifact: (...args: unknown[]) => mockApproveArtifact(...args),
  unapproveArtifact: (...args: unknown[]) => mockUnapproveArtifact(...args),
  refineArtifact: (...args: unknown[]) => mockRefineArtifact(...args),
  publishJob: (...args: unknown[]) => mockPublishJob(...args),
  getPublishStatus: (...args: unknown[]) => mockGetPublishStatus(...args),
  getArtifactVersions: (...args: unknown[]) => mockGetArtifactVersions(...args),
}));

const mockGetDocumentJobStatus = vi.fn();

vi.mock("@/lib/document-api", () => ({
  getDocumentJobStatus: (...args: unknown[]) => mockGetDocumentJobStatus(...args),
}));

import {
  useJobs,
  useJobStatus,
  useJobResult,
  useArtifactMap,
  usePublishStatus,
  useArtifactVersions,
  useDocumentJobStatus,
  useSubmitPipeline,
  useDeleteJob,
  useApproveArtifact,
  useUnapproveArtifact,
  useRefineArtifact,
  usePublishJob,
  usePrefetchJobDetail,
} from "@/hooks/useStoryBuilderQueries";

/* ── Helpers ──────────────────────────────────────────────────────────── */

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { Wrapper, qc };
}

const sampleJobs = [
  { job_id: "j1", status: "completed", project_id: 1, session_id: null, created_at: "2024-01-01" },
  { job_id: "j2", status: "running", project_id: 1, session_id: null, created_at: "2024-01-02" },
];

const sampleStatusCompleted = { job_id: "j1", status: "completed", progress: 100, stages: [] };
const sampleStatusRunning = { job_id: "j2", status: "running", progress: 50, stages: [] };

const sampleResult = { epics: [{ id: "e1", name: "Epic 1" }] };
const sampleArtifactMap = { "content-1": { artifact_id: 10, approved: false } };
const samplePublishStatus = { published: false, publish_url: null };

/* ═══════════════════════════════════════════════════════════════════════
   QUERY HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useJobs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches jobs list and exposes data", async () => {
    mockListJobs.mockResolvedValueOnce(sampleJobs);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobs(1), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(mockListJobs).toHaveBeenCalledWith(1, undefined);
  });

  it("fetches without projectId (all projects)", async () => {
    mockListJobs.mockResolvedValueOnce(sampleJobs);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(mockListJobs).toHaveBeenCalledWith(undefined, undefined);
  });

  it("passes sessionId to listJobs", async () => {
    mockListJobs.mockResolvedValueOnce([]);
    const { Wrapper } = createWrapper();

    renderHook(() => useJobs(1, 5), { wrapper: Wrapper });
    await waitFor(() => expect(mockListJobs).toHaveBeenCalledWith(1, 5));
  });

  it("deduplicates concurrent mounts with the same key", async () => {
    mockListJobs.mockResolvedValue(sampleJobs);
    const { Wrapper } = createWrapper();

    const { result: r1 } = renderHook(() => useJobs(1), { wrapper: Wrapper });
    const { result: r2 } = renderHook(() => useJobs(1), { wrapper: Wrapper });

    await waitFor(() => {
      expect(r1.current.isLoading).toBe(false);
      expect(r2.current.isLoading).toBe(false);
    });

    expect(mockListJobs).toHaveBeenCalledTimes(1);
  });

  it("handles fetch error gracefully", async () => {
    mockListJobs.mockRejectedValueOnce(new Error("Network error"));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobs(1), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("Network error");
    expect(result.current.data).toBeUndefined();
  });
});

/* ── useJobStatus ──────────────────────────────────────────────────── */

describe("useJobStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches job status when jobId is provided", async () => {
    mockGetJobStatus.mockResolvedValueOnce(sampleStatusRunning);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobStatus("j2"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.status).toBe("running");
    expect(mockGetJobStatus).toHaveBeenCalledWith("j2");
  });

  it("does not fetch when jobId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobStatus(null), { wrapper: Wrapper });

    // Should stay idle (not loading, not fetching)
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetJobStatus).not.toHaveBeenCalled();
  });

  it("returns completed status and data", async () => {
    mockGetJobStatus.mockResolvedValueOnce(sampleStatusCompleted);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobStatus("j1"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("completed"));

    expect(result.current.data?.progress).toBe(100);
  });
});

/* ── useJobResult ──────────────────────────────────────────────────── */

describe("useJobResult", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches result when job is completed", async () => {
    mockGetJobResult.mockResolvedValueOnce(sampleResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobResult("j1", "completed"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(sampleResult);
    expect(mockGetJobResult).toHaveBeenCalledWith("j1");
  });

  it("does not fetch when job is still running", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobResult("j2", "running"), { wrapper: Wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetJobResult).not.toHaveBeenCalled();
  });

  it("does not fetch when jobId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useJobResult(null, "completed"), { wrapper: Wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetJobResult).not.toHaveBeenCalled();
  });
});

/* ── useArtifactMap ────────────────────────────────────────────────── */

describe("useArtifactMap", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches artifact map when completed", async () => {
    mockGetJobArtifactMap.mockResolvedValueOnce(sampleArtifactMap);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useArtifactMap("j1", "completed"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(sampleArtifactMap));

    expect(mockGetJobArtifactMap).toHaveBeenCalledWith("j1");
  });

  it("stays disabled when status is running", async () => {
    const { Wrapper } = createWrapper();

    renderHook(() => useArtifactMap("j2", "running"), { wrapper: Wrapper });
    expect(mockGetJobArtifactMap).not.toHaveBeenCalled();
  });
});

/* ── useDocumentJobStatus ──────────────────────────────────────────── */

describe("useDocumentJobStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches document job status", async () => {
    mockGetDocumentJobStatus.mockResolvedValueOnce({ status: "running", progress: 40, stages: [] });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobStatus("dj1"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("running"));
  });

  it("does not fetch when jobId is null", async () => {
    const { Wrapper } = createWrapper();

    renderHook(() => useDocumentJobStatus(null), { wrapper: Wrapper });
    expect(mockGetDocumentJobStatus).not.toHaveBeenCalled();
  });
});

/* ── usePublishStatus ──────────────────────────────────────────────── */

describe("usePublishStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches publish status for completed job", async () => {
    mockGetPublishStatus.mockResolvedValueOnce(samplePublishStatus);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePublishStatus("j1", "completed"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(samplePublishStatus));
  });

  it("stays disabled when job is not completed", async () => {
    const { Wrapper } = createWrapper();

    renderHook(() => usePublishStatus("j1", "running"), { wrapper: Wrapper });
    expect(mockGetPublishStatus).not.toHaveBeenCalled();
  });
});

/* ── useArtifactVersions ───────────────────────────────────────────── */

describe("useArtifactVersions", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches versions for a valid artifact id", async () => {
    const versions = [{ version: 1, content: "v1" }];
    mockGetArtifactVersions.mockResolvedValueOnce(versions);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useArtifactVersions(10), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(versions));

    expect(mockGetArtifactVersions).toHaveBeenCalledWith(10);
  });

  it("does not fetch when artifactId is null", async () => {
    const { Wrapper } = createWrapper();

    renderHook(() => useArtifactVersions(null), { wrapper: Wrapper });
    expect(mockGetArtifactVersions).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   MUTATION HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useSubmitPipeline", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls submitPipeline and invalidates job list cache", async () => {
    const submitResult = { job_id: "j3", status: "pending" };
    mockSubmitPipeline.mockResolvedValueOnce(submitResult);
    // After invalidation, jobs list will be refetched
    mockListJobs.mockResolvedValue([...sampleJobs, submitResult]);

    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useSubmitPipeline(), { wrapper: Wrapper });

    const file = new File(["content"], "test.txt", { type: "text/plain" });
    const options = { project_id: 1 } as Parameters<typeof mockSubmitPipeline>[1];

    await act(async () => {
      await result.current.mutateAsync({ files: [file], options });
    });

    expect(mockSubmitPipeline).toHaveBeenCalledWith([file], options);
    expect(invalidateSpy).toHaveBeenCalled();
  });
});

describe("useDeleteJob", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls deleteJob and invalidates jobs cache", async () => {
    mockDeleteJob.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDeleteJob(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync("j1");
    });

    expect(mockDeleteJob).toHaveBeenCalledWith("j1");
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("clears per-job caches after delete", async () => {
    mockDeleteJob.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();
    const removeSpy = vi.spyOn(qc, "removeQueries");

    const { result } = renderHook(() => useDeleteJob(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync("j1");
    });

    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["jobs", "j1", "status"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["jobs", "j1", "result"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["jobs", "j1", "artifact-map"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["jobs", "j1", "publish-status"] });
  });

  it("does not apply list filtering to non-list job caches", async () => {
    mockDeleteJob.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();

    qc.setQueryData(["jobs", "j1", "status"], { job_id: "j1", status: "completed" });

    const { result } = renderHook(() => useDeleteJob(), { wrapper: Wrapper });

    await expect(result.current.mutateAsync("j1")).resolves.toBeUndefined();
    expect(mockDeleteJob).toHaveBeenCalledWith("j1");
  });
});

describe("useApproveArtifact", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls approveArtifact and invalidates artifact map + publish status", async () => {
    mockApproveArtifact.mockResolvedValueOnce({ success: true });
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useApproveArtifact("j1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ artifactId: 10, cascade: true });
    });

    expect(mockApproveArtifact).toHaveBeenCalledWith(10, true);
    // Should invalidate both artifact map and publish status (onSettled)
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("optimistically sets is_approved=true in artifact map cache", async () => {
    let resolveApprove: (v: unknown) => void;
    mockApproveArtifact.mockImplementation(() => new Promise((r) => { resolveApprove = r; }));

    const { Wrapper, qc } = createWrapper();
    // Seed the artifact map cache
    const initialMap = {
      "STORY-001": { db_id: 10, artifact_type: "story", is_approved: false, version: 1, parent_artifact_db_id: null },
      "STORY-002": { db_id: 20, artifact_type: "story", is_approved: false, version: 1, parent_artifact_db_id: 10 },
    };
    qc.setQueryData(["jobs", "j1", "artifact-map"], initialMap);

    const { result } = renderHook(() => useApproveArtifact("j1"), { wrapper: Wrapper });

    // Trigger mutation (don't await — mutation is in-flight)
    act(() => { result.current.mutate({ artifactId: 10, cascade: true }); });

    // Optimistic: cache should be updated immediately
    await waitFor(() => {
      const map = qc.getQueryData<Record<string, any>>(["jobs", "j1", "artifact-map"]);
      expect(map?.["STORY-001"]?.is_approved).toBe(true);
      // Cascade: children with parent_artifact_db_id matching should also be approved
      expect(map?.["STORY-002"]?.is_approved).toBe(true);
    });

    // Resolve the API call
    await act(async () => { resolveApprove!({ approved_ids: [10, 20], count: 2 }); });
  });

  it("rolls back cache on API error", async () => {
    mockApproveArtifact.mockRejectedValueOnce(new Error("Server error"));

    const { Wrapper, qc } = createWrapper();
    const initialMap = {
      "STORY-001": { db_id: 10, artifact_type: "story", is_approved: false, version: 1, parent_artifact_db_id: null },
    };
    qc.setQueryData(["jobs", "j1", "artifact-map"], initialMap);

    const { result } = renderHook(() => useApproveArtifact("j1"), { wrapper: Wrapper });

    await act(async () => {
      try { await result.current.mutateAsync({ artifactId: 10, cascade: true }); } catch {}
    });

    // Cache should be rolled back to original
    await waitFor(() => {
      const map = qc.getQueryData<Record<string, any>>(["jobs", "j1", "artifact-map"]);
      expect(map?.["STORY-001"]?.is_approved).toBe(false);
    });
  });
});

describe("useUnapproveArtifact", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls unapproveArtifact and invalidates caches", async () => {
    mockUnapproveArtifact.mockResolvedValueOnce({ success: true });
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useUnapproveArtifact("j1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ artifactId: 10, cascade: false });
    });

    expect(mockUnapproveArtifact).toHaveBeenCalledWith(10, false);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("optimistically sets is_approved=false in artifact map cache", async () => {
    let resolveUnapprove: (v: unknown) => void;
    mockUnapproveArtifact.mockImplementation(() => new Promise((r) => { resolveUnapprove = r; }));

    const { Wrapper, qc } = createWrapper();
    const initialMap = {
      "STORY-001": { db_id: 10, artifact_type: "story", is_approved: true, version: 1, parent_artifact_db_id: null },
    };
    qc.setQueryData(["jobs", "j1", "artifact-map"], initialMap);

    const { result } = renderHook(() => useUnapproveArtifact("j1"), { wrapper: Wrapper });

    act(() => { result.current.mutate({ artifactId: 10, cascade: true }); });

    await waitFor(() => {
      const map = qc.getQueryData<Record<string, any>>(["jobs", "j1", "artifact-map"]);
      expect(map?.["STORY-001"]?.is_approved).toBe(false);
    });

    await act(async () => { resolveUnapprove!({ unapproved_ids: [10], count: 1 }); });
  });
});

describe("useRefineArtifact", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls refineArtifact and invalidates artifact map + versions", async () => {
    mockRefineArtifact.mockResolvedValueOnce({ success: true });
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useRefineArtifact("j1"), { wrapper: Wrapper });

    const body = { user_feedback: "Make it shorter" };
    await act(async () => {
      await result.current.mutateAsync({ artifactId: 10, body });
    });

    expect(mockRefineArtifact).toHaveBeenCalledWith(10, body);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});

describe("usePublishJob", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls publishJob and invalidates publish status + artifact map", async () => {
    mockPublishJob.mockResolvedValueOnce({ success: true, url: "https://jira.example.com" });
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => usePublishJob("j1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ projectKey: "PROJ" });
    });

    expect(mockPublishJob).toHaveBeenCalledWith("j1", { projectKey: "PROJ" });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("handles publish without options", async () => {
    mockPublishJob.mockResolvedValueOnce({ success: true });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePublishJob("j1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync(undefined);
    });

    expect(mockPublishJob).toHaveBeenCalledWith("j1", undefined);
  });
});

/* ── usePrefetchJobDetail ─────────────────────────────────────────── */

describe("usePrefetchJobDetail", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("prefetches job status and result into cache for completed jobs", async () => {
    mockGetJobStatus.mockResolvedValueOnce(sampleStatusCompleted);
    mockGetJobResult.mockResolvedValueOnce(sampleResult);

    const { Wrapper, qc } = createWrapper();
    const prefetchSpy = vi.spyOn(qc, "prefetchQuery");

    const { result } = renderHook(() => usePrefetchJobDetail(), { wrapper: Wrapper });

    act(() => { result.current("j1", "completed"); });

    // Should trigger 2 prefetch calls (status + result)
    expect(prefetchSpy).toHaveBeenCalledTimes(2);
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["jobs", "j1", "status"] }),
    );
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["jobs", "j1", "result"] }),
    );
  });

  it("does not prefetch result for cancelled jobs", async () => {
    mockGetJobStatus.mockResolvedValueOnce({ job_id: "j2", status: "cancelled", progress: 0, stages: [] });

    const { Wrapper, qc } = createWrapper();
    const prefetchSpy = vi.spyOn(qc, "prefetchQuery");

    const { result } = renderHook(() => usePrefetchJobDetail(), { wrapper: Wrapper });

    act(() => { result.current("j2", "cancelled"); });

    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["jobs", "j2", "status"] }),
    );
  });
});
