import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach } from "vitest";

/* ── Mock the API module ──────────────────────────────────────────────── */
const mockListSessions = vi.fn();
const mockCreateSession = vi.fn();
const mockDeleteSession = vi.fn();
vi.mock("@/lib/api", () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
}));

import { useSessions } from "@/hooks/useSessions";

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

const sampleSessions = [
  { id: 10, session_name: "Sprint 1", project_id: 1, status: "active", created_at: "2025-01-01" },
  { id: 11, session_name: "Sprint 2", project_id: 1, status: "active", created_at: "2025-01-02" },
];

/* ── Tests ────────────────────────────────────────────────────────────── */
describe("useSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Query behaviour ────────────────────────────────────────────────

  it("fetches sessions for a project", async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: sampleSessions, total: 2 });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSessions(1), { wrapper: Wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.total).toBe(2);
    expect(mockListSessions).toHaveBeenCalledWith(1, { status: undefined, page_size: 100 });
  });

  it("skips fetch when projectId is 0 (enabled: false)", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSessions(0), { wrapper: Wrapper });

    // Should not be loading because query is disabled
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it("passes statusFilter through to the API call", async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: [], total: 0 });
    const { Wrapper } = createWrapper();

    renderHook(() => useSessions(1, "completed"), { wrapper: Wrapper });
    await waitFor(() => expect(mockListSessions).toHaveBeenCalledTimes(1));

    expect(mockListSessions).toHaveBeenCalledWith(1, { status: "completed", page_size: 100 });
  });

  // ── Deduplication ──────────────────────────────────────────────────

  it("deduplicates concurrent calls with the same project + filter", async () => {
    mockListSessions.mockResolvedValue({ sessions: sampleSessions, total: 2 });
    const { Wrapper } = createWrapper();

    renderHook(() => useSessions(1), { wrapper: Wrapper });
    renderHook(() => useSessions(1), { wrapper: Wrapper });

    await waitFor(() => expect(mockListSessions).toHaveBeenCalledTimes(1));
  });

  // ── Create mutation ────────────────────────────────────────────────

  it("add() creates a session and invalidates the list cache", async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: sampleSessions, total: 2 });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSessions(1), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const newSession = { id: 12, session_name: "Sprint 3", project_id: 1, status: "active" };
    mockCreateSession.mockResolvedValueOnce(newSession);
    mockListSessions.mockResolvedValueOnce({
      sessions: [...sampleSessions, newSession],
      total: 3,
    });

    await act(async () => {
      await result.current.add({ session_name: "Sprint 3" });
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(3));

    expect(mockCreateSession).toHaveBeenCalledWith({
      session_name: "Sprint 3",
      project_id: 1,
    });
  });

  // ── Delete mutation ────────────────────────────────────────────────

  it("remove() deletes a session and invalidates the list cache", async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: sampleSessions, total: 2 });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSessions(1), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockDeleteSession.mockResolvedValueOnce(undefined);
    mockListSessions.mockResolvedValueOnce({
      sessions: [sampleSessions[1]],
      total: 1,
    });

    await act(async () => {
      await result.current.remove(10);
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    expect(mockDeleteSession).toHaveBeenCalledWith(10);
  });

  // ── Refresh ────────────────────────────────────────────────────────

  it("refresh() re-fetches sessions from the server", async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: sampleSessions, total: 2 });
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSessions(1), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockListSessions.mockResolvedValueOnce({ sessions: [sampleSessions[0]], total: 1 });

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });

  // ── Error state ────────────────────────────────────────────────────

  it("exposes error when API rejects", async () => {
    mockListSessions.mockRejectedValueOnce(new Error("Network error"));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSessions(1), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.sessions).toEqual([]);
  });
});
