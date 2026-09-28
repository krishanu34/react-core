/**
 * Git Workspace API — source control operations for IDE workspaces.
 *
 * Delegates to the Code Builder backend's /api/git/* endpoints
 * via the functions in code-builder-api.ts.
 */

import {
  getGitStatus,
  gitPull,
  gitPush,
  type GitStatusResult,
  type GitOperationResult,
} from "@/lib/code-builder-api";

/* ── Types ────────────────────────────────────────────────────────────── */

export type FileChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: FileChangeStatus;
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  changes: ChangedFile[];
  configured: boolean;
  hasRepo: boolean;
  provider: string | null;
  repoUrl: string | null;
}

export interface CommitResult {
  success: boolean;
  message: string;
  commitHash: string;
}

export interface SyncResult {
  success: boolean;
  message: string;
  filesChanged: number;
}

/* ── Get git status ──────────────────────────────────────────────────── */

export async function getWorkspaceGitStatus(
  projectId: number,
): Promise<GitStatus> {
  const res: GitStatusResult = await getGitStatus(projectId);

  return {
    branch: res.branch || res.default_branch || "main",
    remoteBranch: `origin/${res.branch || res.default_branch || "main"}`,
    ahead: 0,
    behind: 0,
    hasRemote: res.has_repo,
    changes: [],
    configured: res.configured,
    hasRepo: res.has_repo,
    provider: res.provider ?? res.cloned_provider ?? null,
    repoUrl: res.repo_url ?? null,
  };
}

/* ── Stage / unstage files (UI-only — backend auto-stages on push) ──── */

export async function stageFile(
  _projectId: number,
  _path: string,
): Promise<void> {
  // Local UI state only — backend auto-stages all changes on push
}

export async function unstageFile(
  _projectId: number,
  _path: string,
): Promise<void> {
  // Local UI state only — backend auto-stages all changes on push
}

/* ── Commit + Push ──────────────────────────────────────────────────── */

export async function commitChanges(
  projectId: number,
  message: string,
): Promise<CommitResult> {
  const res: GitOperationResult = await gitPush(projectId, undefined, message);

  return {
    success: res.success,
    message: res.message,
    commitHash: (res.data?.branch as string) ?? "",
  };
}

/* ── Pull ────────────────────────────────────────────────────────────── */

export async function pullChanges(
  projectId: number,
  branch?: string,
): Promise<SyncResult> {
  const res: GitOperationResult = await gitPull(projectId, branch);

  return {
    success: res.success,
    message: res.message,
    filesChanged: 0,
  };
}

/* ── Push ────────────────────────────────────────────────────────────── */

export async function pushChanges(
  projectId: number,
  branch?: string,
): Promise<SyncResult> {
  const res: GitOperationResult = await gitPush(projectId, branch);

  return {
    success: res.success,
    message: res.message,
    filesChanged: 0,
  };
}
