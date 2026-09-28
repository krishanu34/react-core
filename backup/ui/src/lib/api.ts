// ─────────────────────────────────────────────────────────────────────────────
// API client for the Story Builder Pipeline backend (pipeline_api.py on :8088)
// ─────────────────────────────────────────────────────────────────────────────

import { authFetch } from "./auth";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const API  = `${BASE}/api/v1`;

// ── Types mirroring the Python Pydantic models ────────────────────────────

export type QualityLevel  = "fast" | "standard" | "high";
export type EpicMode      = "story_only" | "feature_story" | "epic_story" | "epic_feature_story";
export type StandardsType = "tmforum-etom" | "tmforum-sid";
export type JobStatus     = "pending" | "running" | "completed" | "updated" | "failed" | "cancelled";
export type SessionStatus = "active" | "completed" | "archived";

export interface PipelineOptions {
  quality?: QualityLevel;
  project_id?: number;
  session_id?: number;
  session_name?: string;
  document_builder_run_id?: string;
  use_epics?: boolean;
  epic_mode?: EpicMode;
  use_code_context?: boolean;
  use_project_context?: boolean;
  use_figma?: boolean;
  use_image_context?: boolean;
  use_standards?: boolean;
  standards_types?: StandardsType[];
  /** Per-stage or global custom prompt instructions keyed by stage id or "global" */
  custom_instructions?: Record<string, unknown>;
}

export interface JobSubmittedResponse {
  job_id: string;
  status: JobStatus;
  submitted_at: string;
  requirement_file: string;
  stream_url: string;
  status_url: string;
}

export interface StageProgress {
  current_stage: string | null;
  completed_stages: number;
  total_stages: number;
  percent: number;
}

export interface StageCheckpoint {
  stage_number: number;
  stage_name: string;
  status: string;
  completed_at: string | null;
  duration_seconds: number | null;
}

export interface FileMetadata {
  filename: string;
  file_size_bytes: number;
  file_type: string;
  uploaded_at: string;
  local_path: string | null;
  blob_path: string | null;
  blob_url: string | null;
  storage_mode: string;
  total_tokens: number | null;
  chunk_count: number | null;
  skip_chunking: boolean | null;
  source_files: SourceFileInfo[] | null;
}

export interface SourceFileInfo {
  filename: string;
  file_size_bytes: number;
  file_type: string;
  local_path: string | null;
  blob_path: string | null;
  blob_url: string | null;
}

export interface RequirementPreviewResponse {
  filename: string;
  file_type: string;
  file_size_bytes: number;
  storage_mode: string;
  uploaded_at: string | null;
  blob_url: string | null;
  total_tokens: number | null;
  chunk_count: number | null;
  /** "html" = DOCX converted to HTML, "pdf" = fetch /requirement-file, "text" = plain */
  render_mode: "html" | "pdf" | "text";
  html_content: string | null;
  content: string | null;
  /** Image summaries extracted from the uploaded document */
  image_summaries?: Array<{
    image_path: string;
    is_relevant: boolean;
    image_type?: string;
    overview?: string;
    detailed_explanation?: string;
    error?: string;
  }>;
}

export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  progress: StageProgress | null;
  error: string | null;
  request_options: PipelineOptions;
  stage_checkpoint: StageCheckpoint[] | null;
  file_metadata: FileMetadata | null;
}

export interface JobListItem {
  job_id: string;
  status: JobStatus;
  submitted_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  requirement_file: string;
  total_stories: number;
  quality: QualityLevel;
  request_options: PipelineOptions | null;
  project_id: number | null;
  session_id: number | null;
  session_name: string | null;
  is_selected: boolean;
  review_flag: boolean;
}

export interface StoryRelationships {
  blocks:     string[];
  blocked_by: string[];
  parent_of:  string[];
  child_of:   string | null;
  related?:   string[];
}

export interface CitationEntry {
  type: "requirement" | "doc" | "code" | "figma" | "standard";
  source?: string;
  source_file_id?: string | null;
  page?: string;
  section?: string;
  preview?: string;
  full_text?: string;
  chunk_id?: string;
  score?: number;
  // code-specific
  file_path?: string;
  file_name?: string;
  // figma-specific
  component_name?: string;
  component_type?: string;
  frame?: string;
  // standard-specific
  standard_type?: string;
  entity_name?: string;
  confidence?: number;
  // set to true when the LLM referenced this citation but no matching context chunk was found
  unresolved?: boolean;
  // blob URLs of extracted images referenced in this citation's source chunk
  image_blob_urls?: string[];
}

