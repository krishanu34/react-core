// ─────────────────────────────────────────────────────────────────────────────
// API client for the Design Document Generator endpoints (/api/v1/documents)
// ─────────────────────────────────────────────────────────────────────────────

import { authFetch, getToken } from "./auth";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const DOC_API = `${BASE}/api/v1/documents`;

// ── Enums ─────────────────────────────────────────────────────────────────

export type DocQualityLevel = "fast" | "standard" | "high";
export type DocumentType = "hld" | "lld" | "req" | "cust";
export type DocumentOperationMode = "generate" | "update";
export type DocumentUpdateMode = "select_existing" | "upload_document";
export type ArchitectureMode = "monolithic" | "layered" | "microservices" | "serverless" | "auto";
export type DocStandardsType = "tmforum-etom" | "tmforum-sid";
export type DocJobStatus = "pending" | "running" | "completed" | "updated" | "failed" | "cancelled";
export type SupplementIntent = "additive_requirement" | "corrective_update" | "clarification" | "deprecation_removal" | "compliance_alignment" | "other";

// ── Request ───────────────────────────────────────────────────────────────

export interface DocumentGenerationRequest {
  operation_mode?: DocumentOperationMode;
  update_mode?: DocumentUpdateMode;
  document_type?: DocumentType;
  quality?: DocQualityLevel;
  project_id: number;
  architecture_mode?: ArchitectureMode;
  technology_stack?: Record<string, string>;
  use_code_context?: boolean;
  use_project_context?: boolean;
  use_figma?: boolean;
  use_document_context?: boolean;
  use_user_story_context?: boolean;
  use_standards?: boolean;
  standards_types?: DocStandardsType[];
  feature_ids?: number[];
  custom_instructions?: Record<string, unknown>;
  /** Custom document title (used by requirements docs) */
  document_name?: string;
  /** Plain-text content from an uploaded source document */
  uploaded_file_content?: string;
  uploaded_source_file_id?: number;
  uploaded_target_file_id?: number;
  uploaded_target_file_content?: string;
  supplements?: UpdateSupplementInput[];
  impact_analysis_token?: string;
  impact_analysis_hash?: string;
  approved_impact_analysis_override?: Record<string, unknown>;
  requirement_inventory_token?: string;
  requirement_inventory_hash?: string;
  approved_requirement_inventory?: Record<string, unknown>;
  requirement_inventory_feedback?: string;
  target_document_job_id?: string;
  target_document_title?: string;
  /** Prompt-ready summaries derived from embedded visuals in the uploaded source document */
  uploaded_visual_context?: string;
  /** Structured image analysis results returned during upload */
  uploaded_image_summaries?: UploadedImageSummary[];
  /** Upload-time image analysis status */
  image_context_status?: string;
  /** Durable storage metadata for the uploaded source document */
  uploaded_file_storage?: StoredFileMetadata;
  /** List of approved user-story artifact IDs from starred Story Builder runs */
  story_ids?: number[];
  /** Free-form prompt for Custom Document generation (mandatory for CUST) */
  user_prompt?: string;
  /** Focus area for Custom Document: database_design, api_design, ui_design, architecture_design, other */
  document_type_focus?: string;
  /** Free-text document type label when document_type_focus is 'other' */
  custom_document_type?: string;
}

export interface UpdateSupplementInput {
  context_file_id: number;
  file_name?: string;
  content?: string;
}

export interface ImpactedSectionPreview {
  section_id: string;
  title: string;
  reason: string;
  planned_change: string;
  confidence: number;
  matched_refs: string[];
  citation_previews: ImpactCitationPreview[];
  citation_metadata?: Record<string, DocCitationEntry> | null;
}

export interface ImpactCitationPreview {
  ref: string;
  label: string;
  excerpt: string;
  source_file_name?: string | null;
  source_file_id?: number | null;
  chunk_index?: number | null;
  full_text?: string | null;
}

export interface LinkedSourceSummary {
  context_file_id: number;
  file_name: string;
  relation_type?: string | null;
  version_number?: number | null;
  uploaded_at?: string | null;
  preview_text?: string | null;
}

