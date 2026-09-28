import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach } from "vitest";

/* ── Mock document-api module ──────────────────────────────────────────── */

const mockListDocumentJobs = vi.fn();
const mockListDocumentJobsFromDB = vi.fn();
const mockGetDocumentJobResult = vi.fn();
const mockGetDocumentJobStatus = vi.fn();
const mockSubmitDocumentGeneration = vi.fn();
const mockDeleteDocumentJobFromDB = vi.fn();
const mockMarkDocumentJobFlags = vi.fn();
const mockPublishDocumentJob = vi.fn();
const mockGetDocumentPublishStatus = vi.fn();
const mockUploadSourceDocument = vi.fn();
const mockFetchApprovedStories = vi.fn();
const mockFetchApprovedStorySessions = vi.fn();

vi.mock("@/lib/document-api", () => ({
  listDocumentJobs: (...args: unknown[]) => mockListDocumentJobs(...args),
  listDocumentJobsFromDB: (...args: unknown[]) => mockListDocumentJobsFromDB(...args),
  getDocumentJobResult: (...args: unknown[]) => mockGetDocumentJobResult(...args),
  getDocumentJobStatus: (...args: unknown[]) => mockGetDocumentJobStatus(...args),
  submitDocumentGeneration: (...args: unknown[]) => mockSubmitDocumentGeneration(...args),
  deleteDocumentJobFromDB: (...args: unknown[]) => mockDeleteDocumentJobFromDB(...args),
  markDocumentJobFlags: (...args: unknown[]) => mockMarkDocumentJobFlags(...args),
  publishDocumentJob: (...args: unknown[]) => mockPublishDocumentJob(...args),
  getDocumentPublishStatus: (...args: unknown[]) => mockGetDocumentPublishStatus(...args),
  uploadSourceDocument: (...args: unknown[]) => mockUploadSourceDocument(...args),
  fetchApprovedStories: (...args: unknown[]) => mockFetchApprovedStories(...args),
  fetchApprovedStorySessions: (...args: unknown[]) => mockFetchApprovedStorySessions(...args),
}));

import {
  getDocumentJobDisplayStatus,
  getDocumentJobSummaryBucket,
  useDocumentJobs,
  useDocumentJobResult,
  useDocumentJobStatusOnce,
  useDocumentPublishStatus,
  useApprovedStories,
  useApprovedStorySessions,
  useSubmitDocument,
  useDeleteDocumentJob,
  useMarkDocumentJobFlags,
  usePublishDocument,
  useUploadSourceDocument,
  usePrefetchDocumentJob,
} from "@/hooks/useDocumentBuilderQueries";

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

/* ── Sample data ──────────────────────────────────────────────────────── */

const sampleMemoryJobs = [
  {
    job_id: "mem-1",
    status: "completed" as const,
    submitted_at: "2026-03-26T10:00:00Z",
    completed_at: "2026-03-26T10:05:00Z",
    duration_seconds: 300,
    document_type: "hld",
    quality: "standard",
    project_id: 1,
    request_options: { architecture_mode: "auto" },
  },
  {
    job_id: "mem-2",
    status: "running" as const,
    submitted_at: "2026-03-26T11:00:00Z",
    completed_at: null,
    duration_seconds: null,
    document_type: "lld",
    quality: "high",
    project_id: 1,
    request_options: null,
  },
];

const sampleDbJobs = [
  {
    job_id: "db-1",
    status: "completed",
    submitted_at: "2026-03-25T09:00:00Z",
    completed_at: "2026-03-25T09:10:00Z",
    duration_seconds: 600,
    requirement_file: null,
    total_stories: 0,
    quality: "fast",
    request_options: { document_type: "req" },
    project_id: 2,
    session_id: null,
    session_name: null,
    version_count: null,
    is_selected: false,
    review_flag: false,
  },
];

const sampleResult = {
  job_id: "mem-1",
  status: "completed",
  submitted_at: "2026-03-26T10:00:00Z",
  completed_at: "2026-03-26T10:05:00Z",
  duration_seconds: 300,
  request_options: { project_id: 1 },
  document_type: "hld",
  document_title: "Test HLD",
  total_sections: 2,
  sections: [
    { section_id: "s1", title: "Overview", content: "# Overview", order: 1, traceability_links: [], confidence_score: 0.9 },
    { section_id: "s2", title: "Architecture", content: "# Architecture", order: 2, traceability_links: [], confidence_score: 0.85 },
  ],
  full_markdown: "# Test HLD\n## Overview\n## Architecture",
  validation: null,
  execution_summary: null,
  output_files: { markdown: "", raw_pipeline_output: "" },
};

