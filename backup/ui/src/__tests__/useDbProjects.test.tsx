import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach } from "vitest";

/* ── Mock authFetch globally ─────────────────────────────────────────── */
const mockAuthFetch = vi.fn();
// DEVSPHERE_API must be re-exported by the mock: the factory REPLACES the module,
// so an export the hooks read but the mock omits is a runtime error inside the
// queryFn — the query rejects without ever calling authFetch, and its queued
// mockReturnValueOnce then leaks into the next describe block.
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
  DEVSPHERE_API: "http://localhost:8003",
}));

import { useDbProjects, useProjectDetail, useActiveModels, useProfile, useTeams } from "@/hooks/useDbProjects";

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

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    statusText: "OK",
  });
}

const sampleProjects = [
  { id: 1, name: "Alpha", description: null, archived: false, created_at: null, has_code_context: false, has_doc_context: false, has_figma_context: false },
  { id: 2, name: "Beta", description: "Second", archived: false, created_at: null, has_code_context: true, has_doc_context: false, has_figma_context: false },
];

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("useDbProjects", () => {
  // mockReset (not clearAllMocks) drains the mockReturnValueOnce queue too — a
  // leftover queued response would otherwise be consumed by the NEXT describe
  // block and fail tests that have nothing to do with projects.
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  /*
   * DevSphere AI has no projects concept: tenancy is the user, and a workspace
   * belongs directly to its owner_user_id. `/api/v1/projects` belonged to the
   * DevAccel USG service and is not served here, so these queries are disabled.
   * The tests below pin that they stay disabled — when they fetched, the 404
   * left `selectedProjectId` at 0 and the Workspaces page was permanently empty.
   */

  it("never calls the removed /api/v1/projects endpoint", async () => {
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useDbProjects(), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockAuthFetch).not.toHaveBeenCalled();
    expect(result.current.projects).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("stays quiet no matter how many components mount it", async () => {
    const { Wrapper } = createWrapper();

    renderHook(() => useDbProjects(), { wrapper: Wrapper });
    renderHook(() => useDbProjects(), { wrapper: Wrapper });
    renderHook(() => useDbProjects(), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("refresh() does not reach the network", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useDbProjects(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockAuthFetch).not.toHaveBeenCalled();
    expect(result.current.projects).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  useProjectDetail
// ═══════════════════════════════════════════════════════════════════════════

describe("useProjectDetail", () => {
  beforeEach(() => { mockAuthFetch.mockReset(); });

  it("never fetches — /api/v1/projects/{id} is not served by this product", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectDetail(5), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("does not fetch when projectId is null", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectDetail(null), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  useActiveModels
// ═══════════════════════════════════════════════════════════════════════════

describe("useActiveModels", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches active models and caches them", async () => {
    const models = [
      { id: 1, display_name: "GPT-4o", vendor: "azure_openai", vendor_label: "Azure", model_name: "gpt-4o", model_type: "chat" },
      { id: 2, display_name: "text-embed", vendor: "openai", vendor_label: "OpenAI", model_name: "text-embedding-3", model_type: "embedding" },
    ];
    mockAuthFetch.mockReturnValueOnce(jsonResponse(models));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useActiveModels(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].display_name).toBe("GPT-4o");
  });

  it("returns empty array on non-ok response", async () => {
    mockAuthFetch.mockReturnValueOnce(jsonResponse(null, 500));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useActiveModels(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it("deduplicates concurrent mounts (shared cache)", async () => {
    const models = [{ id: 1, display_name: "GPT-4o", vendor: "azure_openai", vendor_label: "Azure", model_name: "gpt-4o", model_type: "chat" }];
    mockAuthFetch.mockReturnValue(jsonResponse(models));
    const { Wrapper } = createWrapper();

    renderHook(() => useActiveModels(), { wrapper: Wrapper });
    renderHook(() => useActiveModels(), { wrapper: Wrapper });

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(1));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  useProfile
// ═══════════════════════════════════════════════════════════════════════════

describe("useProfile", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches profile data", async () => {
    const profile = {
      user: { id: 1, username: "john", email: "john@example.com", full_name: "John Doe", role: "admin", is_admin: true, is_active: true, created_at: null, last_login: null, login_count: 12 },
      teams: [{ id: 1, name: "Team A", description: null, role_in_team: "member" }],
      roles: ["workspace_studio"],
      stats: {
        active_workspaces: 5, archived_workspaces: 1, total_sessions: 9, active_sessions: 1,
        prompts_sent: 50, login_count: 12, llm_requests: 30, total_tokens: 120_000,
        tokens_this_month: 4_000, cost_this_month_usd: 1.25, last_active_at: null,
      },
    };
    mockAuthFetch.mockReturnValueOnce(jsonResponse(profile));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useProfile(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.user.username).toBe("john");
    expect(result.current.data?.stats.active_workspaces).toBe(5);
    expect(result.current.data?.stats.total_tokens).toBe(120_000);
  });

  // Regression guard: the profile page shipped pointing at the DevAccel API
  // (`${NEXT_PUBLIC_API_URL}/api/v1/me/profile`, port 8000), a service that
  // neither mints nor honours the DevSphere token — the page only ever rendered
  // "Profile unavailable".
  it("calls the DevSphere backend, not the DevAccel API", async () => {
    mockAuthFetch.mockReturnValueOnce(jsonResponse({}));
    const { Wrapper } = createWrapper();

    renderHook(() => useProfile(), { wrapper: Wrapper });
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());

    const url = String(mockAuthFetch.mock.calls[0][0]);
    expect(url).toContain("/auth/profile");
    expect(url).not.toContain("/api/v1/me/profile");
  });

  it("throws on non-ok response", async () => {
    mockAuthFetch.mockReturnValueOnce(jsonResponse({ detail: "Unauthorized" }, 401));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useProfile(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  useTeams
// ═══════════════════════════════════════════════════════════════════════════

describe("useTeams", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches admin groups and filters out Administrators", async () => {
    const groups = [
      { id: 1, name: "Team Alpha", description: "Alpha team" },
      { id: 2, name: "Administrators", description: "Admin group" },
      { id: 3, name: "Team Beta" },
    ];
    mockAuthFetch.mockReturnValueOnce(jsonResponse({ groups }));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useTeams(true), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.map((t) => t.name)).toEqual(["Team Alpha", "Team Beta"]);
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining("/admin/groups"), expect.anything(), expect.objectContaining({ silent: true }));
  });

  it("fetches own groups for non-admin", async () => {
    const groups = [{ id: 5, name: "My Team", description: "My group" }];
    mockAuthFetch.mockReturnValueOnce(jsonResponse({ groups }));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useTeams(false), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining("/me/groups"), expect.anything(), expect.objectContaining({ silent: true }));
  });

  it("returns empty array on failure", async () => {
    mockAuthFetch.mockReturnValueOnce(jsonResponse({}, 500));
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useTeams(true), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });
});