export interface StoryItem {
  story_id: string;
  title: string;
  description: string | null;
  story_points: number | null;
  epic_id: string | null;
  feature_id: string | null;
  feature_name: string | null;
  business_rules: string[];
  acceptance_criteria: string[];
  technical_changes: string[];
  implementation_notes: string | null;
  code_references: Record<string, unknown>[];
  relationships: StoryRelationships | null;
  standards_validation: Record<string, unknown> | null;
  citation_metadata: Record<string, CitationEntry> | null;
  /** User-defined custom fields (e.g. definition_of_done, risk_assessment) */
  extra_fields: Record<string, unknown> | null;
}

export interface FeatureItem {
  feature_id: string;
  feature_name: string;
  feature_description: string | null;
  stories: StoryItem[];
}

export interface EpicItem {
  epic_id: string;
  epic_name: string;
  epic_goal: string | null;
  features: FeatureItem[];  // populated in epic-feature-story mode
  stories: StoryItem[];     // populated in epic-story mode (no features)
}

export interface ExecutionSummary {
  total_duration: number;
  stages_executed: number;
  stages_skipped: number;
  stages_failed: number;
}

export interface PipelineResultResponse {
  job_id: string;
  status: JobStatus;
  submitted_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  request_options: PipelineOptions;
  total_stories: number;
  total_features: number;
  total_epics: number;
  total_story_points: number;
  epics: EpicItem[];
  features: FeatureItem[];
  stories: StoryItem[];           // flat list populated in story_only mode
  execution_summary: ExecutionSummary | null;
  standards_validation: Record<string, unknown> | null;
  hallucination_rate: number | null;
  average_quality_score: number | null;
  output_files: { raw_pipeline_output: string; clean_stories: string | null };
}

export interface HealthResponse {
  status:   "ok" | "degraded" | "error" | string;
  version:  string;
  pipeline: string;
  db:       string;   // e.g. "ok" | "error" | "unknown"
  llm:      string;   // e.g. "ok" | "not_configured" | "unknown"
}

export interface StandardsInfo {
  id: string;
  name: string;
  description: string;
  entity_count: number;
  is_loaded: boolean;
}

// ── Pipeline endpoints ────────────────────────────────────────────────────

export async function submitPipeline(
  files: File[],
  options: PipelineOptions,
  confluenceUrls: string[] = []
): Promise<JobSubmittedResponse> {
  const form = new FormData();
  // Backend accepts List[UploadFile] under the field name "requirement_files".
  // Sending multiple entries with the same key is how multipart/form-data carries arrays.
  for (const file of files) {
    form.append("requirement_files", file);
  }
  form.append("options", JSON.stringify(options));
  // Confluence URLs are passed as a JSON-encoded array string. Backend reads
  // them via the "confluence_urls" Form field and fetches each page (and its
  // sub-tree) using the project's atlassian_config credentials.
  form.append("confluence_urls", JSON.stringify(confluenceUrls));

  const res = await authFetch(`${API}/pipeline/run`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to submit pipeline");
  }
  return res.json();
}

export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/status`);
  if (!res.ok) throw new Error(`Job ${jobId} not found`);
  return res.json();
}

export async function getRequirementPreview(jobId: string): Promise<RequirementPreviewResponse> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/requirement-preview`);
  if (!res.ok) throw new Error("Requirement file preview not available");
  return res.json();
}

export async function getRequirementFile(jobId: string): Promise<string> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/requirement-file`);
  if (!res.ok) throw new Error("Requirement file not available");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function getSourceFilePreview(jobId: string, fileIndex: number): Promise<RequirementPreviewResponse> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/source-file/${fileIndex}/preview`);
  if (!res.ok) throw new Error("Source file preview not available");
  return res.json();
}

