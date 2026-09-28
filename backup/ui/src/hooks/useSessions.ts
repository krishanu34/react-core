import { useCallback } from "react";
import {
  listSessions,
  createSession,
  deleteSession,
  type SessionItem,
  type SessionStatus,
  type CreateSessionBody,
} from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";

/**
 * React hook that fetches and manages generation sessions for a project.
 *
 * @param projectId  – project to list sessions for (0 = skip fetch)
 * @param statusFilter – optional status filter ("active", "completed", "archived")
 */
export function useSessions(projectId: number, statusFilter?: SessionStatus, mateType?: string) {
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.sessions.list(projectId, statusFilter ?? undefined),
    queryFn: async () => {
      if (!projectId) return { sessions: [], total: 0 } as { sessions: SessionItem[]; total: number };
      return listSessions(projectId, { status: statusFilter, page_size: 100, mate_type: mateType });
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: Omit<CreateSessionBody, "project_id">) => createSession({ ...body, project_id: projectId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.list(projectId, statusFilter ?? undefined) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: number) => deleteSession(sessionId),
    onMutate: async (sessionId) => {
      const listKey = queryKeys.sessions.list(projectId, statusFilter ?? undefined);
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<{ sessions: SessionItem[]; total: number }>(listKey);
      qc.setQueryData<{ sessions: SessionItem[]; total: number }>(listKey, (old) =>
        old
          ? { sessions: old.sessions.filter((s) => s.id !== sessionId), total: old.total - 1 }
          : old,
      );
      return { previous, listKey };
    },
    onError: (_err, _sessionId, context) => {
      if (context?.previous) {
        qc.setQueryData(context.listKey, context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sessions.list(projectId, statusFilter ?? undefined) });
    },
  });

  return {
    sessions: (data?.sessions ?? []) as SessionItem[],
    total: data?.total ?? 0,
    loading: isLoading,
    error: isError ? new Error("Failed to load sessions") : null,
    refresh: refetch,
    add: (body: Omit<CreateSessionBody, "project_id">) => createMutation.mutateAsync(body),
    remove: (sessionId: number) => deleteMutation.mutateAsync(sessionId),
  };
}
