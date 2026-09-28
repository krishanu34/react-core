/**
 * API client — talks to the Code Builder FastAPI backend at /cb-api/*
 * Next.js rewrites /cb-api/* → NEXT_PUBLIC_CODE_BUILDER_API_URL (default: http://localhost:8001)
 */

import type {
  FileNode,
  PipelineMode,
  PipelineRun,
  ProjectInfo,
  FileDiff,
} from "@/types/code-builder";
import type { EpicItem, FeatureItem, StoryItem } from "@/types/code-builder-v2";
import { getToken } from "@/lib/auth";

const BASE = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";

/* ── helpers ───────────────────────────────────────────── */

/** Build headers object with JWT Authorization + optional extras. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Wrapper around fetch that injects auth headers automatically. */
function _fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    // Extract "detail" from FastAPI JSON error responses
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed.detail) message = parsed.detail;
      else if (parsed.message) message = parsed.message;
    } catch {
      // body is not JSON — use raw text
    }
    throw new Error(message);
  }
  return res.json();
}

/* ── Pipeline ──────────────────────────────────────────── */
export async function startPipeline(
  mode: PipelineMode,
  request: string,
  projectId?: string,
  projectDir?: string
): Promise<PipelineRun> {
  const res = await _fetch(`${BASE}/pipeline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      request,
      project_id: projectId,
      project_dir: projectDir,
    }),
  });
  return json(res);
}

export async function getPipelineStatus(runId: string): Promise<PipelineRun> {
  return json(await _fetch(`${BASE}/pipeline/status/${runId}`));
}

export async function getPipelineModes() {
  return json<{ modes: { name: string; label: string; steps: string[] }[] }>(
    await _fetch(`${BASE}/pipeline/modes`)
  );
}

export async function getPipelineRuns() {
  return json<{ runs: PipelineRun[] }>(await _fetch(`${BASE}/pipeline/runs`));
}

export async function getOutputTree(runId: string): Promise<{ tree: FileNode[]; output_dir?: string }> {
  return json(await _fetch(`${BASE}/pipeline/output/${runId}/tree`));
}

export async function readOutputFile(runId: string, filePath: string): Promise<{ content: string; language: string; size: number }> {
  return json(
    await _fetch(`${BASE}/pipeline/output/${runId}/file?path=${encodeURIComponent(filePath)}`)
  );
}

export async function extractOutputToProject(runId: string, projectId: string): Promise<{ files_extracted: number }> {
  return json(
    await _fetch(`${BASE}/pipeline/output/${runId}/extract-to-project/${projectId}`, { method: "POST" })
  );
}

/* ── Files ─────────────────────────────────────────────── */
export async function getFileTree(projectId: string): Promise<FileNode[]> {
  const data = await json<FileNode[]>(
    await _fetch(`${BASE}/files/tree/${projectId}`)
  );
  return data;
}

export async function readFile(
  projectId: string,
  filePath: string
): Promise<{ content: string; language: string }> {
  return json(
    await _fetch(
      `${BASE}/files/read/${projectId}?path=${encodeURIComponent(filePath)}`
    )
  );
}

export async function writeFile(
  projectId: string,
  filePath: string,
  content: string
): Promise<void> {
  await _fetch(`${BASE}/files/write/${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, content }),
  });
}

export async function createFile(
  projectId: string,
  filePath: string,
  isDir: boolean = false
): Promise<void> {
  await _fetch(`${BASE}/files/create/${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, type: isDir ? "folder" : "file" }),
  });
}

export async function deleteFile(
  filePath: string,
  runId?: string,
  outputDir?: string
): Promise<void> {
  const params = new URLSearchParams({ path: filePath });
  if (runId) params.set("run_id", runId);
  if (outputDir) params.set("output_dir", outputDir);
  const res = await _fetch(`${BASE}/files/delete?${params}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? body.detail ?? "Delete failed");
  }
}

/**
 * Create a new empty file or folder inside the generated-project output_dir.
 * Backend: POST /api/files/create  → src/code_builder/main.py::create_generated_file
 */