export interface SupplementImpactAnalysis {
  context_file_id: number;
  file_name: string;
  suggested_intent: SupplementIntent;
  user_intent: SupplementIntent;
  suggested_intent_rationale: string;
  diff_summary: string;
  impact_summary: string;
  planned_change_summary: string;
  confidence: number;
  matched_prior_source: LinkedSourceSummary | null;
  affected_sections: ImpactedSectionPreview[];
}

export interface BaselineSourceDocumentSummary {
  context_file_id?: number | null;
  file_name: string;
  relation_type?: string | null;
  version_number?: number | null;
  uploaded_at?: string | null;
  availability_note?: string | null;
  preview_text?: string | null;
}

export interface UpdateSourceDiffItem {
  summary?: string;
  new_refs?: string[];
  old_refs?: string[];
  excerpt?: string;
  label?: string;
  ref?: string;
  source?: string;
}

export interface UpdateSourceDiffAnalysis {
  relationship: string;
  confidence: number;
  summary: string;
  additions: UpdateSourceDiffItem[];
  modifications: UpdateSourceDiffItem[];
  removals: UpdateSourceDiffItem[];
  unchanged_themes: string[];
  conflicts_or_ambiguities: string[];
  evidence: UpdateSourceDiffItem[];
}

export interface UpdateConflictEvidenceRef {
  ref: string;
  source: string;
  label: string;
  excerpt: string;
  source_file_name?: string | null;
  source_file_id?: number | null;
}

export interface UpdateConflictMitigationOption {
  id: string;
  label: string;
  description: string;
  source_priority: string[];
  apply_to_sections: string[];
}

export interface UpdateConflict {
  id: string;
  type: string;
  severity: string;
  topic: string;
  description: string;
  affected_sections: string[];
  evidence_refs: UpdateConflictEvidenceRef[];
  mitigation_options: UpdateConflictMitigationOption[];
  recommended_resolution: string;
  requires_reviewer_decision: boolean;
}

export interface UpdateConflictAnalysis {
  summary: string;
  conflicts: UpdateConflict[];
  unresolved_conflict_count: number;
  requires_conflict_review: boolean;
}

export interface UpdateRequirementInventoryItem {
  id: string;
  change_type: string;
  type: string;
  priority: string;
  summary: string;
  text: string;
  source_refs: string[];
  prior_source_refs: string[];
  target_section_refs: string[];
  rationale: string;
}

export interface UpdateRequirementInventory {
  requirements: UpdateRequirementInventoryItem[];
  source_chunks: Array<Record<string, unknown>>;
  prior_source_chunks: Array<Record<string, unknown>>;
  coverage_policy: string;
  allowed_terms: string[];
}

export interface ContextEvidenceItem {
  ref: string;
  type: string;
  artifact_type?: string;
  title: string;
  preview: string;
  description?: string;
  full_text?: string;
  feature_name?: string;
  source_file_id?: number | null;
  score?: number | null;
  story_points?: number | null;
  acceptance_criteria?: string[];
  business_rules?: string[];
  [key: string]: unknown;
}

export interface ContextEvidenceGroup {
  key: string;
  label: string;
  count?: number | null;
  details?: string;
  items: ContextEvidenceItem[];
}

export interface UpdateGenerationPlan {
  plan_summary: string;
  usage_notes: string[];
  reviewer_edited_plan?: string;
  context_sources?: ContextSourcePlanItem[];
  context_source_strategy?: string[];
  context_evidence_groups?: ContextEvidenceGroup[];
  document_change_strategy: string;
  preservation_strategy: string;
  section_strategy: Array<Record<string, unknown>>;
  requirement_application: Array<Record<string, unknown>>;
  traceability_strategy: string;
  assumptions: string[];
  risks: string[];
  out_of_scope: string[];
  review_actions: string[];
}