export async function getSourceFileDownload(jobId: string, fileIndex: number): Promise<string> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/source-file/${fileIndex}/download`);
  if (!res.ok) throw new Error("Source file download not available");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function listJobs(projectId?: number, sessionId?: number): Promise<JobListItem[]> {
  const params = new URLSearchParams({ limit: "50", source: "story_builder" });
  if (projectId != null) params.set("project_id", String(projectId));
  if (sessionId != null) params.set("session_id", String(sessionId));
  const res = await authFetch(`${API}/pipeline/jobs?${params}`);
  if (!res.ok) throw new Error("Failed to fetch jobs");
  return res.json();
}

export async function deleteJob(jobId: string): Promise<void> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Failed to delete job ${jobId}`);
  }
}

export async function cancelJob(jobId: string): Promise<{ status: string; message: string }> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
  return res.json();
}

export async function markJobFlags(
  jobId: string,
  flags: { is_selected?: boolean; review_flag?: boolean },
): Promise<JobListItem> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/flags`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
  if (!res.ok) throw new Error("Failed to update job flags");
  return res.json();
}

export async function getJobResult(jobId: string): Promise<PipelineResultResponse> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/result`);
  if (!res.ok) throw new Error("Result not ready");
  return res.json();
}

// ── Document preview (context file chunks) ────────────────────────────────

export interface DocumentChunk {
  file_id: number;
  chunk_index: number;
  chunk_text: string;
  section: string | null;
}

export interface DocumentPreviewResponse {
  source_file_name: string;
  total_chunks: number;
  highlight_chunk_index: number;
  chunks: DocumentChunk[];
}

export async function getDocumentPreview(fileId: number): Promise<DocumentPreviewResponse> {
  const res = await authFetch(`${API}/context-files/${fileId}/document-preview`);
  if (!res.ok) throw new Error("Document preview not available");
  return res.json();
}

export async function getDocumentPreviewBySource(
  projectId: number,
  sourceName: string,
  previewText?: string,
): Promise<DocumentPreviewResponse> {
  const params = new URLSearchParams({
    project_id: String(projectId),
    source_name: sourceName,
  });
  if (previewText) params.set("preview_text", previewText.slice(0, 300));
  const res = await authFetch(`${API}/context-files/preview-by-source?${params}`);
  if (!res.ok) throw new Error("Document preview not available");
  return res.json();
}

/**
 * Download an image from Azure Blob Storage via the backend proxy.
 * Extracts the blob_name from a full blob URL and triggers a file download.
 */
