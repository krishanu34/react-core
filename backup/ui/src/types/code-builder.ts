/* ── File Tree ──────────────────────────────────────────── */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  language?: string;
  size?: number;
}

/* ── Pipeline ──────────────────────────────────────────── */
export type PipelineMode =
  | "greenfield"
  | "brownfield"
  | "hybrid"
  | "hotfix"
  | "migration"
  | "code_intel"
  | "microservice";

export const PIPELINE_LABELS: Record<PipelineMode, string> = {
  greenfield: "Greenfield",
  brownfield: "Brownfield",
  hybrid: "Hybrid",
  hotfix: "Hotfix",
  migration: "Migration",
  code_intel: "Code Intelligence",
  microservice: "Microservice",
};

export const PIPELINE_DESCRIPTIONS: Record<PipelineMode, string> = {
  greenfield: "Build a brand-new project from scratch with full scaffolding",
  brownfield: "Evolve an existing codebase with refactoring and improvements",
  hybrid: "Combine new development with legacy code modernization",
  hotfix: "Rapid bug diagnosis and targeted fix deployment",
  migration: "Migrate codebase across languages, frameworks, or platforms",
  code_intel: "Deep code analysis, metrics, and intelligence report",
  microservice: "Design and scaffold microservice architectures",
};

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PipelineStep {
  name: string;
  status: StepStatus;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  output?: string;
  error?: string;
}

export interface PipelineRun {
  run_id: string;
  mode: PipelineMode;
  status: "pending" | "running" | "completed" | "failed";
  steps: PipelineStep[];
  created_at: string;
  completed_at?: string;
  progress: number;           // 0-100
  output_dir?: string;
}

/* ── HITL (Human-in-the-Loop) Gates ────────────────────── */
export interface HitlGate {
  gate_id: string;
  type: string;
  label: string;
  detail: string;
  report_file?: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

/* ── Chat ──────────────────────────────────────────────── */
export type ChatRole = "user" | "assistant" | "system";

export interface ChatAttachment {
  type: "file" | "zip" | "text";
  name: string;
  size?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  attachment?: ChatAttachment;
}

/* ── Project ───────────────────────────────────────────── */
export interface ProjectInfo {
  project_id: string;
  name: string;
  mode: PipelineMode;
  description: string;
  created_at: string;
  status: string;
  run_id?: string;
}

/* ── Editor ────────────────────────────────────────────── */
export interface EditorTab {
  path: string;
  name: string;
  language: string;
  content: string;
  isDirty: boolean;
  source?: "project" | "output";
  runId?: string;
}

/* ── Pipeline History ───────────────────────────────────── */
export interface PipelineHistoryItem {
  sno: number;
  run_id: string;
  project_name: string;
  project_id?: string;
  mode: PipelineMode;
  status: string;
  created_at: string;
  completed_at?: string;
  duration_ms: number;
  output_dir?: string;
}

/* ── Diff / Report Viewer ──────────────────────────────── */
export interface FileDiff {
  file_path: string;
  old_content: string;
  new_content: string;
  language: string;
  change_type: "added" | "modified" | "deleted";
}

export interface ReportFile {
  path: string;
  content: string;
  language: string;
  size: number;
}

/* ── Visual Stage Data ─────────────────────────────────── */
export interface TerminalLog {
  command: string;
  output: string;
  exitCode: number;
  timestamp: string;
}

/* ── WebSocket messages ────────────────────────────────── */
export interface WsPipelineUpdate {
  type: "status" | "hitl_gate" | "pipeline_complete" | "pipeline_error";
  run_id: string;
  status?: string;
  steps?: PipelineStep[];
  progress?: number;
  output_dir?: string;
  duration_ms?: number;
  gate?: HitlGate;
  error?: string;
}

export interface WsChatChunk {
  type: "chunk" | "done" | "error" | "suggestions";
  content?: string;
  suggestions?: string[];
  error?: string;
}