export async function createGeneratedFile(
  filePath: string,
  type: "file" | "folder",
  runId?: string,
  outputDir?: string,
  content: string = "",
): Promise<void> {
  const res = await _fetch(`${BASE}/files/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: filePath,
      type,
      content,
      run_id: runId,
      output_dir: outputDir,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail ?? "Create failed");
  }
}

/**
 * Rename / move a file or folder inside the generated-project output_dir.
 * Backend: POST /api/files/rename  → src/code_builder/main.py::rename_generated_file
 */
export async function renameGeneratedFile(
  oldPath: string,
  newPath: string,
  runId?: string,
  outputDir?: string,
): Promise<void> {
  const res = await _fetch(`${BASE}/files/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      old_path: oldPath,
      new_path: newPath,
      run_id: runId,
      output_dir: outputDir,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail ?? "Rename failed");
  }
}

export async function searchFiles(
  projectId: string,
  query: string
): Promise<{ results: { path: string; matches: string[] }[] }> {
  return json(
    await _fetch(
      `${BASE}/files/search/${projectId}?q=${encodeURIComponent(query)}`
    )
  );
}

/* ── Projects ──────────────────────────────────────────── */
export async function createProject(
  name: string,
  mode: PipelineMode,
  description: string
): Promise<ProjectInfo> {
  const data = await json<any>(
    await _fetch(`${BASE}/projects/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mode, description }),
    })
  );
  return {
    project_id: data.id,
    name: data.name,
    mode: data.mode as PipelineMode,
    description: data.description,
    created_at: data.created_at,
    status: "active",
  };
}

export async function checkProjectName(name: string): Promise<{ available: boolean; message: string }> {
  return json(await _fetch(`${BASE}/projects/check-name?name=${encodeURIComponent(name)}`));
}

export async function listProjects(): Promise<{ projects: ProjectInfo[] }> {
  return json(await _fetch(`${BASE}/projects/list`));
}

export async function getProject(projectId: string): Promise<ProjectInfo> {
  return json(await _fetch(`${BASE}/projects/${projectId}`));
}

export async function deleteProject(projectId: string): Promise<void> {
  await _fetch(`${BASE}/projects/${projectId}`, { method: "DELETE" });
}

export async function getProjectStoriesAndFeatures(projectId: number): Promise<Array<EpicItem | FeatureItem>> {
  return json(await _fetch(`${BASE}/projects/${projectId}/stories-and-features`));
}

/* ── Chat ──────────────────────────────────────────────── */
export async function sendChatMessage(
  message: string,
  context?: { file_path?: string; code_snippet?: string; pipeline_mode?: string }
): Promise<{ reply: string; suggestions: string[] }> {
  return json(
    await _fetch(`${BASE}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context }),
    })
  );
}

export async function getChatSuggestions(
  mode: PipelineMode
): Promise<{ suggestions: string[] }> {
  return json(await _fetch(`${BASE}/chat/suggestions?mode=${mode}`));
}

/* ── WebSocket helpers — direct connection to backend ── */
export function connectPipelineWs(runId: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const port = new URL(
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
  ).port || "8000";
  return new WebSocket(`${proto}://${window.location.hostname}:${port}/api/pipeline/ws/${runId}`);
}

export function connectChatWs(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const port = new URL(
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
  ).port || "8000";
  return new WebSocket(`${proto}://${window.location.hostname}:${port}/api/chat/ws`);
}

/* ── Upload helpers ────────────────────────────────────── */
export async function uploadFile(
  projectId: string,
  file: File
): Promise<{ path: string; size: number }> {
  const form = new FormData();
  form.append("file", file);
  return json(
    await _fetch(`${BASE}/files/upload/${projectId}`, {
      method: "POST",
      body: form,
    })
  );
}

export async function uploadZip(
  projectId: string,
  file: File
): Promise<{ extracted: number; files: string[] }> {
  const form = new FormData();
  form.append("file", file);
  return json(
    await _fetch(`${BASE}/files/upload-zip/${projectId}`, {
      method: "POST",
      body: form,
    })
  );
}

/* ── Health ─────────────────────────────────────────────── */
export async function checkHealth(): Promise<{ status: string }> {
  return json(await _fetch(`${BASE}/health`));
}

