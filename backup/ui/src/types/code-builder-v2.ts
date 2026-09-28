// ═══════════════════════════════════════════════════════════════════════════
// TypeScript types for the Code Builder V2 (VS Code replica)
// ═══════════════════════════════════════════════════════════════════════════

// ── File Tree ────────────────────────────────────────────────────────────

export interface CBv2FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  children?: CBv2FileNode[];
}

export interface CBv2FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
}

// ── Open Tabs ────────────────────────────────────────────────────────────

export interface CBv2Tab {
  path: string;
  name: string;
  language: string;
  content: string;
  isDirty?: boolean;
  originalContent?: string;
  fileAction?: string;
}

// ── Chat Messages ────────────────────────────────────────────────────────

export type CBv2ChatRole = "user" | "assistant" | "system";

export interface CBv2ChatMessage {
  id: string;
  role: CBv2ChatRole;
  content: string;
  timestamp: number;
  eventType?: string;
  data?: Record<string, unknown>;
}

// ── Pipeline Events (from WebSocket) ─────────────────────────────────────

export interface CBv2PipelineEvent {
  type: string;
  ts?: number;
  [key: string]: unknown;
}

// ── Generation Status ────────────────────────────────────────────────────

export type CBv2GenerationStatus = "idle" | "connecting" | "running" | "complete" | "error";

// ── Pipeline Types ───────────────────────────────────────────────────────

export type CBv2PipelineType = "greenfield" | "brownfield" | "legacy_modernization" | "legacy_modernization_codegen";

export type CBv2DocumentType = "hld" | "lld" | "srs" | "ddd" | "api_spec" | "test_plan";

// ── Chat Context (what the user selects before chatting) ─────────────────

export interface CBv2ChatContext {
  project_id: number | null;
  project_name: string;
  pipeline_type: CBv2PipelineType;
  selected_story_ids: number[];
  selected_stories: CBv2Artifact[];       // full artifact objects for selected stories
  selected_document_ids: number[];
  selected_documents: CBv2Artifact[];
  selected_doc_types: CBv2DocumentType[];
  previous_output_dir?: string;           // follow-up: reuse previous generation output
  session_id?: number | null;             // existing session to continue (null = new session)
  new_session_name?: string;              // custom name for new session
}

// ── Artifact (from artifacts table) ──────────────────────────────────────

export interface CBv2Artifact {
  id: number;
  project_id?: number;
  artifact_type: string;
  artifact_id?: string;
  /** Parent artifact (DB id) — feature → epic, story → feature. */
  parent_artifact_id?: number | null;
  title: string;
  description?: string;
  content?: Record<string, unknown>;
  version?: number;
  created_at?: string;
  /** Approval state on the artifact itself (e.g. "draft", "approved"). */
  approval_status?: string | null;
  /** Star flag inherited from the source generation_run (Jobs dashboard). */
  run_is_selected?: boolean;
  /** Review flag inherited from the source generation_run (Jobs dashboard). */
  run_review_flag?: boolean;
}

export interface CBv2ContextWindowPreview {
  model_name?: string | null;
  context_window_tokens: number | null;
  reserved_output_tokens: number | null;
  input_budget_tokens: number | null;
  safety_margin_tokens?: number | null;
  budget_source?: string | null;
  estimated_input_tokens: number;
  final_input_tokens: number;
  prompt_tokens: number;
  story_tokens: number;
  document_tokens: number;
  smart_context_tokens: number;
  would_compact: boolean;
  compacted_story_count: number;
  compacted_document_count: number;
  omitted_story_count: number;
  omitted_document_count: number;
  smart_context_compacted: boolean;
  notes?: string[];
}

// ── Project Config (mirrors cb_pipeline_configs — simplified) ────────────
// NOTE: cb_pipeline_configs table was removed; config is now ad-hoc per run.
// This type is kept for backward compatibility but is no longer backed by a table.

