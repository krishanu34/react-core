// ═══════════════════════════════════════════════════════════════════════════
// TypeScript types for the Code Intelligence module
// ═══════════════════════════════════════════════════════════════════════════

// ── Graph Entities ───────────────────────────────────────────────────────

export interface CIEntityNode {
  uid: string;
  project: string;
  entity_type: string;
  name: string;
  package?: string;
  module?: string;
  file_path: string;
  start_line?: number;
  end_line?: number;
  signature?: string;
  summary: string;
  content_hash: string;
}

export interface CIModuleNode {
  uid: string;
  project: string;
  file_path: string;
  summary: string;
  content_hash: string;
}

export interface CILayerNode {
  uid: string;
  project: string;
  layer_name: string;
  description: string;
}

// ── Analysis Results ─────────────────────────────────────────────────────

export interface CILayerSummary {
  layer: string;
  description?: string;
  entity_count: number;
  representative_files: string[];
}

export interface CIAnalysisResult {
  run_id: string;
  project_name: string;
  tech_stack: string[];
  total_files: number;
  total_entities: number;
  layers: CILayerSummary[];
  ingest: Record<string, unknown>;
}

// ── Graph Summary ────────────────────────────────────────────────────────

export interface CIGraphSummary {
  total_nodes: number;
  total_edges: number;
  node_labels: Record<string, number>;
  edge_types?: Record<string, number>;
}

// ── Search ───────────────────────────────────────────────────────────────

export interface CISearchResult {
  uid: string;
  node_type: string;
  name: string;
  project: string;
  file_path: string;
  summary: string;
  similarity?: number;
}

export interface CISearchResponse {
  results: CISearchResult[];
}

// ── Agent ────────────────────────────────────────────────────────────────

export type CITaskType =
  | "code_generation"
  | "codebase_query"
  | "bug_fix"
  | "analyze_zip"
  | "microservice_split"
  | "scaffold";

export interface CIAgentEvent {
  type: string;
  data?: Record<string, unknown>;
}

export type CIAgentStatus = "idle" | "connecting" | "running" | "complete" | "error";

export interface CIAgentMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  timestamp: number;
  eventType?: string;
  data?: Record<string, unknown>;
}

// ── Pipeline State ───────────────────────────────────────────────────────

export type CIPhase = "idle" | "uploading" | "analyzing" | "ingesting" | "complete" | "error";

export interface CIState {
  phase: CIPhase;
  analysisResult: CIAnalysisResult | null;
  graphSummary: CIGraphSummary | null;
  searchResults: CISearchResult[];
  agentStatus: CIAgentStatus;
  agentMessages: CIAgentMessage[];
  error: string | null;
}
