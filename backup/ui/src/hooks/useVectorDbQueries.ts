
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import {
  listVectorCollections,
  listVectorProjects,
  getVectorCollection,
  getVectorRecords,
  searchVectorCollection,
  searchVectorProject,
  refreshVectorCollection,
  reindexVectorCollection,
  deleteVectorRecord,
  exportVectorCollection,
  getVectorAuditLogs,
} from "@/lib/vector-db-api";

// ── Read queries ──────────────────────────────────────────────────────────

export function useVectorProjects() {
  return useQuery({
    queryKey: queryKeys.vectorDb.projects(),
    queryFn: listVectorProjects,
  });
}

export function useVectorCollections(projectId: number | null) {
  return useQuery({
    queryKey: queryKeys.vectorDb.collections(projectId ?? undefined),
    queryFn: () => listVectorCollections(projectId!),
    enabled: projectId !== null,
  });
}

export function useVectorCollection(name: string) {
  return useQuery({
    queryKey: queryKeys.vectorDb.collection(name),
    queryFn:  () => getVectorCollection(name),
    enabled:  !!name,
  });
}

export function useVectorRecords(
  collection: string,
  params: { page?: number; page_size?: number; record_id?: string },
) {
  return useQuery({
    queryKey: queryKeys.vectorDb.records(collection, params as Record<string, unknown>),
    queryFn:  () => getVectorRecords(collection, params),
    enabled:  !!collection,
  });
}

export function useVectorAuditLogs(params: {
  page?: number;
  page_size?: number;
  action?: string;
  collection?: string;
  username?: string;
  date_from?: string;
  date_to?: string;
}, enabled: boolean = true) {
  return useQuery({
    queryKey: queryKeys.vectorDb.auditLogs(params as Record<string, unknown>),
    queryFn:  () => getVectorAuditLogs(params),
    enabled,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────

type SearchBody = { query: string; top_k?: number; filters?: Record<string, string> };

export function useVectorSearch() {
  return useMutation({
    mutationFn: ({ collection, body }: { collection: string; body: SearchBody }) =>
      searchVectorCollection(collection, body),
  });
}

export function useVectorProjectSearch() {
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: number; body: SearchBody }) =>
      searchVectorProject(projectId, body),
  });
}

export function useRefreshCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (collection: string) => refreshVectorCollection(collection),
    onSuccess: (_, collection) => {
      qc.invalidateQueries({ queryKey: queryKeys.vectorDb.collections() });
      qc.invalidateQueries({ queryKey: queryKeys.vectorDb.collection(collection) });
    },
  });
}

export function useReindexCollection() {
  return useMutation({
    mutationFn: (collection: string) => reindexVectorCollection(collection),
  });
}

export function useDeleteVectorRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ collection, recordId }: { collection: string; recordId: string }) =>
      deleteVectorRecord(collection, recordId),
    onSuccess: (_, { collection }) => {
      qc.invalidateQueries({ queryKey: queryKeys.vectorDb.collections() });
      qc.invalidateQueries({ queryKey: queryKeys.vectorDb.records(collection, {}), exact: false });
    },
  });
}

export function useExportVectorCollection() {
  return useMutation({
    mutationFn: ({ collection, format }: { collection: string; format: "csv" | "json" }) =>
      exportVectorCollection(collection, format),
  });
}