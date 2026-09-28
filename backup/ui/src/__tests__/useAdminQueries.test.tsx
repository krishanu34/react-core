import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import {
  useAdminUsers,
  useAdminRoles,
  useAdminGroups,
  useAdminModels,
  useAllProjects,
  useUserGroups,
  useGroupMembers,
  useGroupProjects,
  useCreateUser,
  useDeactivateUser,
  useSetUserRoles,
  useToggleUserTeam,
  useCreateGroup,
  useSetGroupRoles,
  useAddGroupMember,
  useRemoveGroupMember,
  useAddGroupProject,
  useRemoveGroupProject,
  useToggleModel,
  useDeleteModel,
} from "@/hooks/useAdminQueries";

/* ── Mocks ────────────────────────────────────────────── */
const mockListUsers = vi.fn();
const mockListRoles = vi.fn();
const mockListGroups = vi.fn();
const mockListModels = vi.fn();
const mockListAllProjects = vi.fn();
const mockGetUserGroups = vi.fn();
const mockGetGroupMembers = vi.fn();
const mockGetGroupProjects = vi.fn();
const mockCreateUser = vi.fn();
const mockDeactivateUser = vi.fn();
const mockSetUserRoles = vi.fn();
const mockCreateGroup = vi.fn();
const mockSetGroupRoles = vi.fn();
const mockAddGroupMember = vi.fn();
const mockRemoveGroupMember = vi.fn();
const mockAddGroupProject = vi.fn();
const mockRemoveGroupProject = vi.fn();
const mockToggleModelActive = vi.fn();
const mockDeleteModel = vi.fn();