export interface UpdateImpactAnalysisRequest {
  project_id: number;
  update_mode: DocumentUpdateMode;
  document_type?: DocumentType;
  quality?: DocQualityLevel;
  target_document_job_id?: string;
  target_document_title?: string;
  uploaded_target_file_id?: number;
  uploaded_target_file_content?: string;
  use_code_context?: boolean;
  use_project_context?: boolean;
  use_figma?: boolean;
  use_document_context?: boolean;
  use_user_story_context?: boolean;
  story_ids?: number[];
  use_standards?: boolean;
  standards_types?: DocStandardsType[];
  custom_instructions?: Record<string, unknown>;
  analysis_instructions?: string;
  supplements: UpdateSupplementInput[];
}

export interface UpdateImpactAnalysisResponse {
  analysis_token: string;
  analysis_hash: string;
  expires_at: string;
  project_id: number;
  update_mode: DocumentUpdateMode;
  target_document_job_id?: string | null;
  target_document_title: string;
  current_version?: number | null;
  overall_summary: string;
  overall_planned_change: string;
  overall_affected_sections: ImpactedSectionPreview[];
  supplement_analyses: SupplementImpactAnalysis[];
  baseline_source_documents: BaselineSourceDocumentSummary[];
  source_diff_analysis?: UpdateSourceDiffAnalysis | null;
  update_requirement_inventory?: UpdateRequirementInventory | null;
  update_generation_plan?: UpdateGenerationPlan | null;
  conflict_analysis?: UpdateConflictAnalysis | null;
  unresolved_conflict_count?: number;
  requires_conflict_review?: boolean;
}

// ── Response types ────────────────────────────────────────────────────────

export interface DocJobSubmittedResponse {
  job_id: string;
  status: DocJobStatus;
  message: string;
  submitted_at: string;
  poll_url: string;
  result_url: string;
}

export interface DocStageProgress {
  current_stage: string | null;
  completed_stages: number;
  total_stages: number;
  percent: number;
}

export interface DocJobStatusResponse {
  job_id: string;
  status: DocJobStatus;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  progress: DocStageProgress | null;
  error: string | null;
  request_options: Record<string, unknown> | null;
}

export interface DocumentSection {
  section_id: string;
  title: string;
  content: string;
  order: number;
  traceability_links: string[];
  confidence_score: number | null;
  citation_metadata?: Record<string, DocCitationEntry> | null;
}

export interface DocValidationResult {
  completeness_score: number;
  consistency_score: number;
  grounding_score: number;
  overall_quality_score: number;
  standards_compliance: Record<string, number> | null;
  issues: string[];
}

export interface DocExecutionSummary {
  total_duration: number;
  stages_executed: number;
  stages_skipped: number;
  stages_failed: number;
  total_tokens_used?: number | null;
  estimated_cost_usd?: number | null;
}

export interface StoredFileMetadata {
  filename: string;
  file_size_bytes: number;
  file_type: string;
  uploaded_at: string;
  local_path: string | null;
  blob_path: string | null;
  blob_url: string | null;
  storage_mode: string;
}

export interface UploadedImageSummary {
  image_path: string;
  is_relevant?: boolean;
  image_type?: string | null;
  overview?: string | null;
  detailed_explanation?: string | null;
  error?: string | null;
}

export interface StoredArtifacts {
  source_document?: StoredFileMetadata | null;
  markdown?: StoredFileMetadata | null;
  raw_pipeline_output?: StoredFileMetadata | null;
  exports: Record<string, StoredFileMetadata>;
}

export interface DocOutputFiles {
  markdown: string;
  raw_pipeline_output: string;
}

export interface DocumentResultResponse {
  job_id: string;
  status: DocJobStatus;
  submitted_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  request_options: Record<string, unknown>;
  document_type: string;
  document_title: string;
  total_sections: number;
  sections: DocumentSection[];
  full_markdown: string | null;
  validation: DocValidationResult | null;
  execution_summary: DocExecutionSummary | null;
  output_files: DocOutputFiles;
  version_documents: DocumentVersionFile[];
  stored_artifacts?: StoredArtifacts | null;
}

export interface ProjectDocumentListItem {
  job_id: string;
  document_type: string;
  document_title: string;
  latest_version: number;
  updated_at: string | null;
  artifact_id: number | null;
}

