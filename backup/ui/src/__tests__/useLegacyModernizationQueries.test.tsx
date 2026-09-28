import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import {
  useLegacyModProjects,
  useLegacyModCodeContext,
} from "@/hooks/useLegacyModernizationQueries";

/* ── Mocks ────────────────────────────────────────────── */
const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => mockAuthFetch(...args) }));

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

/* ═══════════════════════════════════════════════════════════════════════
   useLegacyModProjects
   ═══════════════════════════════════════════════════════════════════════ */

describe("useLegacyModProjects", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches legacy modernization projects", async () => {
    const projects = [
      { project_id: 1, project_name: "Legacy App" },
      { project_id: 2, project_name: "Old System" },
    ];
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ projects }),
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useLegacyModProjects(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(projects);
  });

  it("returns empty array when API returns non-array", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ projects: null }),
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useLegacyModProjects(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   useLegacyModCodeContext
   ═══════════════════════════════════════════════════════════════════════ */

describe("useLegacyModCodeContext", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches code context for a project", async () => {
    const context = { stored: true, total_files: 42, total_chunks: 120, files: ["main.py", "utils.py"] };
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => context,
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useLegacyModCodeContext(5), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(context);
  });

  it("is disabled when projectId is null", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useLegacyModCodeContext(null), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("is disabled when projectId is 0", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useLegacyModCodeContext(0), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});