export async function downloadBlobImage(blobUrl: string): Promise<void> {
  // Extract blob_name from URL: https://<account>.blob.core.windows.net/<container>/<blob_name>
  const match = blobUrl.match(/\.blob\.core\.windows\.net\/[^/]+\/(.+)$/);
  if (!match) throw new Error("Invalid blob URL");
  const blobName = decodeURIComponent(match[1]);
  const res = await authFetch(`${API}/blob/download?blob_name=${encodeURIComponent(blobName)}`);
  if (!res.ok) throw new Error("Blob download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = blobName.split("/").pop() || "image";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build an authenticated URL for inline display of a blob image.
 * Extracts the blob_name from a full blob URL.
 */
export function getBlobImageSrc(blobUrl: string): string {
  const match = blobUrl.match(/\.blob\.core\.windows\.net\/[^/]+\/(.+)$/);
  if (!match) return blobUrl;
  const blobName = decodeURIComponent(match[1]);
  return `${API}/blob/download?blob_name=${encodeURIComponent(blobName)}`;
}

export function getStreamUrl(jobId: string, includeLogs = true): string {
  return `${API}/pipeline/jobs/${jobId}/stream?include_logs=${includeLogs}`;
}

// ── Health ────────────────────────────────────────────────────────────────

export async function getHealth(): Promise<HealthResponse> {
  const res = await authFetch(`${API}/health`);
  if (!res.ok) throw new Error("Health check failed");
  return res.json();
}

// ── DB Monitor ───────────────────────────────────────────────────────────

export interface DbKpis {
  total_24h:   number;
  errors_24h:  number;
  slow_24h:    number;
  avg_ms_24h:  number;
  max_ms_24h:  number;
  total_1h:    number;
  avg_ms_1h:   number;
}

export interface SlowQueryRow {
  query_type:    string;
  table_name:    string | null;
  query_pattern: string;
  call_count:    number;
  avg_ms:        number;
  max_ms:        number;
  min_ms:        number;
  error_count:   number;
  last_seen:     string;
}

export interface TableStatRow {
  table_name: string;
  query_type: string;
  calls:      number;
  avg_ms:     number;
  max_ms:     number;
}

export interface TypeBreakdownRow {
  query_type: string;
  calls:      number;
  avg_ms:     number;
  max_ms:     number;
  errors:     number;
}

export interface TimelineBucket {
  bucket:  string;
  calls:   number;
  avg_ms:  number;
}

export interface DbMonitorSummary {
  kpis:             DbKpis;
  slow_queries:     SlowQueryRow[];
  table_stats:      TableStatRow[];
  type_breakdown:   TypeBreakdownRow[];
  timeline:         TimelineBucket[];
  tracking_enabled: boolean;
  slow_threshold_ms: number;
  warning?:         string;
}

export interface RecentQueryRow {
  id:            number;
  query_type:    string;
  table_name:    string | null;
  query_pattern: string;
  execution_ms:  number;
  error:         string | null;
  created_at:    string;
}

export interface DbMonitorRecent {
  rows:    RecentQueryRow[];
  count:   number;
  warning?: string;
}

export async function getDbMonitorSummary(): Promise<DbMonitorSummary> {
  const res = await authFetch(`${API}/admin/db-monitor/summary`);
  if (!res.ok) throw new Error("DB monitor summary failed");
  return res.json();
}

export async function getDbMonitorRecent(
  opts: { limit?: number; errorsOnly?: boolean; tableName?: string; queryType?: string } = {}
): Promise<DbMonitorRecent> {
  const p = new URLSearchParams();
  if (opts.limit)      p.set("limit",       String(opts.limit));
  if (opts.errorsOnly) p.set("errors_only",  "true");
  if (opts.tableName)  p.set("table_name",   opts.tableName);
  if (opts.queryType)  p.set("query_type",   opts.queryType);
  const res = await authFetch(`${API}/admin/db-monitor/recent?${p}`);
  if (!res.ok) throw new Error("DB monitor recent failed");
  return res.json();
}

export async function getStandards(): Promise<StandardsInfo[]> {
  const res = await authFetch(`${API}/standards`);
  if (!res.ok) throw new Error("Failed to fetch standards");
  const data = await res.json();
  // endpoint returns { standards: [...] } — unwrap
  return Array.isArray(data) ? data : (data.standards ?? []);
}

// ── Refinement & Approval ─────────────────────────────────────────────────

export interface ArtifactMapEntry {
  db_id: number;
  artifact_type: string;
  artifact_id: string;
  title: string | null;
  version: number;
  is_approved: boolean;
  is_latest_version: boolean;
  parent_artifact_db_id: number | null;
  external_url?: string | null;
}

/** content-id (e.g. "STORY-001") → ArtifactMapEntry */
export type ArtifactMap = Record<string, ArtifactMapEntry>;

export interface StoryImpactStory {
  story_id: string;
  title: string;
  description: string | null;
  story_points: number | null;
  feature_id: string | null;
  feature_name: string | null;
  acceptance_criteria: string[];
  business_rules: string[];
  artifact_db_id: number | null;
  is_approved: boolean;
}

export type StoryImpactCategory = "added" | "modified" | "deleted" | "unchanged";
export type StoryImpactDecision = "approved" | "rejected";

export interface StoryImpactItem {
  change_id: string;
  category: StoryImpactCategory;
  confidence: number;
  current_story: StoryImpactStory | null;
  previous_story: StoryImpactStory | null;
  changed_fields: string[];
  decision: StoryImpactDecision | null;
  decided_at: string | null;
}

export interface StoryImpactResponse {
  job_id: string;
  previous_job_id: string | null;
  project_id: number | null;
  session_id: number | null;
  requirement_file_name: string | null;
  has_previous_version: boolean;
  summary: Record<StoryImpactCategory, number>;
  items: StoryImpactItem[];
}

export async function getJobArtifactMap(jobId: string): Promise<ArtifactMap> {
  const res = await authFetch(`${API}/jobs/${jobId}/artifact-map`);
  if (!res.ok) throw new Error("Failed to fetch artifact map");
  return res.json();
}

export async function getStoryImpact(jobId: string): Promise<StoryImpactResponse> {
  const res = await authFetch(`${API}/jobs/${jobId}/story-impact`);
  if (!res.ok) throw new Error("Failed to fetch story impact");
  return res.json();
}

export async function decideStoryImpact(
  jobId: string,
  changeId: string,
  decision: StoryImpactDecision,
): Promise<{ job_id: string; change_id: string; decision: StoryImpactDecision }> {
  const res = await authFetch(`${API}/jobs/${jobId}/story-impact/${changeId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to record story impact decision");
  }
  return res.json();
}

export interface RefineRequest {
  user_feedback: string;
  preserve_fields?: string[];
  regenerate_fields?: string[];
  quality_level?: "BASIC" | "STANDARD" | "DETAILED";
}

export interface RefineResponse {
  success: boolean;
  message: string;
  original_artifact_id: number;
  new_artifact_id: number | null;
  from_version: number;
  to_version: number;
  quality_score_before: number | null;
  quality_score_after: number | null;
  changes_summary: Record<string, unknown>;
  refinement_history_id: number | null;
}

export interface VersionInfo {
  id: number;
  version: number;
  artifact_type: string;
  title: string | null;
  description: string | null;
  is_latest_version: boolean | null;
  is_approved: boolean | null;
  quality_score: number | null;
  parent_version_id: number | null;
  created_at: string | null;
  content: Record<string, unknown>;
  refinement_prompt: string | null;
}

export interface ApproveResponse {
  approved_ids: number[];
  count: number;
}

export interface UnapproveResponse {
  unapproved_ids: number[];
  count: number;
}

export interface RefinementHistoryItem {
  id: number;
  artifact_id: number;
  original_artifact_id: number;
  user_feedback: string;
  artifact_type: string;
  from_version: number;
  to_version: number;
  quality_score_before: number | null;
  quality_score_after: number | null;
  changes_summary: Record<string, unknown>;
  refined_at: string | null;
  refined_by_user_id: number | null;
}

export async function refineArtifact(
  artifactId: number,
  body: RefineRequest,
): Promise<RefineResponse> {
  const res = await authFetch(`${API}/artifacts/${artifactId}/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Refinement failed");
  }
  return res.json();
}

export async function getArtifactVersions(artifactId: number): Promise<VersionInfo[]> {
  const res = await authFetch(`${API}/artifacts/${artifactId}/versions`);
  if (!res.ok) throw new Error("Failed to fetch versions");
  return res.json();
}

export async function selectVersion(
  artifactId: number,
  versionId: number,
): Promise<{ id: number; version: number; is_latest_version: boolean }> {
  const res = await authFetch(`${API}/artifacts/${artifactId}/select-version`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version_id: versionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Version selection failed");
  }
  return res.json();
}

export async function approveArtifact(
  artifactId: number,
  cascade = true,
): Promise<ApproveResponse> {
  const res = await authFetch(`${API}/artifacts/${artifactId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cascade }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Approval failed");
  }
  return res.json();
}

export async function unapproveArtifact(
  artifactId: number,
  cascade = true,
): Promise<UnapproveResponse> {
  const res = await authFetch(`${API}/artifacts/${artifactId}/unapprove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cascade }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Unapproval failed");
  }
  return res.json();
}

export async function getRefinementHistory(params: {
  artifact_id?: number;
  session_id?: number;
  project_id?: number;
  artifact_type?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<RefinementHistoryItem[]> {
  const p = new URLSearchParams();
  if (params.artifact_id != null) p.set("artifact_id", String(params.artifact_id));
  if (params.session_id != null)  p.set("session_id", String(params.session_id));
  if (params.project_id != null)  p.set("project_id", String(params.project_id));
  if (params.artifact_type)       p.set("artifact_type", params.artifact_type);
  if (params.limit != null)       p.set("limit", String(params.limit));
  if (params.offset != null)      p.set("offset", String(params.offset));
  const res = await authFetch(`${API}/refinement-history?${p}`);
  if (!res.ok) throw new Error("Failed to fetch refinement history");
  return res.json();
}

// ── Sessions ──────────────────────────────────────────────────────────────

export interface SessionItem {
  id: number;
  project_id: number;
  user_id: number;
  session_name: string;
  topic: string | null;
  description: string | null;
  status: SessionStatus;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  last_activity: string | null;
  total_runs: number;
  total_artifacts: number;
  total_features: number;
  total_stories: number;
  total_story_points: number;
  context_snapshot: Record<string, unknown> | null;
  mate_types: string[] | null;
}

export interface SessionListResponse {
  sessions: SessionItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface CreateSessionBody {
  project_id: number;
  session_name: string;
  topic?: string;
  description?: string;
}

export interface UpdateSessionBody {
  session_name?: string;
  status?: SessionStatus;
  description?: string;
}

const SESSIONS_API = `${BASE}/api/v1/sessions`;

export async function listSessions(
  projectId: number,
  opts: { status?: SessionStatus; page?: number; page_size?: number; mate_type?: string } = {},
): Promise<SessionListResponse> {
  const p = new URLSearchParams({ project_id: String(projectId) });
  if (opts.status)    p.set("status", opts.status);
  if (opts.page)      p.set("page", String(opts.page));
  if (opts.page_size) p.set("page_size", String(opts.page_size));
  if (opts.mate_type) p.set("mate_type", opts.mate_type);
  const res = await authFetch(`${SESSIONS_API}?${p}`);
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export async function getSession(sessionId: number): Promise<SessionItem> {
  const res = await authFetch(`${SESSIONS_API}/${sessionId}`);
  if (!res.ok) throw new Error(`Session ${sessionId} not found`);
  return res.json();
}

export async function createSession(body: CreateSessionBody): Promise<SessionItem> {
  const res = await authFetch(SESSIONS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to create session");
  }
  return res.json();
}

export async function updateSession(sessionId: number, body: UpdateSessionBody): Promise<SessionItem> {
  const res = await authFetch(`${SESSIONS_API}/${sessionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to update session");
  }
  return res.json();
}

export async function deleteSession(sessionId: number): Promise<void> {
  const res = await authFetch(`${SESSIONS_API}/${sessionId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete session");
}

// ── Project (lean read for publish-gate check) ────────────────────────────

export interface ProjectIntegrationConfig {
  id: number;
  name: string;
  atlassian_config?: {
    jira_url?: string;
    project_key?: string;
    email?: string;
  } | null;
  azure_devops_config?: {
    org_url?: string;
    project?: string;
  } | null;
}

export async function getProjectById(projectId: number): Promise<ProjectIntegrationConfig> {
  const res = await authFetch(`${API}/projects/${projectId}`);
  if (!res.ok) throw new Error(`Project ${projectId} not found`);
  return res.json();
}

// ── Publish ───────────────────────────────────────────────────────────────

export interface PublishResultItem {
  type: "epic" | "feature" | "story";
  content_id: string;
  title: string;
  db_id?: number;
  /** Canonical hyperlink — populated for both Jira and ADO */
  external_url?: string;
  // Jira
  jira_key?: string;
  // ADO
  ado_id?: number;
  ado_url?: string;
}

export interface PublishResult {
  target: "jira" | "ado";
  published: PublishResultItem[];
  errors: string[];
  message: string;
  counts: { epics: number; features: number; stories: number };
}

export async function publishJob(jobId: string, options?: { projectKey?: string }): Promise<PublishResult> {
  const res = await authFetch(`${API}/pipeline/jobs/${jobId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_key: options?.projectKey ?? "" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Publish failed");
  }
  return res.json();
}

// ── Publish status ────────────────────────────────────────────────────────

export interface PublishStatus {
  /** Total approved artifacts for this job */
  approved: number;
  /** Approved items not yet published */
  unpublished: number;
  /** Approved items already published */
  published: number;
}

export async function getPublishStatus(jobId: string): Promise<PublishStatus> {
  try {
    const res = await authFetch(`${API}/pipeline/jobs/${jobId}/publish-status`);
    if (!res.ok) return { approved: 0, unpublished: 0, published: 0 };
    return res.json();
  } catch {
    return { approved: 0, unpublished: 0, published: 0 };
  }
}
