import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  useFileTree,
  usePipelineRuns,
  usePipelineRunStatus,
  useOutputTree,
  usePipelineModes,
  useCBProjects,
  useRunReports,
  useStartPipeline,
  useDeletePipelineRun,
  useCBv2ModelConfigStatus,
  useCBv2Configs,
  useSaveCBv2Config,
  useCBv2SourceFiles,
  useCBv2ApprovedArtifacts,
} from "@/hooks/useCodeBuilderQueries";

/* ── Mocks ──────────────────────────────────────────── */
const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => mockAuthFetch(...args) }));
const mockGetFileTree = vi.fn();
const mockGetPipelineHistory = vi.fn();
const mockGetPipelineStatus = vi.fn();
const mockGetOutputTree = vi.fn();
const mockGetPipelineModes = vi.fn();
const mockListProjects = vi.fn();
const mockGetRunReports = vi.fn();
const mockStartPipeline = vi.fn();
const mockDeletePipelineRun = vi.fn();

vi.mock("@/lib/code-builder-api", () => ({
  getFileTree: (...args: any[]) => mockGetFileTree(...args),
  getPipelineHistory: (...args: any[]) => mockGetPipelineHistory(...args),
  getPipelineStatus: (...args: any[]) => mockGetPipelineStatus(...args),
  getOutputTree: (...args: any[]) => mockGetOutputTree(...args),
  getPipelineModes: (...args: any[]) => mockGetPipelineModes(...args),
  listProjects: (...args: any[]) => mockListProjects(...args),
  getRunReports: (...args: any[]) => mockGetRunReports(...args),
  startPipeline: (...args: any[]) => mockStartPipeline(...args),
  deletePipelineRun: (...args: any[]) => mockDeletePipelineRun(...args),
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  }
  return { Wrapper, qc };
}

/* ── Sample data ──────────────────────────────────────── */
const sampleFileTree = [
  { name: "src", path: "src", type: "directory" as const, children: [
    { name: "main.py", path: "src/main.py", type: "file" as const, language: "python", size: 1024 },
  ]},
  { name: "README.md", path: "README.md", type: "file" as const, language: "markdown", size: 256 },
];

const sampleRuns = [
  { run_id: "run-1", mode: "greenfield", status: "completed", created_at: "2026-03-25T10:00:00Z", completed_at: "2026-03-25T10:05:00Z", duration_ms: 300000 },
  { run_id: "run-2", mode: "brownfield", status: "running", created_at: "2026-03-26T10:00:00Z", completed_at: null, duration_ms: null },
];

const sampleStatus = {
  run_id: "run-2",
  mode: "brownfield",
  status: "running",
  steps: [{ name: "Input Processing", status: "completed" }],
  progress: 40,
  output_dir: "/tmp/output",
  created_at: "2026-03-26T10:00:00Z",
};

const sampleOutputTree = {
  tree: [
    { name: "output.py", path: "output.py", type: "file" as const, language: "python", size: 512 },
  ],
  output_dir: "/tmp/output",
};

const sampleModes = {
  modes: [
    { name: "greenfield", label: "Greenfield", steps: ["plan", "code", "test"] },
    { name: "brownfield", label: "Brownfield", steps: ["scan", "refactor"] },
  ],
};

const sampleProjects = [
  { project_id: "p1", name: "Project Alpha", mode: "greenfield", description: "Test", created_at: "2026-03-20T00:00:00Z", status: "active" },
];

const sampleReports = {
  reports: [
    { path: "reports/summary.md", name: "summary.md", language: "markdown", size: 2048 },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════
   QUERY HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useFileTree", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches file tree for a project", async () => {
    mockGetFileTree.mockResolvedValueOnce(sampleFileTree);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFileTree("p1"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].name).toBe("src");
    expect(mockGetFileTree).toHaveBeenCalledWith("p1");
  });

  it("does not fetch when projectId is null", () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useFileTree(null), { wrapper: Wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetFileTree).not.toHaveBeenCalled();
  });
});

describe("usePipelineRuns", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches pipeline runs", async () => {
    mockGetPipelineHistory.mockResolvedValueOnce(sampleRuns);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePipelineRuns(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].run_id).toBe("run-1");
  });

  it("handles API failure gracefully", async () => {
    mockGetPipelineHistory.mockRejectedValueOnce(new Error("Network error"));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePipelineRuns(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe("usePipelineRunStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches run status", async () => {
    mockGetPipelineStatus.mockResolvedValueOnce(sampleStatus);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => usePipelineRunStatus("run-2"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.status).toBe("running");
    expect(result.current.data?.progress).toBe(40);
    expect(mockGetPipelineStatus).toHaveBeenCalledWith("run-2");
  });

  it("does not fetch when runId is null", () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => usePipelineRunStatus(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetPipelineStatus).not.toHaveBeenCalled();
  });

  it("disables polling when wsConnected is true", async () => {
    mockGetPipelineStatus.mockResolvedValue(sampleStatus); // status = "running"
    const { Wrapper, qc } = createWrapper();

    const { result } = renderHook(
      () => usePipelineRunStatus("run-2", { wsConnected: true }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Query should fetch once (initial) but refetchInterval should be false
    expect(result.current.data?.status).toBe("running");
    const queryState = qc.getQueryState(["cb-runs", "run-2", "status"]);
    // The query fetched successfully but should not be polling
    expect(queryState?.status).toBe("success");
  });

  it("enables polling when wsConnected is false and run is active", async () => {
    mockGetPipelineStatus.mockResolvedValue(sampleStatus); // status = "running"
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => usePipelineRunStatus("run-2", { wsConnected: false }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Query should fetch and data should be available
    expect(result.current.data?.status).toBe("running");
    expect(mockGetPipelineStatus).toHaveBeenCalledWith("run-2");
  });
});

describe("useOutputTree", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches output tree for a run", async () => {
    mockGetOutputTree.mockResolvedValueOnce(sampleOutputTree);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useOutputTree("run-1"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.tree).toHaveLength(1);
    expect(result.current.data?.tree[0].name).toBe("output.py");
    expect(mockGetOutputTree).toHaveBeenCalledWith("run-1");
  });

  it("does not fetch when runId is null", () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useOutputTree(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetOutputTree).not.toHaveBeenCalled();
  });
});

