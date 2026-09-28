/**
 * Legacy Modernization API client — Git / Source Control operations.
 *
 * All calls route through `/lm-api` which the Next.js proxy rewrites
 * to the Legacy Modernization backend at :8002.
 */

import { getLegacyModernizationApiBase } from "@/lib/legacy-modernization-url";

const BASE = getLegacyModernizationApiBase;

async function json<T = unknown>(res: Promise<Response> | Response): Promise<T> {
  const r = res instanceof Promise ? await res : res;
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.error || `Request failed (${r.status})`);
  }
  return r.json() as Promise<T>;
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
  return json(await fetch(`${BASE()}/git/branches?${params}`));
}

export async function getGitStatus(projectId: number, provider?: string): Promise<GitStatusResult> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  return json(await fetch(`${BASE()}/git/status?${params}`));
}

export async function gitPull(
  projectId: number,
  branch?: string,
  provider?: string,
): Promise<GitOperationResult> {
  return json(
    await fetch(`${BASE()}/git/pull`, {
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
    await fetch(`${BASE()}/git/push`, {
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
    await fetch(`${BASE()}/git/checkout`, {
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
    await fetch(`${BASE()}/git/save-repo`, {
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
  tree: Array<{
    name: string;
    path: string;
    type: "file" | "folder";
    children?: GitRepoFilesResult["tree"];
    size?: number;
  }>;
  count: number;
}

export async function getGitRepoFiles(projectId: number, provider?: string): Promise<GitRepoFilesResult> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  return json(await fetch(`${BASE()}/git/repo-files?${params}`));
}

export async function previewGitRepoFiles(
  projectId: number,
  provider?: string,
  branch?: string,
): Promise<GitRepoFilesResult & { branch?: string; preview?: boolean; truncated?: boolean }> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  if (branch) params.set("branch", branch);
  return json(await fetch(`${BASE()}/git/repo-files/preview?${params}`));
}

export async function getGitRepoFileContent(
  projectId: number,
  filePath: string,
  provider?: string,
): Promise<{ path: string; content: string; language: string; size: number }> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  return json(await fetch(`${BASE()}/git/repo-files/${filePath}?${params}`));
}

export async function previewGitRepoFileContent(
  projectId: number,
  filePath: string,
  provider?: string,
  branch?: string,
): Promise<{ path: string; content: string; language: string; size: number; branch?: string; preview?: boolean }> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  if (provider) params.set("provider", provider);
  if (branch) params.set("branch", branch);
  return json(await fetch(`${BASE()}/git/repo-files/preview/${filePath}?${params}`));
}

export async function createGitRepoFile(
  projectId: number,
  path: string,
  type: "file" | "folder" = "file",
  content: string = "",
  provider?: string,
): Promise<{ success: boolean; message: string }> {
  return json(
    await fetch(`${BASE()}/git/repo-files/create`, {
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
    await fetch(`${BASE()}/git/repo-files/delete`, {
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
    await fetch(`${BASE()}/git/repo-files/update`, {
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
    await fetch(`${BASE()}/git/repo-files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, old_path: oldPath, new_path: newPath, provider: provider || null }),
    })
  );
}

/* ── Document Builder ──────────────────────────────────── */

export interface DocumentTypeInfo {
  document_type: string;
  title_template: string;
  description: string;
  total_sections: number;
  required_sections: number;
}

export interface GeneratedDocument {
  document_type: string;
  title: string;
  markdown: string;
  metadata: Record<string, unknown>;
  present_sections: string[];
  missing_sections: string[];
}

export interface PublishedDocument {
  document_type: string;
  title: string;
  markdown_path: string;
  json_path: string;
  metadata: Record<string, unknown>;
  present_sections: string[];
  missing_sections: string[];
  markdown_blob_url?: string;
  json_blob_url?: string;
}

export async function getDocumentTypes(): Promise<{ document_types: DocumentTypeInfo[] }> {
  return json(await fetch(`${BASE()}/legacy-modernization/documents/types`));
}

export async function generateDocument(
  workspaceRoot: string,
  documentType: string = "full_report",
  projectName?: string,
  targetStack?: string,
  modernizationGoal?: string,
): Promise<GeneratedDocument> {
  return json(
    await fetch(`${BASE()}/legacy-modernization/documents/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_root: workspaceRoot,
        document_type: documentType,
        project_name: projectName || undefined,
        target_stack: targetStack || "",
        modernization_goal: modernizationGoal || "",
      }),
    })
  );
}

export async function publishDocument(
  workspaceRoot: string,
  documentType: string = "full_report",
  projectName?: string,
  targetStack?: string,
  modernizationGoal?: string,
): Promise<PublishedDocument> {
  return json(
    await fetch(`${BASE()}/legacy-modernization/documents/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_root: workspaceRoot,
        document_type: documentType,
        project_name: projectName || undefined,
        target_stack: targetStack || "",
        modernization_goal: modernizationGoal || "",
      }),
    })
  );
}

export function getDocumentDownloadUrl(
  workspaceRoot: string,
  documentType: string = "full_report",
  projectName?: string,
  targetStack?: string,
  modernizationGoal?: string,
): string {
  const params = new URLSearchParams({
    workspace_root: workspaceRoot,
    document_type: documentType,
  });
  if (projectName) params.set("project_name", projectName);
  if (targetStack) params.set("target_stack", targetStack);
  if (modernizationGoal) params.set("modernization_goal", modernizationGoal);
  return `${BASE()}/legacy-modernization/documents/download?${params}`;
}