/* ── HITL Gate Response ────────────────────────────────── */
export async function respondToGate(
  runId: string,
  gateId: string,
  approved: boolean
): Promise<{ ok: boolean }> {
  return json(
    await _fetch(`${BASE}/pipeline/gate/${runId}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gate_id: gateId, approved }),
    })
  );
}

export async function getGateReport(
  runId: string,
  path: string
): Promise<{ content: string; language: string; size: number }> {
  return json(
    await _fetch(
      `${BASE}/pipeline/gate/${runId}/report?path=${encodeURIComponent(path)}`
    )
  );
}

/* ── Pipeline Run Management ──────────────────────────── */
export async function deletePipelineRun(
  runId: string
): Promise<{ status: string }> {
  return json(
    await _fetch(`${BASE}/pipeline/run/${runId}`, { method: "DELETE" })
  );
}

/* ── Pipeline History (all runs with full details) ─────── */
export async function getPipelineHistory(): Promise<any[]> {
  const data = await json<any>(await _fetch(`${BASE}/pipeline/runs`));
  return Array.isArray(data) ? data : data?.runs ?? [];
}

/* ── Report Files for a run ────────────────────────────── */
export async function getRunReports(runId: string): Promise<{ reports: { path: string; name: string; language: string; size: number }[] }> {
  return json(await _fetch(`${BASE}/pipeline/output/${runId}/reports`));
}

export async function readReportFile(runId: string, path: string): Promise<{ content: string; language: string; size: number }> {
  return json(
    await _fetch(`${BASE}/pipeline/output/${runId}/file?path=${encodeURIComponent(path)}`)
  );
}

/* ── Diff Viewer for brownfield/hybrid ─────────────────── */
export async function getRunDiffs(runId: string): Promise<FileDiff[]> {
  const res: any = await json(await _fetch(`${BASE}/pipeline/output/${runId}/diffs`));
  return (res.diffs || []).map((d: any) => ({
    file_path: d.file_path,
    old_content: d.old_content,
    new_content: d.new_content,
    language: d.language,
    change_type: d.change_type as "added" | "modified" | "deleted",
  }));
}

/* ── Pipeline Output Download ──────────────────────────── */
export async function downloadPipelineOutput(runId: string): Promise<void> {
  const res = await _fetch(`${BASE}/pipeline/output/${runId}/download`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Download failed: ${body}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename=(.+)/);
  const filename = filenameMatch ? filenameMatch[1] : `${runId}_output.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Git Operations ────────────────────────────────────── */
export interface GitBranchesResult {
  branches: string[];
  message: string;
}

export interface GitProviderInfo {
  provider: string;
  repo_url: string;
  default_branch: string;
  org_url?: string;
  project?: string;
  needs_repo_url?: boolean;
  is_active?: boolean;
}

export interface GitStatusResult {
  configured: boolean;
  has_repo: boolean;
  branch: string;
  provider?: string | null;
  repo_url?: string | null;
  default_branch?: string | null;
  cloned_provider?: string | null;
  providers?: GitProviderInfo[];
}

export interface GitOperationResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export async function getGitBranches(projectId: number, provider?: string): Promise<GitBranchesResult> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  return json(await _fetch(`${BASE}/git/branches?${params}`));
}

export async function getGitStatus(projectId: number, provider?: string): Promise<GitStatusResult> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  return json(await _fetch(`${BASE}/git/status?${params}`));
}

export async function gitPull(
  projectId: number,
  branch?: string,
  provider?: string,
): Promise<GitOperationResult> {
  return json(
    await _fetch(`${BASE}/git/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, branch: branch || null, provider: provider || null }),
    })
  );
}

export async function gitPush(
  projectId: number,
  branch?: string,
  commitMessage?: string,
  provider?: string,
): Promise<GitOperationResult> {
  return json(
    await _fetch(`${BASE}/git/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        branch: branch || null,
        commit_message: commitMessage || null,
        provider: provider || null,
      }),
    })
  );
}

export async function gitCheckout(
  projectId: number,
  branch: string,
  create: boolean = false,
  provider?: string,
): Promise<GitOperationResult> {
  return json(
    await _fetch(`${BASE}/git/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, branch, create, provider: provider || null }),
    })
  );
}

export async function saveGitRepo(
  projectId: number,
  provider: string,
  repoUrl: string,
  defaultBranch: string = "main",
): Promise<GitOperationResult> {
  return json(
    await _fetch(`${BASE}/git/save-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        provider,
        repo_url: repoUrl,
        default_branch: defaultBranch,
      }),
    })
  );
}

