import type {
  CBv2ChatMessage,
  CBv2FileNode,
  CBv2GenerationStatus,
  CBv2PipelineEvent,
  CBv2Tab,
} from "@/types/code-builder-v2";

/** Extended tab type for Legacy Modernization with pin/diff support */
export interface LegacyTab extends CBv2Tab {
  isPinned?: boolean;
  /** When set, the editor shows a diff: diffOriginalContent (left) vs content (right) */
  diffOriginalContent?: string;
  diffOriginalLabel?: string;
  isProposalPreview?: boolean;
}

export interface LegacyModernizationDraft {
  projectId: number;
  targetStack: string;
  modernizationGoal: string;
}

export interface LegacyModernizationStartRequest {
  project_id: number;
  target_stack: string;
  modernization_goal?: string;
  workspace_root?: string;
  source_path?: string;
  source_kind?: string;
  source_url?: string;
  source_blob_url?: string;
  resume_from_run_id?: string;
}

export interface LegacyModernizationProject {
  project_id: number;
  project_name: string;
  legacy_modernization_model_configured?: boolean;
  legacy_modernization_model_id?: number | null;
  legacy_modernization_model_vendor?: string | null;
  legacy_modernization_model_name?: string | null;
  legacy_modernization_model_label?: string | null;
  legacy_modernization_model_active?: boolean | null;
  modernization_eligible?: boolean;
  modernization_validation_message?: string | null;
  git_repo_url?: string | null;
  [key: string]: unknown;
}

export interface LegacyModernizationProjectListResponse {
  projects: LegacyModernizationProject[];
}

export interface LegacyModernizationCodeContextStatus {
  stored: boolean;
  total_files?: number;
  total_chunks?: number;
  files: string[];
}

export interface LegacyModernizationSuggestions {
  project_id: number;
  detected_source: string;
  selected_target_stack?: string;
  target_stack_suggestions: string[];
  modernization_goal_suggestions: string[];
  error?: string;
}

export interface LegacyModernizationCodegenRequest {
  project_id?: number;
  workspace_root: string;
  target_stack: string;
  modernization_goal?: string;
  user_prompt?: string;
  resume_from_run_id?: string;
  confirmed: boolean;
}

export interface LegacyCodebaseChangeFile {
  path: string;
  reason?: string;
  language?: string;
  size?: number;
  originalContent?: string;
  content?: string;
  diffPreview?: string;
}

export interface LegacyCodebaseChangeProposal {
  proposalId: string;
  summary: string;
  impactPlan?: string[];
  suggestions: string[];
  changedFiles: LegacyCodebaseChangeFile[];
}

export interface LegacyModernizationAgentState {
  status: CBv2GenerationStatus;
  messages: CBv2ChatMessage[];
  fileTree: CBv2FileNode[];
  fileCount: number;
  currentPhase: string;
  generatingFiles: string[];
  completedFiles: string[];
  manifest: Array<{ path: string; description: string }>;
  summary: Record<string, unknown> | null;
  roadmap: string | null;
  roadmapManifestCount?: number;
  roadmapStatus: "idle" | "generating" | "ready" | "revising" | "approved" | "blocked";
  roadmapNotes: string | null;
  techstack: string | null;
  techstackStatus: "idle" | "generating" | "ready" | "revising" | "approved" | "blocked";
  techstackNotes: string | null;
  sourceStack: string | null;
  sourceStackStatus: "idle" | "generating" | "ready" | "revising" | "approved" | "blocked";
  sourceStackNotes: string | null;
  /** Current phase index and total phases for progress tracking */
  phaseProgress: { index: number; total: number };
  /** Phase-level elapsed times (seconds) keyed by phase name */
  phaseTimings: Record<string, number>;
  /** Timestamp (ms) when the pipeline started */
  pipelineStartTime: number | null;
  /** Metrics from the analysis/inventory scan */
  analysisMetrics: {
    totalFiles: number;
    sourceFiles: number;
    primaryLanguage: string;
    languageCounts: Record<string, number>;
    importantFilesCount: number;
    excludedFiles: number;
    analysisMode: string;
  } | null;
  /** Open questions extracted from reverse-engineering report */
  openQuestions: string[];
  openQuestionsSuggested: string[];
  openQuestionsStatus: "idle" | "pending" | "answered";
}

export interface LegacyModernizationAgent extends LegacyModernizationAgentState {
  startModernization: (request: LegacyModernizationStartRequest) => void;
  sendChat: (message: string) => Promise<string | null>;
  startCodeGeneration: (request: LegacyModernizationCodegenRequest) => void;
  generateSpecs: (
    workspaceRoot: string,
    specTypes: Array<"functional" | "technical">
  ) => Promise<Record<string, unknown> | null>;
  refreshFileTree: (workspaceRoot?: string) => Promise<void>;
  loadRunFromHistory: (run: {
    run_id?: string;
    workspace_root?: string;
    target_stack?: string;
    project_id?: number;
    prompt_description?: string;
    project_name?: string;
  }) => Promise<void>;
  fetchFileContent: (
    path: string
  ) => Promise<{ content: string; language: string } | null>;
  saveFile: (path: string, content: string) => Promise<boolean>;
  applyAIChange: (
    path: string,
    instruction: string,
    currentContent?: string,
    symbolName?: string,
    projectId?: number
  ) => Promise<{ content: string; language: string; summary?: string } | null>;
  applyChatCodebaseChange: (
    instruction: string,
    projectId?: number,
    history?: Array<{ role: string; content: string }>
  ) => Promise<LegacyCodebaseChangeProposal | null>;
  approveChatCodebaseChange: (
    proposalId: string,
    changedFiles: LegacyCodebaseChangeFile[]
  ) => Promise<boolean>;
  rejectChatCodebaseChange: (proposalId: string) => void;
  resetState: () => void;
  submitOpenQuestionAnswers: (answers: Record<string, string>, stage?: string) => Promise<void>;
  skipOpenQuestions: () => Promise<void>;
}

export type LegacyModernizationEvent = CBv2PipelineEvent;