vi.mock("@/lib/admin-api", () => ({
  listUsers: (...args: any[]) => mockListUsers(...args),
  listRoles: (...args: any[]) => mockListRoles(...args),
  listGroups: (...args: any[]) => mockListGroups(...args),
  listModels: (...args: any[]) => mockListModels(...args),
  listAllProjects: (...args: any[]) => mockListAllProjects(...args),
  getUserGroups: (...args: any[]) => mockGetUserGroups(...args),
  getGroupMembers: (...args: any[]) => mockGetGroupMembers(...args),
  getGroupProjects: (...args: any[]) => mockGetGroupProjects(...args),
  createUser: (...args: any[]) => mockCreateUser(...args),
  deactivateUser: (...args: any[]) => mockDeactivateUser(...args),
  setUserRoles: (...args: any[]) => mockSetUserRoles(...args),
  createGroup: (...args: any[]) => mockCreateGroup(...args),
  setGroupRoles: (...args: any[]) => mockSetGroupRoles(...args),
  addGroupMember: (...args: any[]) => mockAddGroupMember(...args),
  removeGroupMember: (...args: any[]) => mockRemoveGroupMember(...args),
  addGroupProject: (...args: any[]) => mockAddGroupProject(...args),
  removeGroupProject: (...args: any[]) => mockRemoveGroupProject(...args),
  toggleModelActive: (...args: any[]) => mockToggleModelActive(...args),
  deleteModel: (...args: any[]) => mockDeleteModel(...args),
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
const sampleUsers = [
  { id: 1, username: "admin", email: "admin@test.com", full_name: "Admin User", role: "admin", is_active: true, last_login: null, roles: [] },
  { id: 2, username: "alice", email: "alice@test.com", full_name: "Alice Smith", role: "user", is_active: true, last_login: null, roles: ["create_project"] },
];

const sampleRoles = [
  { id: 1, name: "create_project", display_name: "Create Project" },
  { id: 2, name: "view_user_story", display_name: "View User Story" },
];

const sampleGroups = [
  { id: 1, name: "Administrators", description: "Admin group", group_type: "admin", is_active: true, roles: [] },
  { id: 2, name: "Dev Team", description: "Developers", group_type: "team", is_active: true, roles: ["create_project"] },
];

const sampleModels = [
  { id: 1, display_name: "GPT-4o", vendor: "azure_openai", vendor_label: "Azure OpenAI", model_type: "chat", model_type_label: "Chat", model_name: "gpt-4o", endpoint_url: "https://test.openai.azure.com", config: {}, is_active: true, created_by: 1, created_at: "2026-01-01", updated_at: "2026-01-01" },
];

const sampleProjects = [
  { id: 1, name: "Project Alpha" },
  { id: 2, name: "Project Beta" },
];

const sampleMembers = [
  { id: 1, username: "admin", email: "admin@test.com", full_name: "Admin User", group_role: "manager" },
  { id: 2, username: "alice", email: "alice@test.com", full_name: "Alice Smith", group_role: "member" },
];

const sampleGroupProjects = [
  { project_id: 1, project_name: "Project Alpha", access_level: "write" },
];

beforeEach(() => { vi.clearAllMocks(); });

/* ═══════════════════════════════════════════════════════════════════════════
   QUERY HOOKS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useAdminUsers", () => {
  it("fetches the user list", async () => {
    mockListUsers.mockResolvedValueOnce(sampleUsers);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAdminUsers(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleUsers);
    expect(mockListUsers).toHaveBeenCalledOnce();
  });
});

describe("useAdminRoles", () => {
  it("fetches the roles list", async () => {
    mockListRoles.mockResolvedValueOnce(sampleRoles);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAdminRoles(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleRoles);
  });
});

describe("useAdminGroups", () => {
  it("fetches the groups list", async () => {
    mockListGroups.mockResolvedValueOnce(sampleGroups);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAdminGroups(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleGroups);
  });
});

describe("useAdminModels", () => {
  it("fetches the model configs list", async () => {
    mockListModels.mockResolvedValueOnce(sampleModels);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAdminModels(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleModels);
  });
});

describe("useAllProjects", () => {
  it("fetches all projects", async () => {
    mockListAllProjects.mockResolvedValueOnce(sampleProjects);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAllProjects(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleProjects);
  });
});

describe("useUserGroups", () => {
  it("fetches groups for a specific user", async () => {
    const userGroups = [{ id: 2 }];
    mockGetUserGroups.mockResolvedValueOnce(userGroups);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useUserGroups(1), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(userGroups);
    expect(mockGetUserGroups).toHaveBeenCalledWith(1);
  });

  it("is disabled when userId is null", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useUserGroups(null), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useGroupMembers", () => {
  it("fetches members for a specific group", async () => {
    mockGetGroupMembers.mockResolvedValueOnce(sampleMembers);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useGroupMembers(2), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleMembers);
    expect(mockGetGroupMembers).toHaveBeenCalledWith(2);
  });

  it("is disabled when groupId is null", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useGroupMembers(null), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useGroupProjects", () => {
  it("fetches projects for a specific group", async () => {
    mockGetGroupProjects.mockResolvedValueOnce(sampleGroupProjects);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useGroupProjects(2), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleGroupProjects);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   MUTATION HOOKS
   ═══════════════════════════════════════════════════════════════════════ */

describe("useCreateUser", () => {
  it("creates a user and assigns roles", async () => {
    mockCreateUser.mockResolvedValueOnce({ id: 3 });
    mockSetUserRoles.mockResolvedValueOnce(undefined);
    mockListUsers.mockResolvedValueOnce(sampleUsers);
    const { Wrapper, qc } = createWrapper();
    // Pre-seed users cache
    qc.setQueryData(["admin", "users"], sampleUsers);

    const { result } = renderHook(() => useCreateUser(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        body: { username: "bob", email: "bob@test.com", full_name: "Bob Jones", password: "pw", role: "user" },
        roleIds: [1],
      });
    });
    expect(mockCreateUser).toHaveBeenCalledOnce();
    expect(mockSetUserRoles).toHaveBeenCalledWith(3, [1]);
  });
});

describe("useDeactivateUser", () => {
  it("deactivates a user and invalidates users cache", async () => {
    mockDeactivateUser.mockResolvedValueOnce(undefined);
    mockListUsers.mockResolvedValueOnce(sampleUsers);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "users"], sampleUsers);

    const { result } = renderHook(() => useDeactivateUser(), { wrapper: Wrapper });
    await act(async () => { await result.current.mutateAsync(2); });
    expect(mockDeactivateUser).toHaveBeenCalledWith(2);
  });
});