export interface GitRepoFilesResult {
  tree: Array<{ name: string; path: string; type: "file" | "folder"; children?: GitRepoFilesResult["tree"]; size?: number }>;
  count: number;
}

export async function getGitRepoFiles(projectId: number, provider?: string): Promise<GitRepoFilesResult> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  return json(await _fetch(`${BASE}/git/repo-files?${params}`));
}

export async function getGitRepoFileContent(
  projectId: number,
  filePath: string,
  provider?: string,
): Promise<{ path: string; content: string; language: string; size: number }> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  // URL-encode each segment (spaces, #, ?, %, etc.) while preserving the
  // path separators that the backend's {file_path:path} route requires.
  const safePath = filePath.split("/").map(encodeURIComponent).join("/");
  return json(await fetch(`${BASE}/git/repo-files/${safePath}?${params}`));
}

export async function createGitRepoFile(
  projectId: number,
  path: string,
  type: "file" | "folder" = "file",
  content: string = "",
  provider?: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await _fetch(`${BASE}/git/repo-files/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path, type, content, provider: provider || null }),
    })
  );
}

export async function deleteGitRepoFile(
  projectId: number,
  path: string,
  provider?: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await _fetch(`${BASE}/git/repo-files/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path, provider: provider || null }),
    })
  );
}

export async function updateGitRepoFile(
  projectId: number,
  path: string,
  content: string,
  provider?: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await _fetch(`${BASE}/git/repo-files/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, path, content, provider: provider || null }),
    })
  );
}

export async function renameGitRepoFile(
  projectId: number,
  oldPath: string,
  newPath: string,
  provider?: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await _fetch(`${BASE}/git/repo-files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, old_path: oldPath, new_path: newPath, provider: provider || null }),
    })
  );
}

/* ── Workspace Upload & Analysis ─────────────────────────── */

import type {
  CBv2WorkspaceSource,
  CBv2WorkspaceAnalysisStatus,
  CBv2FileNode,
  CBv2WorkflowType,
  CBv2ActionType,
} from "@/types/code-builder-v2";

export async function uploadToWorkspace(
  projectId: number,
  file: File,
): Promise<{
  run_id: string;
  source_name: string;
  source_type: string;
  file_count: number;
  total_size: number;
  analysis_status: string;
}> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("project_id", String(projectId));
  return json(await _fetch(`${BASE}/workspace/upload`, { method: "POST", body: fd }));
}

export async function uploadFolderToWorkspace(
  projectId: number,
  files: FileList,
  folderName: string,
): Promise<{
  run_id: string;
  source_name: string;
  source_type: string;
  file_count: number;
  total_size: number;
  analysis_status: string;
}> {
  const fd = new FormData();
  fd.append("project_id", String(projectId));
  fd.append("folder_name", folderName);
  for (let i = 0; i < files.length; i++) {
    fd.append("files", files[i], files[i].webkitRelativePath || files[i].name);
  }
  return json(await _fetch(`${BASE}/workspace/upload-folder`, { method: "POST", body: fd }));
}

export async function getWorkspaceSources(
  projectId: number,
): Promise<{ sources: CBv2WorkspaceSource[] }> {
  return json(await _fetch(`${BASE}/workspace/sources?project_id=${projectId}`));
}

export async function getWorkspaceAnalysisStatus(
  projectId: number,
): Promise<CBv2WorkspaceAnalysisStatus> {
  return json(await _fetch(`${BASE}/workspace/analysis-status?project_id=${projectId}`));
}

export async function getWorkspaceFiles(
  projectId: number,
): Promise<{ tree: CBv2FileNode[]; count: number }> {
  return json(await _fetch(`${BASE}/workspace/files?project_id=${projectId}`));
}

export async function getWorkspaceFileContent(
  projectId: number,
  filePath: string,
): Promise<{ path: string; content: string; language: string; size: number }> {
  return json(await _fetch(`${BASE}/workspace/files/${filePath}?project_id=${projectId}`));
}