export interface ProjectDocumentListResponse {
  project_id: number;
  total: number;
  documents: ProjectDocumentListItem[];
}

export interface DocJobListItem {
  job_id: string;
  status: DocJobStatus;
  submitted_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  document_type: string | null;
  project_id: number | null;
  quality: string | null;
  request_options: Record<string, unknown> | null;
  version_count: number | null;
}

export interface DocHealthResponse {
  status: string;
  version: string;
  pipeline: string;
  db: string;
  llm: string;
}

// ── API functions ─────────────────────────────────────────────────────────

export async function submitDocumentGeneration(
  body: DocumentGenerationRequest,
): Promise<DocJobSubmittedResponse> {
  const res = await authFetch(DOC_API + "/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to submit document generation");
  }
  return res.json();
}

export async function getDocumentJobStatus(jobId: string): Promise<DocJobStatusResponse> {
  // Use raw fetch (not authFetch) so a transient 401 during background
  // polling does NOT trigger a global redirect-to-login.  The caller
  // (DocumentProgress) handles failures via its own retry counter.
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${DOC_API}/jobs/${jobId}/status`, { headers });
  if (!res.ok) throw new Error(`Document job ${jobId} not found`);
  return res.json();
}

export async function listDocumentJobs(): Promise<DocJobListItem[]> {
  const res = await authFetch(`${DOC_API}/jobs`);
  if (!res.ok) throw new Error("Failed to fetch document jobs");
  return res.json();
}

export async function getDocumentJobResult(jobId: string): Promise<DocumentResultResponse> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/result`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Failed to fetch document result (${res.status})`);
  }
  return res.json();
}

export async function deleteDocumentJob(jobId: string): Promise<void> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Failed to delete document job ${jobId}`);
  }
}

export async function cancelDocumentJob(jobId: string): Promise<{ status: string; message: string }> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/cancel`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Failed to cancel job ${jobId}`);
  }
  return res.json();
}

/** Server-side branded export (DOCX or PDF with header/footer assets). */
export async function exportDocumentJob(
  jobId: string,
  format: "docx" | "pdf",
  version?: number,
): Promise<void> {
  let exportUrl = `${DOC_API}/jobs/${jobId}/export?format=${format}`;
  if (version != null && version > 0) exportUrl += `&version=${version}`;
  const res = await authFetch(exportUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? `design-doc-${jobId.slice(0, 8)}.${format}`;

  // Trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export async function exportImpactAnalysisPlan(
  analysisToken: string,
  analysisHash: string,
  format: "pdf" = "pdf",
): Promise<void> {
  const res = await authFetch(
    `${DOC_API}/impact-analysis/${analysisToken}/export?format=${format}&hash=${encodeURIComponent(analysisHash)}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Impact-plan export failed (${res.status})`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|\")?([^";]+)/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/\"/g, "")) : `impact-plan-${analysisToken.slice(0, 8)}.${format}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export async function downloadDocumentFile(
  contextFileId: number,
  versionNumber?: number,
): Promise<void> {
  const downloadUrl = getDocumentFileDownloadUrl(contextFileId, versionNumber);
  const res = await authFetch(downloadUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to download document file");
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|\")?([^";]+)/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1].replace(/\"/g, "")) : `document-${contextFileId}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export async function getDocumentHealth(): Promise<DocHealthResponse> {
  const res = await fetch(`${DOC_API}/health`);
  if (!res.ok) throw new Error("Document health check failed");
  return res.json();
}

// ── File upload for requirements ──────────────────────────────────────────

export interface UploadedFileResponse {
  context_file_id: number;
  filename: string;
  file_type: string;
  file_path: string;
  content_length: number;
  content: string;
  preview_available: boolean;
  download_available: boolean;
  image_context_enabled?: boolean;
  image_context_status?: string;
  visual_context?: string | null;
  image_summaries?: UploadedImageSummary[];
  image_context_error?: string | null;
  storage?: StoredFileMetadata | null;
}

export interface UploadSourceDocumentParams {
  file: File;
  projectId?: number;
}