describe("useSetUserRoles", () => {
  it("sets roles for a user", async () => {
    mockSetUserRoles.mockResolvedValueOnce(undefined);
    mockListUsers.mockResolvedValueOnce(sampleUsers);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "users"], sampleUsers);

    const { result } = renderHook(() => useSetUserRoles(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ userId: 2, roleIds: [1, 2] });
    });
    expect(mockSetUserRoles).toHaveBeenCalledWith(2, [1, 2]);
  });
});

describe("useToggleUserTeam", () => {
  it("adds user to team when not a member", async () => {
    mockAddGroupMember.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useToggleUserTeam(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ userId: 2, groupId: 1, isMember: false });
    });
    expect(mockAddGroupMember).toHaveBeenCalledWith(1, 2, "member");
  });

  it("removes user from team when already a member", async () => {
    mockRemoveGroupMember.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useToggleUserTeam(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ userId: 2, groupId: 1, isMember: true });
    });
    expect(mockRemoveGroupMember).toHaveBeenCalledWith(1, 2);
  });
});

describe("useCreateGroup", () => {
  it("creates a group with members", async () => {
    mockCreateGroup.mockResolvedValueOnce({ id: 3 });
    mockAddGroupMember.mockResolvedValue(undefined);
    mockListGroups.mockResolvedValueOnce(sampleGroups);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "groups"], sampleGroups);

    const { result } = renderHook(() => useCreateGroup(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        body: { name: "QA Team", description: "Testers", group_type: "team" },
        memberIds: [1, 2],
      });
    });
    expect(mockCreateGroup).toHaveBeenCalledOnce();
    expect(mockAddGroupMember).toHaveBeenCalledTimes(2);
  });
});

describe("useSetGroupRoles", () => {
  it("sets roles for a group", async () => {
    mockSetGroupRoles.mockResolvedValueOnce(undefined);
    mockListGroups.mockResolvedValueOnce(sampleGroups);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "groups"], sampleGroups);

    const { result } = renderHook(() => useSetGroupRoles(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ groupId: 2, roleIds: [1] });
    });
    expect(mockSetGroupRoles).toHaveBeenCalledWith(2, [1]);
  });
});

describe("useAddGroupMember", () => {
  it("adds a member and invalidates member cache", async () => {
    mockAddGroupMember.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "groups", 2, "members"], sampleMembers);

    const { result } = renderHook(() => useAddGroupMember(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ groupId: 2, userId: 3, role: "member" });
    });
    expect(mockAddGroupMember).toHaveBeenCalledWith(2, 3, "member");
  });
});

describe("useRemoveGroupMember", () => {
  it("removes a member", async () => {
    mockRemoveGroupMember.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoveGroupMember(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ groupId: 2, userId: 1 });
    });
    expect(mockRemoveGroupMember).toHaveBeenCalledWith(2, 1);
  });
});

describe("useAddGroupProject", () => {
  it("adds a project to a group", async () => {
    mockAddGroupProject.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAddGroupProject(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ groupId: 2, projectId: 1, accessLevel: "write" });
    });
    expect(mockAddGroupProject).toHaveBeenCalledWith(2, 1, "write");
  });
});

describe("useRemoveGroupProject", () => {
  it("removes a project from a group", async () => {
    mockRemoveGroupProject.mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoveGroupProject(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ groupId: 2, projectId: 1 });
    });
    expect(mockRemoveGroupProject).toHaveBeenCalledWith(2, 1);
  });
});

describe("useToggleModel", () => {
  it("toggles model active state", async () => {
    mockToggleModelActive.mockResolvedValueOnce(undefined);
    mockListModels.mockResolvedValueOnce(sampleModels);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "models"], sampleModels);

    const { result } = renderHook(() => useToggleModel(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 1, isActive: false });
    });
    expect(mockToggleModelActive).toHaveBeenCalledWith(1, false);
  });
});

describe("useDeleteModel", () => {
  it("deletes a model and invalidates cache", async () => {
    mockDeleteModel.mockResolvedValueOnce(undefined);
    mockListModels.mockResolvedValueOnce(sampleModels);
    const { Wrapper, qc } = createWrapper();
    qc.setQueryData(["admin", "models"], sampleModels);

    const { result } = renderHook(() => useDeleteModel(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync(1);
    });
    expect(mockDeleteModel).toHaveBeenCalledWith(1);
  });
});