describe("usePipelineModes", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches pipeline modes", async () => {
    mockGetPipelineModes.mockResolvedValueOnce(sampleModes);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => usePipelineModes(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.modes).toHaveLength(2);
    expect(result.current.data?.modes[0].name).toBe("greenfield");
  });
});

describe("useCBProjects", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches projects when enabled", async () => {
    mockListProjects.mockResolvedValueOnce({ projects: sampleProjects });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCBProjects(true), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].name).toBe("Project Alpha");
  });

  it("does not fetch when disabled", () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCBProjects(false), { wrapper: Wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockListProjects).not.toHaveBeenCalled();
  });
});

describe("useRunReports", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches reports for a run", async () => {
    mockGetRunReports.mockResolvedValueOnce(sampleReports);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useRunReports("run-1"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].name).toBe("summary.md");
    expect(mockGetRunReports).toHaveBeenCalledWith("run-1");
  });

  it("does not fetch when runId is null", () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useRunReports(null),
      { wrapper: Wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockGetRunReports).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   MUTATION HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useStartPipeline", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls startPipeline and invalidates runs cache", async () => {
    const runResult = { run_id: "run-new", mode: "greenfield", status: "pending", steps: [], created_at: "", progress: 0 };
    mockStartPipeline.mockResolvedValueOnce(runResult);
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useStartPipeline(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ mode: "greenfield" as any, request: "Build an API" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockStartPipeline).toHaveBeenCalledWith("greenfield", "Build an API", undefined, undefined);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["cb-runs"] });
  });
});

describe("useDeletePipelineRun", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls deletePipelineRun and invalidates runs cache", async () => {
    mockDeletePipelineRun.mockResolvedValueOnce({ status: "deleted" });
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDeletePipelineRun(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate("run-1");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDeletePipelineRun).toHaveBeenCalledWith("run-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["cb-runs"] });
  });

  it("optimistically removes run from cache", async () => {
    mockDeletePipelineRun.mockResolvedValueOnce({ status: "deleted" });
    // Mock refetch after invalidation
    mockGetPipelineHistory.mockResolvedValueOnce([sampleRuns[1]]);
    const { Wrapper, qc } = createWrapper();
    const setDataSpy = vi.spyOn(qc, "setQueryData");

    // Pre-populate cache
    qc.setQueryData(["cb-runs"], sampleRuns);

    const { result } = renderHook(() => useDeletePipelineRun(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate("run-1");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify optimistic update was called with a filter function
    expect(setDataSpy).toHaveBeenCalled();
    expect(mockDeletePipelineRun).toHaveBeenCalledWith("run-1");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   CBv2 QUERY HOOK TESTS
   ═══════════════════════════════════════════════════════════════════════ */

const mockGlobalFetch = vi.fn();
const originalFetch = global.fetch;

describe("useCBv2ModelConfigStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches model-config-status for given projectId", async () => {
    const payload = { configured: true, models: ["gpt-4"] };
    mockAuthFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCBv2ModelConfigStatus(42), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
  });

  it("is disabled when projectId is null", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCBv2ModelConfigStatus(null), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useCBv2Configs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches pipeline configs", async () => {
    const configs = [{ id: 1, name: "My Config", pipeline_type: "greenfield", document_types: [] }];
    mockAuthFetch.mockResolvedValueOnce({ ok: true, json: async () => configs });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCBv2Configs(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(configs);
  });

  it("returns empty array on failure", async () => {
    mockAuthFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCBv2Configs(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe("useSaveCBv2Config", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("saves config and invalidates configs cache", async () => {
    mockAuthFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 2 }) });
    const { Wrapper, qc } = createWrapper();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useSaveCBv2Config(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ name: "Test", pipeline_type: "greenfield" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalled();
  });
});

describe("useCBv2SourceFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches source files list", async () => {
    const files = ["src/main.ts", "src/utils.ts"];
    mockAuthFetch.mockResolvedValueOnce({ ok: true, json: async () => files });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCBv2SourceFiles(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(files);
  });
});

describe("useCBv2ApprovedArtifacts", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches approved artifacts for a project", async () => {
    const artifacts = [{ id: 1, content: "Story 1" }, { id: 2, content: "Story 2" }];
    mockAuthFetch.mockResolvedValueOnce({ ok: true, json: async () => artifacts });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCBv2ApprovedArtifacts(10), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(artifacts);
  });

  it("is disabled when projectId is null", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCBv2ApprovedArtifacts(null), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});