/**
 * Upload a source document (PDF, DOCX, TXT, MD) and extract its text.
 * The returned `content` string should be passed as `uploaded_file_content`
 * in the generation request.
 */
export async function uploadSourceDocument(
  params: UploadSourceDocumentParams,
): Promise<UploadedFileResponse> {
  const { file, projectId } = params;
  const formData = new FormData();
  formData.append("file", file);
  if (projectId != null && projectId > 0) {
    formData.append("project_id", String(projectId));
  }

  const res = await authFetch(`${DOC_API}/upload`, {
    method: "POST",
    body: formData,
    // Do NOT set Content-Type — the browser sets multipart boundary automatically
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to upload document");
  }
  return res.json();
}

export async function listProjectDocuments(
  projectId: number,
): Promise<ProjectDocumentListResponse> {
  const res = await authFetch(`${DOC_API}/projects/${projectId}/documents`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch project documents");
  }
  return res.json();
}

export interface RequirementInventoryItem {
  id: string;
  type?: string;
  summary?: string;
  source_ref?: string;
  source_label?: string;
  priority?: string;
  keywords?: string[];
  text?: string;
}

export interface ContextSourcePlanItem {
  key: string;
  label: string;
  selected?: boolean;
  count?: number | null;
  count_label?: string;
  details?: string;
}

export interface RequirementInventoryAnalysisRequest {
  project_id: number;
  document_type: DocumentType;
  document_name?: string;
  quality?: DocQualityLevel;
  architecture_mode?: ArchitectureMode;
  technology_stack?: Record<string, string>;
  use_code_context?: boolean;
  use_project_context?: boolean;
  use_figma?: boolean;
  use_document_context?: boolean;
  use_user_story_context?: boolean;
  use_standards?: boolean;
  standards_types?: DocStandardsType[];
  feature_ids?: number[];
  custom_instructions?: Record<string, unknown>;
  uploaded_file_content?: string;
  uploaded_source_file_id?: number;
  uploaded_visual_context?: string;
  uploaded_image_summaries?: UploadedImageSummary[];
  image_context_status?: string;
  uploaded_file_storage?: StoredFileMetadata;
  story_ids?: number[];
  user_prompt?: string;
  document_type_focus?: string;
  custom_document_type?: string;
}

export interface RequirementInventoryAnalysisResponse {
  inventory_token: string;
  inventory_hash: string;
  expires_at: string;
  project_id: number;
  document_type: DocumentType;
  document_name?: string | null;
  requirement_inventory: {
    requirements?: RequirementInventoryItem[];
    source_chunks?: Array<{ ref?: string; label?: string; text?: string }>;
    coverage_policy?: string;
    allowed_terms?: string[];
    [key: string]: unknown;
  };
  generation_plan: {
    total_requirements?: number;
    total_source_chunks?: number;
    type_counts?: Record<string, number>;
    priority_counts?: Record<string, number>;
    coverage_policy?: string;
    usage_notes?: string[];
    context_sources?: ContextSourcePlanItem[];
    context_source_strategy?: string[];
    context_evidence_groups?: ContextEvidenceGroup[];
    review_actions?: string[];
    [key: string]: unknown;
  };
  summary: string;
}

export async function analyzeDocumentUpdateImpact(
  body: UpdateImpactAnalysisRequest,
): Promise<UpdateImpactAnalysisResponse> {
  const res = await authFetch(`${DOC_API}/analyze-update-impact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to analyze document update impact");
  }
  return res.json();
}

export async function analyzeRequirementInventory(
  body: RequirementInventoryAnalysisRequest,
): Promise<RequirementInventoryAnalysisResponse> {
  const res = await authFetch(`${DOC_API}/analyze-requirements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to analyze requirements");
  }
  return res.json();
}

// ── Approved stories from starred Story Builder runs ─────────────────────

export interface ApprovedStory {
  id: number;
  artifact_id: string | null;
  story_id?: string | null;
  title: string;
  description: string;
  acceptance_criteria: string[];
  approved_at: string | null;
  session_id: number | null;
  session_name?: string | null;
  job_id?: string | null;
  generation_run_id?: number | null;
  is_starred?: boolean;
}

export interface ApprovedStorySession {
  session_id: number;
  session_name: string;
  approved_story_count: number;
  starred_jobs: Array<{
    job_id: string;
    generation_run_id?: number | null;
    is_starred?: boolean;
  }>;
  stories: ApprovedStory[];
}

/**
 * Fetch approved user stories from starred Story Builder runs for the given project.
 */
export async function fetchApprovedStories(
  projectId: number,
): Promise<ApprovedStory[]> {
  const res = await authFetch(`${DOC_API}/stories?project_id=${projectId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch approved stories");
  }
  return res.json();
}

/**
 * Fetch starred Story Builder sessions with approved user stories for a project.
 */
export async function fetchApprovedStorySessions(
  projectId: number,
): Promise<ApprovedStorySession[]> {
  const res = await authFetch(`${DOC_API}/story-sessions?project_id=${projectId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch approved story sessions");
  }
  return res.json();
}

// ── DB-backed document job listing ────────────────────────────────────────
// Queries the USG pipeline /jobs endpoint with source=pipeline_api_integrated
// to fetch document generation runs persisted in the generation_runs table.

/** Shape returned by /api/v1/pipeline/jobs for document jobs */
export interface DbDocumentJobItem {
  job_id: string;
  status: DocJobStatus;
  submitted_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  requirement_file: string | null;
  total_stories: number;
  quality: string | null;
  request_options: Record<string, unknown> | null;
  project_id: number | null;
  session_id: number | null;
  session_name: string | null;
  version_count: number | null;
  is_selected?: boolean;
  review_flag?: boolean;
}

const PIPELINE_API = `${BASE}/api/v1/pipeline`;

export async function listDocumentJobsFromDB(
  projectId?: number,
): Promise<DbDocumentJobItem[]> {
  const params = new URLSearchParams({
    limit: "50",
    source: "pipeline_api_integrated",
  });
  if (projectId != null) params.set("project_id", String(projectId));
  const res = await authFetch(`${PIPELINE_API}/jobs?${params}`);
  if (!res.ok) throw new Error("Failed to fetch document jobs");
  return res.json();
}

export async function markDocumentJobFlags(
  jobId: string,
  flags: { is_selected?: boolean; review_flag?: boolean },
): Promise<DbDocumentJobItem> {
  const res = await authFetch(`${PIPELINE_API}/jobs/${jobId}/flags`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Failed to update document job flags for ${jobId}`);
  }
  return res.json();
}

export async function deleteDocumentJobFromDB(jobId: string): Promise<void> {
  const [docRes, pipelineRes] = await Promise.all([
    authFetch(`${DOC_API}/jobs/${jobId}`, { method: "DELETE" }),
    authFetch(`${PIPELINE_API}/jobs/${jobId}`, { method: "DELETE" }),
  ]);

  const docOk = docRes.ok || docRes.status === 404;
  const pipelineOk = pipelineRes.ok || pipelineRes.status === 404;

  if (docOk && pipelineOk) return;

  const docErr = !docOk ? await docRes.json().catch(() => ({ detail: docRes.statusText })) : null;
  const pipelineErr = !pipelineOk ? await pipelineRes.json().catch(() => ({ detail: pipelineRes.statusText })) : null;
  throw new Error(
    docErr?.detail
      ?? pipelineErr?.detail
      ?? `Failed to delete document job ${jobId}`,
  );
}

// ── Stage labels (mirroring backend _STAGE_LABELS) ────────────────────────

export const STAGE_LABELS: Record<string, string> = {
  stage_1_context_aggregation: "Context Aggregation",
  stage_2_spec_loading: "Specification Loading",
  stage_3_architecture_synthesis: "Architecture Synthesis",
  stage_4_section_generation: "Section Generation",
  stage_5_validation: "Validation",
  stage_6_standards_compliance: "Standards Compliance",
  stage_7_refinement: "Refinement",
  stage_8_publishing: "Publishing",
};

// ── Publish to Azure DevOps ────────────────────────────────────────────────

export interface DocPublishResult {
  target: "ado";
  external_id: string;
  external_url: string;
  message: string;
}

export interface DocPublishStatus {
  published: boolean;
  external_id: string | null;
  external_url: string | null;
  published_at: string | null;
}

export async function publishDocumentJob(jobId: string): Promise<DocPublishResult> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Publish failed");
  }
  return res.json();
}

export async function getDocumentPublishStatus(jobId: string): Promise<DocPublishStatus> {
  try {
    const res = await authFetch(`${DOC_API}/jobs/${jobId}/publish-status`);
    if (!res.ok) return { published: false, external_id: null, external_url: null, published_at: null };
    return res.json();
  } catch {
    return { published: false, external_id: null, external_url: null, published_at: null };
  }
}

// ── Document Regeneration System — Types ──────────────────────────────────

export type CommentStatus = "pending" | "addressed" | "dismissed";
export type CommentType = "section" | "general" | "highlight";
export type VersionStatus = "pending" | "current" | "superseded" | "approved" | "rejected";

export interface CommentItem {
  section_id?: string | null;
  comment_text: string;
  comment_type: CommentType;
  highlighted_text?: string | null;
  selection_range?: { startOffset: number; endOffset: number } | null;
}

export interface CommentResponse {
  id: number;
  job_id: string;
  section_id: string | null;
  comment_text: string;
  comment_type: string;
  user_id: number | null;
  status: CommentStatus;
  version_number: number;
  highlighted_text: string | null;
  selection_range: { startOffset: number; endOffset: number } | null;
  created_at: string | null;
  resolved_at: string | null;
}

export interface CommentListResponse {
  job_id: string;
  total: number;
  comments: CommentResponse[];
}

export interface RegenerateRequest {
  comment_ids?: number[] | null;
  section_ids?: string[] | null;
  quality?: string | null;
}

export interface RegenerateResponse {
  job_id: string;
  new_version: number;
  status: string;
  message: string;
  sections_to_regenerate: string[];
  comments_being_addressed: number[];
}

export interface VersionSummary {
  id: number;
  version_number: number;
  trigger_type: string;
  status: VersionStatus;
  sections_changed: string[];
  comments_addressed: number[];
  created_at: string | null;
  approved_at: string | null;
  approved_by: number | null;
  rejection_reason: string | null;
}

export interface VersionListResponse {
  job_id: string;
  total: number;
  current_version: number;
  versions: VersionSummary[];
}

export interface VersionDetailResponse extends VersionSummary {
  job_id: string;
  sections: DocumentSection[];
  full_markdown: string | null;
  validation: DocValidationResult | null;
  linked_documents: DocumentVersionFile[];
}

export interface DocumentVersionFile {
  id: number;
  context_file_id: number;
  version_number: number;
  relation_type: string;
  file_name: string;
  file_path: string | null;
  uploaded_at: string | null;
  preview_available: boolean;
  download_available: boolean;
  preview_text: string | null;
  metadata: Record<string, unknown>;
}

export interface SectionDiff {
  section_id: string;
  title: string;
  changed: boolean;
  old_content: string | null;
  new_content: string | null;
}

export interface VersionDiffResponse {
  job_id: string;
  from_version: number;
  to_version: number;
  sections: SectionDiff[];
  comments_addressed: number[];
}

// ── Document Regeneration System — API Functions ──────────────────────────

export async function submitComments(
  jobId: string,
  comments: CommentItem[],
): Promise<CommentListResponse> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comments }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to submit comments");
  }
  return res.json();
}

export async function listComments(
  jobId: string,
  statusFilter?: CommentStatus,
  sectionId?: string,
): Promise<CommentListResponse> {
  const params = new URLSearchParams();
  if (statusFilter) params.set("status", statusFilter);
  if (sectionId) params.set("section_id", sectionId);
  const qs = params.toString() ? `?${params}` : "";
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/comments${qs}`);
  if (!res.ok) throw new Error("Failed to list comments");
  return res.json();
}

export async function deleteComment(jobId: string, commentId: number): Promise<void> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/comments/${commentId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete comment");
}

export async function triggerRegeneration(
  jobId: string,
  body: RegenerateRequest = {},
): Promise<RegenerateResponse> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to trigger regeneration");
  }
  return res.json();
}

