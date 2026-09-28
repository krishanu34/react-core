"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import {
  listUsers,
  listRoles,
  listGroups,
  listModels,
  listAllProjects,
  getUserGroups,
  getGroupMembers,
  getGroupProjects,
  createUser,
  deactivateUser,
  setUserRoles,
  createGroup,
  setGroupRoles,
  addGroupMember,
  removeGroupMember,
  addGroupProject,
  removeGroupProject,
  testModel,
  createModel,
  probeOllama,
  toggleModelActive,
  deleteModel,
  type AdminUser,
  type AdminRole,
  type AdminGroup,
  type GroupMember,
  type GroupProject,
  type ProjectOption,
  type ModelConfig,
} from "@/lib/admin-api";

// ═══════════════════════════════════════════════════════════════════════════
//  QUERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════

export function useAdminUsers() {
  return useQuery<AdminUser[]>({
    queryKey: queryKeys.admin.users(),
    queryFn: listUsers,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useAdminRoles() {
  return useQuery<AdminRole[]>({
    queryKey: queryKeys.admin.roles(),
    queryFn: listRoles,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useAdminGroups() {
  return useQuery<AdminGroup[]>({
    queryKey: queryKeys.admin.groups(),
    queryFn: listGroups,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useAdminModels() {
  return useQuery<ModelConfig[]>({
    queryKey: queryKeys.admin.models(),
    queryFn: listModels,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useAllProjects() {
  return useQuery<ProjectOption[]>({
    queryKey: queryKeys.admin.allProjects(),
    queryFn: listAllProjects,
  });
}

export function useUserGroups(userId: number | null) {
  return useQuery<{ id: number }[]>({
    queryKey: queryKeys.admin.userGroups(userId!),
    queryFn: () => getUserGroups(userId!),
    enabled: userId != null,
  });
}

export function useGroupMembers(groupId: number | null) {
  return useQuery<GroupMember[]>({
    queryKey: queryKeys.admin.groupMembers(groupId!),
    queryFn: () => getGroupMembers(groupId!),
    enabled: groupId != null,
  });
}

export function useGroupProjects(groupId: number | null) {
  return useQuery<GroupProject[]>({
    queryKey: queryKeys.admin.groupProjects(groupId!),
    queryFn: () => getGroupProjects(groupId!),
    enabled: groupId != null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MUTATION HOOKS
// ═══════════════════════════════════════════════════════════════════════════

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      body: Parameters<typeof createUser>[0];
      roleIds?: number[];
    }) => {
      const created = await createUser(vars.body);
      if (vars.roleIds && vars.roleIds.length > 0 && created.id) {
        await setUserRoles(created.id, vars.roleIds);
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => deactivateUser(userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useSetUserRoles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: number; roleIds: number[] }) =>
      setUserRoles(vars.userId, vars.roleIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useToggleUserTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { userId: number; groupId: number; isMember: boolean }) => {
      if (vars.isMember) {
        await removeGroupMember(vars.groupId, vars.userId);
      } else {
        await addGroupMember(vars.groupId, vars.userId, "member");
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.userGroups(vars.userId) });
    },
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      body: { name: string; description: string; group_type: string };
      memberIds?: number[];
    }) => {
      const created = await createGroup(vars.body);
      const newId = created.id ?? created.group?.id;
      if (newId && vars.memberIds && vars.memberIds.length > 0) {
        await Promise.all(
          vars.memberIds.map((uid) => addGroupMember(newId, uid, "member")),
        );
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.groups() });
    },
  });
}

export function useSetGroupRoles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: number; roleIds: number[] }) =>
      setGroupRoles(vars.groupId, vars.roleIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.groups() });
    },
  });
}

export function useAddGroupMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: number; userId: number; role: string }) =>
      addGroupMember(vars.groupId, vars.userId, vars.role),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.groupMembers(vars.groupId) });
    },
  });
}

export function useRemoveGroupMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: number; userId: number }) =>
      removeGroupMember(vars.groupId, vars.userId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.groupMembers(vars.groupId) });
    },
  });
}

export function useAddGroupProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: number; projectId: number; accessLevel: string }) =>
      addGroupProject(vars.groupId, vars.projectId, vars.accessLevel),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.groupProjects(vars.groupId) });
    },
  });
}

export function useRemoveGroupProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: number; projectId: number }) =>
      removeGroupProject(vars.groupId, vars.projectId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.groupProjects(vars.groupId) });
    },
  });
}

export function useTestAndSaveModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      testBody: Record<string, unknown>;
      saveBody: Record<string, unknown>;
    }) => {
      const testResult = await testModel(vars.testBody);
      if (!testResult.success) {
        throw new Error(testResult.message ?? "Test failed");
      }
      await createModel(vars.saveBody);
      return testResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.models() });
    },
  });
}

export function useProbeOllama() {
  return useMutation({
    mutationFn: (endpointUrl: string) => probeOllama(endpointUrl),
  });
}

export function useSaveOllamaModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      models: Record<string, string>;
      endpointUrl: string;
      onProgress?: (done: number, total: number, errors: string[]) => void;
    }) => {
      const entries = Object.entries(vars.models);
      const errors: string[] = [];
      let done = 0;

      for (const [modelName, mType] of entries) {
        try {
          const testResult = await testModel({
            vendor: "ollama",
            model_type: mType,
            model_name: modelName,
            endpoint_url: vars.endpointUrl,
            config: {},
          });
          if (!testResult.success) {
            errors.push(`${modelName}: ${testResult.message}`);
            done++;
            vars.onProgress?.(done, entries.length, [...errors]);
            continue;
          }
          await createModel({
            display_name: modelName,
            vendor: "ollama",
            model_type: mType,
            model_name: modelName,
            endpoint_url: vars.endpointUrl,
            is_active: true,
          });
        } catch (e) {
          errors.push(`${modelName}: ${e instanceof Error ? e.message : "Error"}`);
        }
        done++;
        vars.onProgress?.(done, entries.length, [...errors]);
      }
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.models() });
    },
  });
}

export function useToggleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; isActive: boolean }) =>
      toggleModelActive(vars.id, vars.isActive),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.models() });
    },
  });
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteModel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.models() });
    },
  });
}
