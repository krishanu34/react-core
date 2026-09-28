// ─────────────────────────────────────────────────────────────────────────────
// API client for Vector DB Explorer  (/api/v1/admin/vector-db/*)
// ─────────────────────────────────────────────────────────────────────────────

import { authFetch } from "./auth";

const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/v1/admin/vector-db`;

// ── Types ─────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  project_id: number;
  project_name: string;
}

export interface CollectionSummary {
  name: string;
  vector_count: number;
  dimension: number | null;
  index_type: string | null;
  last_updated: string | null;
  storage_size_bytes: number | null;
}

export interface CollectionColumn {
  name: string;
  type: string;
  nullable: string;
}

export interface CollectionDetail {
  name: string;
  vector_count: number;
  null_vector_count: number;
  dimension: number | null;
  index_type: string | null;
  index_name: string | null;
  last_updated: string | null;
  storage_size_bytes: number | null;
  columns: CollectionColumn[];
  collection_metadata: Record<string, unknown> | null;
  source_files: string[];
  avg_token_count: number | null;
  total_tokens: number | null;
  top_keywords: string[];
}

export interface VectorRecord {
  record_id: string;
  metadata: Record<string, unknown>;
  dimension_summary: string | null;
  source_reference: string | null;
  document: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface RecordsPage {
  items: VectorRecord[];
  total: number;
  page: number;
  page_size: number;
}

export interface SearchResult {
  record_id: string;
  score: number;
  metadata: Record<string, unknown>;
  source_reference: string | null;
  document: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  collection: string;
  query: string;
  total_returned: number;
}

export interface AuditLogEntry {
  id: number;
  username: string;
  action: string;
  collection: string;
  details: Record<string, unknown>;
  status: string;
  created_at: string;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  total: number;
  page: number;
  page_size: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function ok<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(body || res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Projects ──────────────────────────────────────────────────────────────

export async function listVectorProjects(): Promise<ProjectSummary[]> {
  return ok(await authFetch(`${BASE}/projects`));
}

// ── Collections ───────────────────────────────────────────────────────────

export async function listVectorCollections(projectId: number): Promise<CollectionSummary[]> {
  return ok(await authFetch(`${BASE}/collections?project_id=${projectId}`));
}

export async function getVectorCollection(name: string): Promise<CollectionDetail> {
  return ok(await authFetch(`${BASE}/collections/${encodeURIComponent(name)}`));
}

// ── Records ───────────────────────────────────────────────────────────────

export async function getVectorRecords(
  collection: string,
  params: { page?: number; page_size?: number; record_id?: string },
): Promise<RecordsPage> {
  const qs = new URLSearchParams();
  if (params.page)      qs.set("page",      String(params.page));
  if (params.page_size) qs.set("page_size", String(params.page_size));
  if (params.record_id) qs.set("record_id", params.record_id);
  return ok(await authFetch(`${BASE}/collections/${encodeURIComponent(collection)}/records?${qs}`));
}

// ── Search ────────────────────────────────────────────────────────────────

export async function searchVectorCollection(
  collection: string,
  body: { query: string; top_k?: number; threshold?: number; filters?: Record<string, string> },
): Promise<SearchResponse> {
  return ok(
    await authFetch(`${BASE}/collections/${encodeURIComponent(collection)}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function searchVectorProject(
  projectId: number,
  body: { query: string; top_k?: number; threshold?: number; filters?: Record<string, string> },
): Promise<SearchResponse> {
  return ok(
    await authFetch(`${BASE}/projects/${projectId}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// ── Admin actions ─────────────────────────────────────────────────────────

export async function refreshVectorCollection(collection: string): Promise<CollectionDetail> {
  return ok(
    await authFetch(`${BASE}/collections/${encodeURIComponent(collection)}/refresh`, {
      method: "POST",
    }),
  );
}

export async function reindexVectorCollection(collection: string): Promise<{ status: string }> {
  return ok(
    await authFetch(`${BASE}/collections/${encodeURIComponent(collection)}/reindex`, {
      method: "POST",
    }),
  );
}

export async function deleteVectorRecord(
  collection: string,
  recordId: string,
): Promise<{ deleted: boolean }> {
  return ok(
    await authFetch(
      `${BASE}/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(recordId)}`,
      { method: "DELETE" },
    ),
  );
}

export async function exportVectorCollection(
  collection: string,
  format: "csv" | "json",
): Promise<void> {
  const res = await authFetch(
    `${BASE}/collections/${encodeURIComponent(collection)}/export`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    },
  );
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${collection}_export.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Audit logs ────────────────────────────────────────────────────────────

export async function getVectorAuditLogs(params: {
  page?: number;
  page_size?: number;
  action?: string;
  collection?: string;
  username?: string;
  date_from?: string;
  date_to?: string;
}): Promise<AuditLogPage> {
  const qs = new URLSearchParams();
  if (params.page)       qs.set("page",       String(params.page));
  if (params.page_size)  qs.set("page_size",  String(params.page_size));
  if (params.action)     qs.set("action",     params.action);
  if (params.collection) qs.set("collection", params.collection);
  if (params.username)   qs.set("username",   params.username);
  if (params.date_from)  qs.set("date_from",  params.date_from);
  if (params.date_to)    qs.set("date_to",    params.date_to);
  return ok(await authFetch(`${BASE}/audit-logs?${qs}`));
}