export async function createWorkspaceFile(
  projectId: number,
  path: string,
  type: "file" | "folder",
  content: string = "",
): Promise<{ success: boolean; path: string; type: string }> {
  return json(
    await _fetch(
      `${BASE}/workspace/files/create?project_id=${projectId}&path=${encodeURIComponent(path)}&type=${type}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) },
    )
  );
}

export async function deleteWorkspaceFile(
  projectId: number,
  filePath: string,
): Promise<{ success: boolean; path: string }> {
  return json(
    await _fetch(`${BASE}/workspace/files/${filePath}/delete?project_id=${projectId}`, {
      method: "POST",
    })
  );
}

export async function classifyWorkflow(
  userMessage: string,
  projectId?: number | null,
  hasWorkspaceSources?: boolean,
): Promise<{ workflow: CBv2WorkflowType; action_type: CBv2ActionType; source: string }> {
  return json(
    await _fetch(`${BASE}/workspace/classify-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_message: userMessage,
        project_id: projectId || null,
        has_workspace_sources: hasWorkspaceSources ?? false,
      }),
    })
  );
}

export async function registerGitPull(
  projectId: number,
  provider: string = "github",
): Promise<{ run_id: string; source_name: string; file_count: number; analysis_status: string }> {
  return json(
    await _fetch(`${BASE}/workspace/register-git-pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, provider }),
    })
  );
}

export async function deleteWorkspaceSource(
  projectId: number,
  runId: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await _fetch(`${BASE}/workspace/sources/${runId}/delete?project_id=${projectId}`, {
      method: "POST",
    })
  );
}

export async function clearAllWorkspaceSources(
  projectId: number,
): Promise<{ success: boolean; message: string; count: number }> {
  return json(
    await _fetch(`${BASE}/workspace/sources/clear?project_id=${projectId}`, {
      method: "POST",
    })
  );
}

/* ── Code Builder Sessions ─────────────────────────────── */

export interface CBSession {
  id: number;
  session_name: string;
  status: string;
  description: string | null;
  message_count: number;
  last_output_dir: string | null;
  last_run_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function listCBSessions(
  projectId: number,
  opts?: { limit?: number; offset?: number; search?: string },
): Promise<{ sessions: CBSession[]; total: number }> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.search) params.set("search", opts.search);
  return json(await _fetch(`${BASE}/session/list?${params}`));
}

export async function getCBSessionMessages(
  sessionId: number,
): Promise<{ messages: Array<{ role: string; content: string; timestamp?: number }> }> {
  return json(await _fetch(`${BASE}/session/${sessionId}/messages`));
}

/** Get the latest run for a project — used by explorer to show files at project level */
export async function getProjectLatestRun(
  projectId: number,
): Promise<{ run_id: string | null; output_dir: string | null; status: string | null; session_id: number | null; started_at: string | null }> {
  return json(await _fetch(`${BASE}/project/${projectId}/latest-run`));
}

/* ── Session Runs (hierarchy: Project → Session → Runs) ──── */

export interface CBSessionRun {
  run_id: string | null;
  session_id: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  pipeline_type: string;
  project_name: string;
  output_dir: string | null;
  files_planned: number;
  files_generated: number;
  files_on_disk: number;
  error_message: string | null;
}

/** List all runs within a session — used by session picker to show run history */
export async function listSessionRuns(
  sessionId: number,
): Promise<{ runs: CBSessionRun[] }> {
  return json(await _fetch(`${BASE}/session/${sessionId}/runs`));
}

/** Delete a code-builder run: removes the DB row and the on-disk
 *  workspace directory associated with that run. */
export async function deleteCBRun(
  runId: string,
): Promise<{
  success: boolean;
  run_id: string;
  session_id: number | null;
  project_id: number | null;
  removed_output_dir: string | null;
}> {
  return json(
    await _fetch(`${BASE}/runs/${runId}`, { method: "DELETE" })
  );
}

export async function markWorkspaceSourceFailed(
  projectId: number,
  runId: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await _fetch(`${BASE}/workspace/sources/${runId}/mark-failed?project_id=${projectId}`, {
      method: "PATCH",
    })
  );
}

export async function getAnalysisReport(
  projectId: number,
): Promise<{ report: string; format: string }> {
  return json(await _fetch(`${BASE}/workspace/analysis-report?project_id=${projectId}`));
}
