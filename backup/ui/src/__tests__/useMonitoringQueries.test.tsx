import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import React from "react";
import {
  useHealth,
  useDbMonitorSummary,
  useDbMonitorRecent,
  useStandardsSummary,
  useTriggerStandardsIngest,
  useIngestStatus,
  useHistoryPanelRuns,
  useCodeGraph,
} from "@/hooks/useMonitoringQueries";

/* ── Mocks ────────────────────────────────────────────── */
const mockGetHealth = vi.fn();
const mockGetDbMonitorSummary = vi.fn();
const mockGetDbMonitorRecent = vi.fn();
const mockGetStandards = vi.fn();
const mockAuthFetch = vi.fn();
const mockFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  getHealth: (...args: any[]) => mockGetHealth(...args),
  getDbMonitorSummary: (...args: any[]) => mockGetDbMonitorSummary(...args),
  getDbMonitorRecent: (...args: any[]) => mockGetDbMonitorRecent(...args),
  getStandards: (...args: any[]) => mockGetStandards(...args),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: any[]) => mockAuthFetch(...args),
}));

// Mock global fetch for HistoryPanel
const originalFetch = globalThis.fetch;

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
  return { wrapper: Wrapper, qc };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ═══════════════════════════════════════════════════════════════════════════
//  Health
// ═══════════════════════════════════════════════════════════════════════════

describe("useHealth", () => {
  it("fetches health data", async () => {
    const health = { status: "ok", version: "1.0", pipeline: "ok", db: "ok", llm: "ok" };
    mockGetHealth.mockResolvedValue(health);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHealth(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(health);
    expect(mockGetHealth).toHaveBeenCalledTimes(1);
  });

  it("handles error", async () => {
    mockGetHealth.mockRejectedValue(new Error("Health check failed"));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHealth(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  DB Monitor
// ═══════════════════════════════════════════════════════════════════════════

describe("useDbMonitorSummary", () => {
  it("fetches summary with 30s refetch interval", async () => {
    const summary = {
      kpis: { total_24h: 100 },
      slow_queries: [],
      table_stats: [],
      type_breakdown: [],
      timeline: [],
      tracking_enabled: true,
      slow_threshold_ms: 500,
    };
    mockGetDbMonitorSummary.mockResolvedValue(summary);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDbMonitorSummary(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(summary);
  });
});

describe("useDbMonitorRecent", () => {
  it("fetches recent queries with filters", async () => {
    const recent = { rows: [{ id: 1, query_type: "SELECT" }], count: 1 };
    mockGetDbMonitorRecent.mockResolvedValue(recent);
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useDbMonitorRecent({ errorsOnly: true, queryType: "SELECT" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(recent);
    expect(mockGetDbMonitorRecent).toHaveBeenCalledWith({
      limit: 100,
      errorsOnly: true,
      queryType: "SELECT",
      tableName: undefined,
    });
  });

  it("does not fetch when disabled", async () => {
    const { wrapper } = createWrapper();
    renderHook(
      () => useDbMonitorRecent({ errorsOnly: false }, false),
      { wrapper },
    );
    // Give it a little time to ensure no fetch fires
    await new Promise((r) => setTimeout(r, 50));
    expect(mockGetDbMonitorRecent).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Standards
// ═══════════════════════════════════════════════════════════════════════════

describe("useStandardsSummary", () => {
  it("fetches summary from both endpoints", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ standards: [{ type: "etom", total_entities: 700 }] }),
    });
    mockGetStandards.mockResolvedValue([{ id: "tmforum-etom", name: "eTOM", entity_count: 700, is_loaded: true }]);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStandardsSummary(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.summary).toHaveLength(1);
    expect(result.current.data?.tmfStandards).toHaveLength(1);
  });

  it("returns empty arrays on error", async () => {
    mockAuthFetch.mockResolvedValue({
      json: () => Promise.resolve({ standards: [] }),
    });
    mockGetStandards.mockRejectedValue(new Error("fail"));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useStandardsSummary(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.tmfStandards).toEqual([]);
  });
});

describe("useTriggerStandardsIngest", () => {
  it("sends ingest request and invalidates cache", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: "Ingested successfully" }),
    });
    const { wrapper, qc } = createWrapper();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useTriggerStandardsIngest(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ standards_type: "tmforum-etom", force_reingest: false });
    });
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
  });

  it("throws on non-ok response", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      json: () => Promise.resolve({ detail: "Bad payload" }),
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTriggerStandardsIngest(), { wrapper });
    await expect(
      act(async () => {
        await result.current.mutateAsync({ standards_type: "tmforum-sid", force_reingest: true });
      }),
    ).rejects.toThrow("Bad payload");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Ingest Status
// ═══════════════════════════════════════════════════════════════════════════

describe("useIngestStatus", () => {
  it("fetches all three status endpoints", async () => {
    const code = { stored: true, total_files: 10 };
    const docs = { stored: true, total_source_files: 5 };
    const figma = { stored: false };
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.includes("code/status")) return Promise.resolve({ json: () => Promise.resolve(code) });
      if (url.includes("docs/status")) return Promise.resolve({ json: () => Promise.resolve(docs) });
      if (url.includes("figma/status")) return Promise.resolve({ json: () => Promise.resolve(figma) });
      return Promise.reject(new Error("unexpected url"));
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useIngestStatus(42), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.code).toEqual(code);
    expect(result.current.data?.docs).toEqual(docs);
    expect(result.current.data?.figma).toEqual(figma);
  });

  it("does not fetch for projectId 0", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useIngestStatus(0), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("handles partial failures gracefully", async () => {
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.includes("code/status")) return Promise.resolve({ json: () => Promise.resolve({ stored: true }) });
      return Promise.reject(new Error("endpoint down"));
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useIngestStatus(1), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.code).toEqual({ stored: true });
    expect(result.current.data?.docs).toBeNull();
    expect(result.current.data?.figma).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  History Panel Runs
// ═══════════════════════════════════════════════════════════════════════════

describe("useHistoryPanelRuns", () => {
  it("fetches codebuilder runs", async () => {
    const runs = [{ id: 1, status: "completed", run_id: "abc" }];
    mockAuthFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(runs) });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHistoryPanelRuns("codebuilder", 5), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(runs);
    expect(mockAuthFetch).toHaveBeenCalledWith("/cb-api/runs?project_id=5");
  });

  it("fetches legacy-modernization runs", async () => {
    const runs = [{ id: 2, status: "running" }];
    mockAuthFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(runs) });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHistoryPanelRuns("legacy-modernization", 3), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockAuthFetch).toHaveBeenCalledWith("/lm-api/legacy-modernization/runs?project_id=3");
  });

  it("returns empty array on non-ok response", async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHistoryPanelRuns("codebuilder"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("unwraps { runs: [...] } response shape", async () => {
    const runs = [{ id: 1 }];
    mockAuthFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ runs }) });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHistoryPanelRuns("codebuilder"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(runs);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Code Graph
// ═══════════════════════════════════════════════════════════════════════════

describe("useCodeGraph", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("is disabled by default", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCodeGraph(1), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("is disabled when projectId is null", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCodeGraph(null, { enabled: true }), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fetches graph when enabled", async () => {
    const graph = { nodes: [{ id: "n1", type: "file", name: "main.py" }], edges: [], total_nodes: 1, total_edges: 0 };
    mockAuthFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(graph) });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCodeGraph(5, { enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(graph);
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining("project_id=5"));
  });

  it("throws on non-ok response", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: false,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ detail: "Graph not available" }),
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCodeGraph(5, { enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("Graph not available");
  });
});