const sampleStatus = {
  job_id: "mem-1",
  status: "completed",
  submitted_at: "2026-03-26T10:00:00Z",
  started_at: "2026-03-26T10:00:01Z",
  completed_at: "2026-03-26T10:05:00Z",
  duration_seconds: 300,
  progress: null,
  error: null,
  request_options: null,
};

const samplePublishStatus = {
  published: false,
  external_id: null,
  external_url: null,
  published_at: null,
};

const sampleStories = [
  { id: 1, artifact_id: "a1", title: "Story 1", description: "Desc 1", acceptance_criteria: [], approved_at: "2026-03-25", session_id: null },
  { id: 2, artifact_id: "a2", title: "Story 2", description: "Desc 2", acceptance_criteria: [], approved_at: "2026-03-25", session_id: null },
];

const sampleStorySessions = [
  {
    session_id: 10,
    session_name: "Checkout stories",
    approved_story_count: 2,
    starred_jobs: [{ job_id: "story-job-1", generation_run_id: 101, is_starred: true }],
    stories: sampleStories.map((story) => ({ ...story, session_id: 10, session_name: "Checkout stories", job_id: "story-job-1" })),
  },
];

/* ═══════════════════════════════════════════════════════════════════════
   QUERY HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useDocumentJobs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches DB-persisted document jobs only", async () => {
    mockListDocumentJobs.mockResolvedValueOnce(sampleMemoryJobs);
    mockListDocumentJobsFromDB.mockResolvedValueOnce(sampleDbJobs);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockListDocumentJobs).not.toHaveBeenCalled();
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].job_id).toBe("db-1");
    expect(result.current.data![0]._source).toBe("db");
  });

  it("uses durable DB metadata for document type and architecture", async () => {
    const dbJob = { ...sampleDbJobs[0], request_options: { document_type: "req", architecture_mode: "auto" }, is_selected: true, review_flag: true };
    mockListDocumentJobs.mockResolvedValueOnce(sampleMemoryJobs);
    mockListDocumentJobsFromDB.mockResolvedValueOnce([dbJob]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]._source).toBe("db");
    expect(result.current.data![0].document_type).toBe("req");
    expect(result.current.data![0].architecture_mode).toBe("auto");
    expect(result.current.data![0].is_selected).toBe(true);
    expect(result.current.data![0].review_flag).toBe(true);
  });

  it("keeps active DB rows visible", async () => {
    const activeDbJob = {
      ...sampleDbJobs[0],
      job_id: "mem-2",
      status: "running",
      request_options: { document_type: "lld", architecture_mode: "auto", quality: "high" },
      project_id: 1,
    };
    mockListDocumentJobs.mockResolvedValueOnce(sampleMemoryJobs);
    mockListDocumentJobsFromDB.mockResolvedValueOnce([activeDbJob]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const activeJob = result.current.data!.find((j: { job_id: string }) => j.job_id === "mem-2");
    expect(activeJob?.status).toBe("running");
    expect(activeJob?._source).toBe("db");
    expect(activeJob?.architecture_mode).toBe("auto");
  });

  it("filters by projectId", async () => {
    mockListDocumentJobs.mockResolvedValueOnce(sampleMemoryJobs);
    mockListDocumentJobsFromDB.mockResolvedValueOnce([]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobs(99), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // No jobs for project 99
    expect(result.current.data).toHaveLength(0);
    expect(mockListDocumentJobsFromDB).toHaveBeenCalledWith(99);
  });

  it("surfaces DB API failures instead of showing fallback memory data", async () => {
    mockListDocumentJobs.mockRejectedValueOnce(new Error("Network error"));
    mockListDocumentJobsFromDB.mockRejectedValueOnce(new Error("DB error"));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("DB error");
    expect(mockListDocumentJobs).not.toHaveBeenCalled();
  });

  it("does not display memory-only jobs without DB backing", async () => {
    mockListDocumentJobs.mockResolvedValueOnce(sampleMemoryJobs);
    mockListDocumentJobsFromDB.mockResolvedValueOnce([]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDocumentJobs(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(0);
    expect(mockListDocumentJobs).not.toHaveBeenCalled();
  });
});

describe("useDocumentJobResult", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches result when enabled", async () => {
    mockGetDocumentJobResult.mockResolvedValueOnce(sampleResult);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentJobResult("mem-1"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.document_title).toBe("Test HLD");
    expect(result.current.data?.total_sections).toBe(2);
    expect(mockGetDocumentJobResult).toHaveBeenCalledWith("mem-1");
  });

  it("does not fetch when jobId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentJobResult(null),
      { wrapper: Wrapper },
    );

    // Should not be loading and no API call
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetDocumentJobResult).not.toHaveBeenCalled();
  });

  it("does not fetch when enabled is false", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentJobResult("mem-1", { enabled: false }),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetDocumentJobResult).not.toHaveBeenCalled();
  });
});

describe("useDocumentJobStatusOnce", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches job status", async () => {
    mockGetDocumentJobStatus.mockResolvedValueOnce(sampleStatus);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentJobStatusOnce("mem-1"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.status).toBe("completed");
    expect(mockGetDocumentJobStatus).toHaveBeenCalledWith("mem-1");
  });

  it("does not fetch when jobId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentJobStatusOnce(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetDocumentJobStatus).not.toHaveBeenCalled();
  });
});

describe("useDocumentPublishStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches publish status", async () => {
    mockGetDocumentPublishStatus.mockResolvedValueOnce(samplePublishStatus);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentPublishStatus("mem-1"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.published).toBe(false);
    expect(mockGetDocumentPublishStatus).toHaveBeenCalledWith("mem-1");
  });

  it("does not fetch when jobId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useDocumentPublishStatus(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetDocumentPublishStatus).not.toHaveBeenCalled();
  });
});

describe("useApprovedStories", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches approved stories for a project", async () => {
    mockFetchApprovedStories.mockResolvedValueOnce(sampleStories);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useApprovedStories(1),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].title).toBe("Story 1");
    expect(mockFetchApprovedStories).toHaveBeenCalledWith(1);
  });

  it("does not fetch when projectId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useApprovedStories(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockFetchApprovedStories).not.toHaveBeenCalled();
  });

  it("does not fetch when projectId is 0", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useApprovedStories(0),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockFetchApprovedStories).not.toHaveBeenCalled();
  });
});

describe("useApprovedStorySessions", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches approved story sessions for a project", async () => {
    mockFetchApprovedStorySessions.mockResolvedValueOnce(sampleStorySessions);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useApprovedStorySessions(1),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].session_name).toBe("Checkout stories");
    expect(result.current.data![0].stories).toHaveLength(2);
    expect(mockFetchApprovedStorySessions).toHaveBeenCalledWith(1);
  });

  it("does not fetch sessions when projectId is null", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useApprovedStorySessions(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockFetchApprovedStorySessions).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   MUTATION HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useSubmitDocument", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls submitDocumentGeneration and invalidates jobs cache", async () => {
    const submitResponse = { job_id: "new-1", status: "pending", message: "OK", submitted_at: "", poll_url: "", result_url: "" };
    mockSubmitDocumentGeneration.mockResolvedValueOnce(submitResponse);
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useSubmitDocument(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ document_type: "hld", project_id: 1 });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockSubmitDocumentGeneration).toHaveBeenCalledWith({ document_type: "hld", project_id: 1 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs"] });
  });
});

describe("useDeleteDocumentJob", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls deleteDocumentJobFromDB for memory source and invalidates cache", async () => {
    mockDeleteDocumentJobFromDB.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDeleteDocumentJob(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ jobId: "mem-1", source: "memory" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDeleteDocumentJobFromDB).toHaveBeenCalledWith("mem-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs"] });
  });

  it("calls deleteDocumentJobFromDB for db source", async () => {
    mockDeleteDocumentJobFromDB.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteDocumentJob(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ jobId: "db-1", source: "db" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDeleteDocumentJobFromDB).toHaveBeenCalledWith("db-1");
  });

  it("clears document detail caches after delete", async () => {
    mockDeleteDocumentJobFromDB.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();
    const removeSpy = vi.spyOn(qc, "removeQueries");

    const { result } = renderHook(() => useDeleteDocumentJob(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ jobId: "mem-1", source: "memory" });
    });

    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs", "mem-1", "status"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs", "mem-1", "result"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs", "mem-1", "publish-status"] });
  });

  it("does not apply list filtering to non-list document job caches", async () => {
    mockDeleteDocumentJobFromDB.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();

    qc.setQueryData(["document-jobs", "doc-1", "status"], { job_id: "doc-1", status: "completed" });

    const { result } = renderHook(() => useDeleteDocumentJob(), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ jobId: "doc-1", source: "db" })).resolves.toBeUndefined();
    expect(mockDeleteDocumentJobFromDB).toHaveBeenCalledWith("doc-1");
  });

  it("does not resurrect a deleted job after refetch when the initial DB list failed", async () => {
    let dbJobs = [
      {
        job_id: "ghost-1",
        status: "completed",
        submitted_at: "2026-03-26T12:00:00Z",
        completed_at: "2026-03-26T12:05:00Z",
        duration_seconds: 300,
        requirement_file: null,
        total_stories: 0,
        quality: "standard",
        request_options: { document_type: "hld", architecture_mode: "auto" },
        project_id: 1,
        session_id: null,
        session_name: null,
        version_count: null,
        is_selected: false,
        review_flag: false,
      },
    ];
    let dbListCalls = 0;

    mockListDocumentJobsFromDB.mockImplementation(async () => {
      dbListCalls += 1;
      if (dbListCalls === 1) {
        throw new Error("temporary db outage");
      }
      return dbJobs;
    });
    mockDeleteDocumentJobFromDB.mockImplementation(async (jobId: string) => {
      dbJobs = dbJobs.filter((job) => job.job_id !== jobId);
    });

    const { Wrapper, qc } = createWrapper();
    const jobsHook = renderHook(() => useDocumentJobs(1), { wrapper: Wrapper });

    await waitFor(() => expect(jobsHook.result.current.isLoading).toBe(false));
    expect(jobsHook.result.current.error).toBeInstanceOf(Error);

    const deleteHook = renderHook(() => useDeleteDocumentJob(), { wrapper: Wrapper });
    await act(async () => {
      await deleteHook.result.current.mutateAsync({ jobId: "ghost-1", source: "memory" });
    });

    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["document-jobs"] });
      await qc.refetchQueries({ queryKey: ["document-jobs"] });
    });

    await waitFor(() => expect(jobsHook.result.current.data).toEqual([]));
    expect(mockDeleteDocumentJobFromDB).toHaveBeenCalledWith("ghost-1");
    expect(mockListDocumentJobs).not.toHaveBeenCalled();
  });
});

describe("useMarkDocumentJobFlags", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const cachedDocumentJobs = [
    {
      job_id: "doc-1",
      status: "completed" as const,
      submitted_at: "2026-03-26T12:00:00Z",
      completed_at: "2026-03-26T12:05:00Z",
      duration_seconds: 300,
      document_type: "hld",
      architecture_mode: "auto",
      quality: "standard",
      project_id: 7,
      session_id: 22,
      session_name: "Design pass",
      request_options: { document_type: "hld" },
      _source: "db" as const,
      version_count: null,
      is_selected: true,
      review_flag: false,
    },
    {
      job_id: "doc-2",
      status: "completed" as const,
      submitted_at: "2026-03-26T13:00:00Z",
      completed_at: "2026-03-26T13:05:00Z",
      duration_seconds: 300,
      document_type: "lld",
      architecture_mode: "auto",
      quality: "standard",
      project_id: 7,
      session_id: 22,
      session_name: "Design pass",
      request_options: { document_type: "lld" },
      _source: "db" as const,
      version_count: null,
      is_selected: false,
      review_flag: false,
    },
  ];

  it("optimistically stars a document job without unstarring another job in the same session", async () => {
    mockMarkDocumentJobFlags.mockResolvedValueOnce({ ...sampleDbJobs[0], job_id: "doc-2", is_selected: true });
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["document-jobs", { projectId: 7 }], cachedDocumentJobs);

    const { result } = renderHook(() => useMarkDocumentJobFlags(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ jobId: "doc-2", flags: { is_selected: true } });
    });

    const cached = qc.getQueryData<typeof cachedDocumentJobs>(["document-jobs", { projectId: 7 }]);
    expect(mockMarkDocumentJobFlags).toHaveBeenCalledWith("doc-2", { is_selected: true });
    expect(cached?.find((job) => job.job_id === "doc-1")?.is_selected).toBe(true);
    expect(cached?.find((job) => job.job_id === "doc-2")?.is_selected).toBe(true);
  });

  it("rolls back optimistic flag updates when the API fails", async () => {
    mockMarkDocumentJobFlags.mockRejectedValueOnce(new Error("flag update failed"));
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["document-jobs", { projectId: 7 }], cachedDocumentJobs);

    const { result } = renderHook(() => useMarkDocumentJobFlags(), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ jobId: "doc-2", flags: { is_selected: true } })).rejects.toThrow("flag update failed");

    const cached = qc.getQueryData<typeof cachedDocumentJobs>(["document-jobs", { projectId: 7 }]);
    expect(cached).toEqual(cachedDocumentJobs);
  });
});

describe("document job helpers", () => {
  it("maps regenerated jobs to regenerated display status", () => {
    expect(getDocumentJobDisplayStatus({ status: "completed", version_count: 2 })).toBe("regenerated");
  });

  it("counts cancelled jobs in the failed summary bucket", () => {
    expect(getDocumentJobSummaryBucket({ status: "cancelled", version_count: null })).toBe("failed");
    expect(getDocumentJobSummaryBucket({ status: "completed", version_count: 3 })).toBe("completed");
  });
});

describe("usePublishDocument", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls publishDocumentJob and invalidates publish status + result + jobs", async () => {
    const publishResult = { target: "ado", external_id: "wiki-1", external_url: "https://dev.azure.com/wiki/1", message: "Published" };
    mockPublishDocumentJob.mockResolvedValueOnce(publishResult);
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => usePublishDocument("mem-1"), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPublishDocumentJob).toHaveBeenCalledWith("mem-1");
    expect(result.current.data).toEqual(publishResult);

    // Should invalidate 3 query keys
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs", "mem-1", "publish-status"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs", "mem-1", "result"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["document-jobs"] });
  });
});

describe("useUploadSourceDocument", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls uploadSourceDocument with the file and project id", async () => {
    const uploadResponse = {
      filename: "test.pdf",
      file_type: "pdf",
      content_length: 1000,
      content: "extracted text",
      image_context_status: "processed",
      visual_context: "[Image-1] Source: https://blob/image.png",
      image_summaries: [
        {
          image_path: "https://blob/image.png",
          is_relevant: true,
          image_type: "Architecture Diagram",
          overview: "Shows service interaction",
        },
      ],
    };
    mockUploadSourceDocument.mockResolvedValueOnce(uploadResponse);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useUploadSourceDocument(), { wrapper: Wrapper });

    const file = new File(["content"], "test.pdf", { type: "application/pdf" });
    await act(async () => {
      result.current.mutate({ file, projectId: 42 });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockUploadSourceDocument).toHaveBeenCalledWith({ file, projectId: 42 });
    expect(result.current.data).toEqual(uploadResponse);
  });

  it("exposes error when upload fails", async () => {
    mockUploadSourceDocument.mockRejectedValueOnce(new Error("Upload failed"));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useUploadSourceDocument(), { wrapper: Wrapper });

    const file = new File(["content"], "bad.pdf", { type: "application/pdf" });
    await act(async () => {
      result.current.mutate({ file, projectId: 42 });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("Upload failed");
  });
});

/* ── usePrefetchDocumentJob ───────────────────────────────────────── */