/** Poll the regen-status endpoint to detect running / completed / failed. */
export async function getRegenStatus(
  jobId: string,
): Promise<{ status: "running" | "completed" | "failed" | "unknown"; error: string | null }> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/regen-status`);
  if (!res.ok) return { status: "unknown", error: null };
  return res.json();
}

export async function listVersions(jobId: string): Promise<VersionListResponse> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/versions`);
  if (!res.ok) throw new Error("Failed to list versions");
  return res.json();
}

export async function getVersionDetail(
  jobId: string,
  versionNumber: number,
): Promise<VersionDetailResponse> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/versions/${versionNumber}`);
  if (!res.ok) throw new Error(`Failed to get version ${versionNumber}`);
  return res.json();
}

export async function getVersionDiff(
  jobId: string,
  versionNumber: number,
  compareWith: number,
): Promise<VersionDiffResponse> {
  const res = await authFetch(
    `${DOC_API}/jobs/${jobId}/versions/${versionNumber}/diff?compare_with=${compareWith}`,
  );
  if (!res.ok) throw new Error("Failed to get version diff");
  return res.json();
}

export async function reviewVersion(
  jobId: string,
  versionNumber: number,
  action: "approve" | "reject",
  reason?: string,
): Promise<{ success: boolean }> {
  const res = await authFetch(
    `${DOC_API}/jobs/${jobId}/versions/${versionNumber}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, reason }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Failed to ${action} version`);
  }
  return res.json();
}

export async function getDocumentFilePreview(
  contextFileId: number,
): Promise<{ context_file_id: number; file_name: string; preview_text: string; uploaded_at: string | null }> {
  const res = await authFetch(`${DOC_API}/files/${contextFileId}/preview`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to load document preview");
  }
  return res.json();
}

export function getDocumentFileDownloadUrl(contextFileId: number, versionNumber?: number): string {
  if (versionNumber != null) {
    return `${DOC_API}/files/${contextFileId}/download?version_number=${versionNumber}`;
  }
  return `${DOC_API}/files/${contextFileId}/download`;
}

// ── Document Chat (AI Review Assistant) ───────────────────────────────────

export type ChatMessageRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  section_id?: string | null;
}

export interface ChatResponse {
  reply: string;
  section_id: string | null;
}

/**
 * Send a message to the document AI assistant.
 * Returns a context-aware response about the document's content, quality,
 * and suggestions for improvement.
 */
export async function sendChatMessage(
  jobId: string,
  body: ChatRequest,
): Promise<ChatResponse> {
  const res = await authFetch(`${DOC_API}/jobs/${jobId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Chat request failed");
  }
  return res.json();
}

// ── Traceability citation resolution ──────────────────────────────────────

export interface DocCitationEntry {
  type: "story" | "feature" | "requirement" | "business_rule" | "epic" | "test_case" | "nfr" | "document" | string;
  artifact_type: string;
  title: string;
  preview: string;
  description?: string;
  story_points?: number | null;
  acceptance_criteria?: string[];
  business_rules?: string[];
  feature_name?: string;
  story_count?: number;
  source_file_id?: number | null;
  file_name?: string;
  file_path?: string;
  language?: string | null;
  symbol?: string | null;
  start_line?: number | string | null;
  end_line?: number | string | null;
  source?: string | null;
  chunk_id?: string | number | null;
}

export interface ResolveCitationsResponse {
  citations: Record<string, DocCitationEntry>;
}

/**
 * Resolve traceability references (e.g. STORY-123, FEAT-456) to their
 * artifact details for hover preview in the document builder.
 */
export async function resolveDocumentCitations(
  projectId: number,
  refs: string[],
): Promise<ResolveCitationsResponse> {
  if (!refs.length) return { citations: {} };
  const res = await authFetch(`${DOC_API}/resolve-citations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, refs }),
  });
  if (!res.ok) return { citations: {} };
  return res.json();
}