export interface CBv2PipelineConfig {
  id: number;
  name: string;
  project_id?: number;
  pipeline_type: CBv2PipelineType;
  document_types: CBv2DocumentType[];
  tech_stack: Record<string, string>;
  settings: Record<string, unknown>;
  story_artifact_ids: number[];
  created_by?: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// ── Generation Session (from generation_sessions table) ──────────────────

export interface CBv2Session {
  id: number;
  session_name: string;
  topic?: string;
  description?: string;
  status: string;
  total_runs: number;
  started_at: string;
  last_activity?: string;
  completed_at?: string;
  project_id: number;
}

// ── Pipeline Run (from generation_runs, mate_type = 'CodeMate') ──────────────────────

export interface CBv2PipelineRun {
  id: number;
  run_id: string;
  config_id?: number;
  project_id?: number;
  pipeline_type: CBv2PipelineType;
  prompt_description: string;
  project_name: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  current_phase?: string;
  total_phases: number;
  completed_phases: number;
  started_at: string;
  completed_at?: string;
  duration_seconds?: number;
  output_dir?: string;
  workspace_root?: string;
  target_stack?: string;
  zip_path?: string;
  zip_size_bytes?: number;
  files_planned: number;
  files_generated: number;
  files_on_disk: number;
  total_size_bytes: number;
  error_count: number;
  error_message?: string;
  summary: Record<string, unknown>;
  created_by?: number;
  created_at: string;
}

// ── Generated File (compact manifest entry from cb_run_summary) ──────────

export interface CBv2GeneratedFile {
  path: string;
  lang: string;
  size: number;
}

// ── Story Selection (user stories to feed into code gen) ─────────────────

export interface CBv2StorySelection {
  artifact_id: number;
  artifact_type: string;
  artifact_title: string;
  selected: boolean;
}

// ── Project (simplified from existing projects table) ────────────────────

export interface CBv2Project {
  id: number;
  name: string;
  description?: string;
  created_at: string;
  archived: boolean;
  has_code_context?: boolean;
  has_doc_context?: boolean;
  has_figma_context?: boolean;
}

// ── Active Panel in Activity Bar ─────────────────────────────────────────

export type CBv2ActivePanel = "history" | "explorer" | "search" | "git" | "debug" | "extensions" | "runs";

// ── StoryMate Artifacts (mirroring backend api_models.py) ─────────────────

export interface StoryItem {
  story_id: string;
  title: string;
  description?: string;
  story_points?: number;
  epic_id?: string;
  feature_id?: string;
  feature_name?: string;
  business_rules: string[];
  acceptance_criteria: string[];
  technical_changes: string[];
  implementation_notes?: string;
  code_references: any[];
  relationships?: { [key: string]: any }; // Assuming relationships can be dynamic
  standards_validation?: { [key: string]: any };
  citation_metadata?: { [key: string]: any };
  extra_fields?: { [key: string]: any };
}

export interface FeatureItem {
  feature_id: string;
  feature_name: string;
  feature_description?: string;
  stories: StoryItem[];
}

export interface EpicItem {
  epic_id: string;
  epic_name: string;
  epic_goal?: string;
  features: FeatureItem[];
  stories: StoryItem[];
}

// ── Code Execution Types ─────────────────────────────────────────────────

export type CBv2ExecutionStatus =
  | "idle"
  | "connecting"
  | "detecting"
  | "running"
  | "healing"
  | "success"
  | "failed";

export interface CBv2ExecStep {
  phase: string;
  label: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed";
  exitCode?: number;
}

export interface CBv2ExecLine {
  id: number;
  type: "command" | "stdout" | "stderr" | "info" | "success" | "error" | "separator" | "heal";
  text: string;
  phase?: string;
  timestamp: number;
}

export interface CBv2ExecEvent {
  type: string;
  [key: string]: unknown;
}

/* Progress & ETA tracking for the execution pipeline */
export interface CBv2ExecProgress {
  totalAttempts: number;
  avgAttemptSeconds: number;
  initialErrors: number;
  currentErrors: number;
  errorsFixed: number;
  fixRate: number;
  estimatedRemainingAttempts: number;
  estimatedRemainingSeconds: number;
  isMakingProgress: boolean;
  errorCategories: Record<string, number>;
  elapsedSeconds: number;
}

// ── Workspace Upload & Analysis Types ────────────────────────────────────

export type CBv2WorkflowType =
  | "greenfield"
  | "brownfield"
  | "hotfix"
  | "microservice"
  | "analysis_report"
  | "legacy_modernization";

export type CBv2ActionType =
  | "crud"
  | "add_feature"
  | "refactor"
  | "bug_fix"
  | "monolith_to_microservice"
  | "extract_feature"
  | "convert"
  | "optimize"
  | "test"
  | "general";

export type CBv2AnalysisStatus = "empty" | "pending" | "analyzing" | "ingesting" | "ready" | "failed";

/** Workspace source — backed by generation_runs (project_type='analysis') */
export interface CBv2WorkspaceSource {
  id: number;
  run_id: string;
  project_id: number;
  source_type: "file" | "folder" | "zip" | "git_pull";
  source_name: string;
  source_path: string;
  file_count: number;
  total_size: number;
  analysis_status: CBv2AnalysisStatus;
  analysis_summary?: Record<string, unknown>;
  started_at?: string;
  completed_at?: string;
}

export interface CBv2WorkspaceAnalysisStatus {
  status: CBv2AnalysisStatus;
  total: number;
  ready: number;
  in_progress: number;
  pending: number;
  failed: number;
  progress_detail?: string;
}
