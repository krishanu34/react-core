/**
 * Git Clone API — clone repositories into workspaces.
 *
 * Supports GitHub, GitLab, and Azure DevOps.
 * Delegates to the Code Builder backend's /api/git/* endpoints.
 */

import {
  getGitBranches,
  saveGitRepo,
  gitPull,
  getGitRepoFiles,
  getGitRepoFileContent,
  type GitRepoFilesResult,
} from "@/lib/code-builder-api";

/* ── Types ────────────────────────────────────────────────────────────── */

export type GitProvider = "github" | "gitlab" | "azure_devops";

export interface GitCloneRequest {
  repoUrl: string;
  branch: string;
  provider: GitProvider;
  patToken?: string;
  projectId?: number;
}

export interface GitCloneFile {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface GitCloneResponse {
  project_name: string;
  branch: string;
  folders: string[];
  files: GitCloneFile[];
}

/* ── Provider detection ──────────────────────────────────────────────── */

export function detectProvider(url: string): GitProvider | null {
  const u = url.toLowerCase();
  if (u.includes("github.com")) return "github";
  if (u.includes("gitlab.com") || u.includes("gitlab")) return "gitlab";
  if (u.includes("dev.azure.com") || u.includes("visualstudio.com")) return "azure_devops";
  return null;
}

export const PROVIDER_INFO: Record<GitProvider, { label: string; placeholder: string; icon: string }> = {
  github:      { label: "GitHub",      placeholder: "https://github.com/owner/repo", icon: "GH" },
  gitlab:      { label: "GitLab",      placeholder: "https://gitlab.com/group/repo", icon: "GL" },
  azure_devops:{ label: "Azure DevOps",placeholder: "https://dev.azure.com/org/project/_git/repo", icon: "AZ" },
};

/* ── URL parsing ─────────────────────────────────────────────────────── */

export function parseRepoInfo(url: string): { owner: string; repo: string } | null {
  try {
    const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
    const urlObj = new URL(cleaned);
    const parts = urlObj.pathname.split("/").filter(Boolean);

    if (urlObj.hostname.includes("github.com") || urlObj.hostname.includes("gitlab.com")) {
      if (parts.length >= 2) {
        return { owner: parts.slice(0, -1).join("/"), repo: parts[parts.length - 1] };
      }
    }

    if (urlObj.hostname.includes("dev.azure.com")) {
      const gitIdx = parts.indexOf("_git");
      if (gitIdx >= 0 && parts[gitIdx + 1]) {
        return { owner: parts.slice(0, gitIdx).join("/"), repo: parts[gitIdx + 1] };
      }
    }
  } catch { /* invalid URL */ }
  return null;
}

export function extractRepoName(url: string): string {
  const info = parseRepoInfo(url);
  return info?.repo ?? "workspace";
}

/* ── Language inference ───────────────────────────────────────────────── */

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", java: "java", go: "go", cs: "csharp",
    cpp: "cpp", c: "c", h: "c", rs: "rust",
    json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", html: "html", css: "css", scss: "scss",
    sql: "sql", sh: "shell", bash: "shell",
  };
  return map[ext] || "plaintext";
}

/* ── List branches ───────────────────────────────────────────────────── */

export async function listBranches(
  repoUrl: string,
  provider: GitProvider,
  patToken?: string,
  projectId?: number,
): Promise<string[]> {
  if (!projectId) return ["main"];

  try {
    const data = await getGitBranches(projectId, provider);
    return data.branches ?? ["main"];
  } catch {
    return ["main"];
  }
}

/* ── Clone repository ────────────────────────────────────────────────── */

export async function cloneRepo(request: GitCloneRequest): Promise<GitCloneResponse> {
  const projectId = request.projectId;
  if (!projectId) throw new Error("No project selected. Select a project from the top bar.");

  // Step 1: Save the repo config
  await saveGitRepo(projectId, request.provider, request.repoUrl, request.branch);

  // Step 2: Clone/pull the repo
  const pullRes = await gitPull(projectId, request.branch, request.provider);
  if (!pullRes.success) throw new Error(pullRes.message || "Clone failed");

  // Step 3: Get the file tree
  const treeRes: GitRepoFilesResult = await getGitRepoFiles(projectId, request.provider);

  // Step 4: Flatten tree to get all file paths
  const filePaths: string[] = [];
  const folders: string[] = [];
  const flattenTree = (nodes: GitRepoFilesResult["tree"]) => {
    for (const node of nodes) {
      if (node.type === "folder") {
        folders.push(node.path);
        if (node.children) flattenTree(node.children);
      } else {
        filePaths.push(node.path);
      }
    }
  };
  flattenTree(treeRes.tree);

  // Step 5: Read file contents (limit to 500 files)
  const filesToRead = filePaths.slice(0, 500);
  const files: GitCloneFile[] = [];

  for (const filePath of filesToRead) {
    try {
      const data = await getGitRepoFileContent(projectId, filePath, request.provider);
      files.push({
        path: data.path || filePath,
        content: data.content || "",
        language: data.language || inferLanguage(filePath),
        size: data.size || 0,
      });
    } catch {
      // Skip files that fail to read (binary, too large, etc.)
    }
  }

  return {
    project_name: extractRepoName(request.repoUrl),
    branch: request.branch,
    folders,
    files,
  };
}