describe("usePrefetchDocumentJob", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("prefetches document job status and result into cache", async () => {
    mockGetDocumentJobStatus.mockResolvedValueOnce({ status: "completed" });
    mockGetDocumentJobResult.mockResolvedValueOnce({ sections: [] });

    const { Wrapper, qc } = createWrapper();
    const prefetchSpy = vi.spyOn(qc, "prefetchQuery");

    const { result } = renderHook(() => usePrefetchDocumentJob(), { wrapper: Wrapper });

    act(() => { result.current({ job_id: "doc-j1", status: "completed" }); });

    expect(prefetchSpy).toHaveBeenCalledTimes(2);
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["document-jobs", "doc-j1", "status"] }),
    );
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["document-jobs", "doc-j1", "result"] }),
    );
  });

  it("skips result prefetch for cancelled jobs", async () => {
    mockGetDocumentJobStatus.mockResolvedValueOnce({ status: "cancelled" });

    const { Wrapper, qc } = createWrapper();
    const prefetchSpy = vi.spyOn(qc, "prefetchQuery");

    const { result } = renderHook(() => usePrefetchDocumentJob(), { wrapper: Wrapper });

    act(() => { result.current({ job_id: "doc-j2", status: "cancelled" }); });

    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["document-jobs", "doc-j2", "status"] }),
    );
    expect(mockGetDocumentJobResult).not.toHaveBeenCalled();
  });
});
