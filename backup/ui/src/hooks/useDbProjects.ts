import { authFetch, DEVSPHERE_API } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface AtlassianConfig {
  jira_url:          string;
  project_key:       string;
  api_token:         string;
  email:             string;
  confluence_space?: string;
}

export interface ConfluenceConfig {
  base_url:  string;
  email:     string;   // username or email — used for Basic-auth fallback on on-prem
  api_token: string;   // API token (Cloud) or Personal Access Token (on-prem)
}

export interface WorkItemTypeMap {
  epic?:         string;
  feature?:      string;
  story?:        string;
  effort_field?: string;
}

export interface AzureDevOpsConfig {
  org_url:     string;
  project:     string;
  pat_token:   string;
  team_id?:    string;
  board_id?:   string;
  wiki_id?:    string;
  work_item_type_map?: WorkItemTypeMap;
}

export interface GitLabConfig {
  git_urls:     string[];  // one or more full git clone URLs
  username:     string;   // GitLab username or user ID
  access_token: string;   // Personal Access Token
}

export type GitProviderType = "github" | "azure_devops";

export interface GitRepoConfig {
  provider:        GitProviderType;
  repo_url:        string;   // HTTPS clone URL
  default_branch:  string;   // e.g. "main"
  pat_token:       string;   // Personal Access Token
  org_url?:        string;   // Azure DevOps org URL (optional)
  project?:        string;   // Azure DevOps project name (optional)
}

/** Multi-provider: keyed by provider name */
export type GitConfigs = Partial<Record<GitProviderType, Omit<GitRepoConfig, "provider">>>;

export interface AdoLookupResult {
  teams:  { id: string; name: string }[];
  boards: { id: string; name: string; team: string }[];
  wikis:  { id: string; name: string }[];
  work_item_types: { name: string; description: string }[];
  process_template: string;
}

export interface ModelConfigs {
  vision?:       number | null;
  embedding?:    number | null;
  story_builder?: { base?: number | null; reviewer?: number | null; vision?: number | null };
  code_builder?:  { base?: number | null; reviewer?: number | null };
  doc_builder?:   { base?: number | null; reviewer?: number | null; vision?: number | null };
  modernization_builder?: { base?: number | null; reviewer?: number | null };
  ingestion_builder?:     { base?: number | null; reviewer?: number | null; vision?: number | null };
}

export interface DbProject {
  id:                  number;
  name:                string;
  description:         string | null;
  archived:            boolean;
  created_at:          string | null;
  has_code_context:    boolean;
  has_doc_context:     boolean;
  has_figma_context:   boolean;
  has_document_context?: boolean;
  atlassian_config?:   AtlassianConfig | null;
  confluence_config?:  ConfluenceConfig | null;
  azure_devops_config?: AzureDevOpsConfig | null;
  gitlab_config?:       GitLabConfig | null;
  git_config?:          GitRepoConfig | null;
  git_configs?:         GitConfigs | null;
  team_ids?:            number[];
  model_configs?:       ModelConfigs | null;
}

/**
 * DevSphere AI is standalone and has NO projects concept: tenancy is the user,
 * and a workspace belongs directly to its `owner_user_id`. `/api/v1/projects`
 * belonged to the DevAccel USG service (:8000) and is not served here, so this
 * query is disabled — it was firing on every page load and 404ing in a loop.
 *
 * The hook is kept (returning an empty list) because several IDE panels still
 * consume ProjectProvider and already degrade gracefully with no project
 * selected. Delete it once those panels drop the dependency.
 */
export function useDbProjects() {
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: queryKeys.projects.all(),
    queryFn: async () => [] as DbProject[],
    enabled: false,
    initialData: [] as DbProject[],
    staleTime: Infinity,
  });

  const createMutation = useMutation({
    mutationFn: (args: {
      name: string;
      description?: string;
      atlassian_config?: AtlassianConfig | null;
      confluence_config?: ConfluenceConfig | null;
      azure_devops_config?: AzureDevOpsConfig | null;
      team_ids?: number[];
      gitlab_config?: GitLabConfig | null;
      model_configs?: ModelConfigsInput | null;
    }) =>
      createDbProject(
        args.name,
        args.description,
        args.atlassian_config,
        args.azure_devops_config,
        args.team_ids,
        args.gitlab_config,
        args.model_configs,
        undefined,
        undefined,
        args.confluence_config,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all() }),
  });

  const updateMutation = useMutation({
    mutationFn: (args: {
      projectId: number;
      name: string;
      description?: string;
      atlassian_config?: AtlassianConfig | null;
      confluence_config?: ConfluenceConfig | null;
      azure_devops_config?: AzureDevOpsConfig | null;
      team_ids?: number[];
      gitlab_config?: GitLabConfig | null;
      model_configs?: ModelConfigsInput | null;
    }) =>
      updateDbProject(
        args.projectId,
        args.name,
        args.description,
        args.atlassian_config,
        args.azure_devops_config,
        args.team_ids,
        args.gitlab_config,
        args.model_configs,
        undefined,
        undefined,
        args.confluence_config,
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all() });
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(vars.projectId) });
    },
  });

  return {
    projects: (data ?? []) as DbProject[],
    loading: isLoading,
    refresh: refetch,
    create: (args: Parameters<typeof createMutation.mutateAsync>[0]) => createMutation.mutateAsync(args),
    update: (args: Parameters<typeof updateMutation.mutateAsync>[0]) => updateMutation.mutateAsync(args),
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROJECT DETAIL
// ═══════════════════════════════════════════════════════════════════════════

export function useProjectDetail(projectId: number | null | undefined) {
  return useQuery<DbProject>({
    queryKey: queryKeys.projects.detail(projectId!),
    queryFn: () => getDbProject(projectId!),
    // Disabled for the same reason as useDbProjects: /api/v1/projects/{id} is
    // not served by this product. A stale localStorage project id was making
    // this fire too.
    enabled: false,
    staleTime: Infinity,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACTIVE MODELS (shared global cache)
// ═══════════════════════════════════════════════════════════════════════════

export interface ActiveModel {
  id: number;
  display_name: string;
  vendor: string;
  vendor_label: string;
  model_name: string;
  model_type: string;
  is_default?: boolean;
}

export function useActiveModels() {
  return useQuery<ActiveModel[]>({
    queryKey: queryKeys.activeModels(),
    queryFn: async () => {
      const res = await authFetch(`${API}/api/v1/models/active`, {}, { silent: true });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    staleTime: 5 * 60_000, // 5 minutes — rarely changes
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROFILE
// ═══════════════════════════════════════════════════════════════════════════

/** Mirrors GET /auth/profile in backend/auth/router.py. */
export interface ProfileData {
  user: {
    id: number;
    username: string;
    email: string | null;
    full_name: string | null;
    role: string;
    is_admin: boolean;
    is_active: boolean;
    created_at: string | null;
    last_login: string | null;
    login_count: number;
  };
  teams: { id: number; name: string; description: string | null; role_in_team: string }[];
  /** Capability roles carried by this session's token. */
  roles: string[];
  stats: {
    active_workspaces: number;
    archived_workspaces: number;
    total_sessions: number;
    active_sessions: number;
    prompts_sent: number;
    login_count: number;
    llm_requests: number;
    total_tokens: number;
    tokens_this_month: number;
    cost_this_month_usd: number;
    last_active_at: string | null;
  };
}

// Served by the DevSphere backend (port 8003), NOT the DevAccel API this file's
// other hooks use — see the DEVSPHERE_API comment in lib/auth.ts.
export function useProfile() {
  return useQuery<ProfileData>({
    queryKey: queryKeys.profile(),
    queryFn: async () => {
      const res = await authFetch(`${DEVSPHERE_API}/auth/profile`, {}, { silent: true });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed to load profile" }));
        throw new Error(
          typeof err.detail === "string" ? err.detail : "Failed to load profile",
        );
      }
      return res.json();
    },
    staleTime: 10 * 60_000, // 10 minutes — profile rarely changes mid-session
    refetchOnWindowFocus: false,
  });
}

export async function checkProjectNameAvailability(
  name: string,
): Promise<{ available: boolean; message: string }> {
  const res = await authFetch(
    `${API}/api/v1/projects/check-name?name=${encodeURIComponent(name)}`,
  );
  if (!res.ok) return { available: true, message: "" }; // fail-open
  return res.json();
}

export interface ModelConfigsInput {
  vision_model_id?:         number | null;
  embedding_model_id?:      number | null;
  story_base_model_id?:     number | null;
  story_reviewer_model_id?: number | null;
  code_base_model_id?:      number | null;
  code_reviewer_model_id?:  number | null;
  doc_base_model_id?:       number | null;
  doc_reviewer_model_id?:   number | null;
  modernization_base_model_id?:     number | null;
  modernization_reviewer_model_id?: number | null;
  ingestion_base_model_id?:         number | null;
  ingestion_reviewer_model_id?:     number | null;
  story_vision_model_id?:     number | null;
  doc_vision_model_id?:       number | null;
  ingestion_vision_model_id?: number | null;
}

export async function createDbProject(
  name: string,
  description?: string,
  atlassian_config?: AtlassianConfig | null,
  azure_devops_config?: AzureDevOpsConfig | null,
  team_ids?: number[],
  gitlab_config?: GitLabConfig | null,
  model_configs?: ModelConfigsInput | null,
  git_config?: GitRepoConfig | null,
  git_configs?: GitConfigs | null,
  confluence_config?: ConfluenceConfig | null,
): Promise<DbProject> {
  const mc = model_configs ?? {};
  const res = await authFetch(`${API}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: description || null,
      atlassian_config:        atlassian_config    ?? null,
      confluence_config:       confluence_config   ?? null,
      azure_devops_config:     azure_devops_config ?? null,
      gitlab_config:           gitlab_config       ?? null,
      git_config:              git_config          ?? null,
      git_configs:             git_configs          ?? null,
      team_ids:                team_ids ?? [],
      vision_model_id:         mc.vision_model_id         ?? null,
      embedding_model_id:      mc.embedding_model_id      ?? null,
      story_base_model_id:     mc.story_base_model_id     ?? null,
      story_reviewer_model_id: mc.story_reviewer_model_id ?? null,
      code_base_model_id:      mc.code_base_model_id      ?? null,
      code_reviewer_model_id:  mc.code_reviewer_model_id  ?? null,
      doc_base_model_id:       mc.doc_base_model_id       ?? null,
      doc_reviewer_model_id:   mc.doc_reviewer_model_id   ?? null,
      modernization_base_model_id:     mc.modernization_base_model_id     ?? null,
      modernization_reviewer_model_id: mc.modernization_reviewer_model_id ?? null,
      ingestion_base_model_id:         mc.ingestion_base_model_id         ?? null,
      ingestion_reviewer_model_id:     mc.ingestion_reviewer_model_id     ?? null,
      story_vision_model_id:     mc.story_vision_model_id     ?? null,
      doc_vision_model_id:       mc.doc_vision_model_id       ?? null,
      ingestion_vision_model_id: mc.ingestion_vision_model_id ?? null,
    }),
  }, { silent: true });
  if (res.status === 401) {
    throw new Error("Your session has expired. Please log in again to save.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to create project");
  }
  return res.json();
}

export async function getDbProject(projectId: number): Promise<DbProject> {
  const res = await authFetch(`${API}/api/v1/projects/${projectId}`, {}, { silent: true });
  if (res.status === 401) {
    throw new Error("Your session has expired. Please log in again.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to load project");
  }
  return res.json();
}

export async function updateDbProject(
  projectId: number,
  name: string,
  description?: string,
  atlassian_config?: AtlassianConfig | null,
  azure_devops_config?: AzureDevOpsConfig | null,
  team_ids?: number[],
  gitlab_config?: GitLabConfig | null,
  model_configs?: ModelConfigsInput | null,
  git_config?: GitRepoConfig | null,
  git_configs?: GitConfigs | null,
  confluence_config?: ConfluenceConfig | null,
): Promise<DbProject> {
  const mc = model_configs ?? {};
  const res = await authFetch(`${API}/api/v1/projects/${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: description || "",
      atlassian_config:        atlassian_config    ?? null,
      confluence_config:       confluence_config   ?? null,
      azure_devops_config:     azure_devops_config ?? null,
      gitlab_config:           gitlab_config       ?? null,
      git_config:              git_config          ?? null,
      git_configs:             git_configs          ?? null,
      team_ids:                team_ids ?? [],
      vision_model_id:         mc.vision_model_id         ?? null,
      embedding_model_id:      mc.embedding_model_id      ?? null,
      story_base_model_id:     mc.story_base_model_id     ?? null,
      story_reviewer_model_id: mc.story_reviewer_model_id ?? null,
      code_base_model_id:      mc.code_base_model_id      ?? null,
      code_reviewer_model_id:  mc.code_reviewer_model_id  ?? null,
      doc_base_model_id:       mc.doc_base_model_id       ?? null,
      doc_reviewer_model_id:   mc.doc_reviewer_model_id   ?? null,
      modernization_base_model_id:     mc.modernization_base_model_id     ?? null,
      modernization_reviewer_model_id: mc.modernization_reviewer_model_id ?? null,
      ingestion_base_model_id:         mc.ingestion_base_model_id         ?? null,
      ingestion_reviewer_model_id:     mc.ingestion_reviewer_model_id     ?? null,
      story_vision_model_id:     mc.story_vision_model_id     ?? null,
      doc_vision_model_id:       mc.doc_vision_model_id       ?? null,
      ingestion_vision_model_id: mc.ingestion_vision_model_id ?? null,
    }),
  }, { silent: true });
  if (res.status === 401) {
    throw new Error("Your session has expired. Please log in again to save.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to update project");
  }
  return res.json();
}

export interface ConnectivityTestResult {
  success:          boolean;
  integration_type: string;
  details:          Record<string, string | null | undefined>;
}

/**
 * Test whether the supplied integration credentials can actually reach the
 * remote service.  Throws an Error (with a user-friendly message) on failure.
 */
export async function testIntegrationConnectivity(
  integration_type: "none" | "jira" | "ado" | "gitlab",
  atlassian_config?: AtlassianConfig | null,
  azure_devops_config?: AzureDevOpsConfig | null,
  gitlab_config?: GitLabConfig | null,
  project_id?: number | null,
): Promise<ConnectivityTestResult> {
  const res = await authFetch(`${API}/api/v1/projects/test-connectivity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      integration_type,
      atlassian_config:    atlassian_config    ?? null,
      azure_devops_config: azure_devops_config ?? null,
      gitlab_config:       gitlab_config       ?? null,
      ...(project_id != null ? { project_id } : {}),
    }),
  }, { silent: true });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    // A 401 with a specific integration detail (e.g. "Jira: Invalid credentials")
    // means the third-party credentials are wrong, NOT that our session expired.
    // Only treat it as session expiry when the body is generic / empty.
    if (res.status === 401) {
      const detail = err?.detail;
      if (detail && typeof detail === "string" && !detail.toLowerCase().includes("token expired")) {
        throw new Error(detail);
      }
      throw new Error("Your session has expired. Please log in again to save.");
    }
    throw new Error(err.detail ?? "Connectivity test failed");
  }
  return res.json();
}

export interface JiraLookupResult {
  projects: { key: string; name: string }[];
  spaces:   { key: string; name: string }[];
}

export interface AdoProjectsResult {
  projects: { id: string; name: string }[];
}

/**
 * Fetch all Azure DevOps projects for an org using only org URL + PAT.
 * Throws an Error with a user-friendly message on failure.
 */
export async function fetchAdoProjects(
  org_url: string,
  pat_token: string,
  project_id?: number | null,
): Promise<AdoProjectsResult> {
  const res = await authFetch(`${API}/api/v1/projects/ado-projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_url, pat_token, ...(project_id != null ? { project_id } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch Azure DevOps projects");
  }
  return res.json();
}

/**
 * Fetch Azure DevOps teams, boards and wikis accessible with the supplied
 * credentials.  Throws an Error with a user-friendly message on failure.
 */
export async function fetchAdoLookups(
  org_url: string,
  project: string,
  pat_token: string,
  project_id?: number | null,
): Promise<AdoLookupResult> {
  const res = await authFetch(`${API}/api/v1/projects/ado-lookups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_url, project, pat_token, ...(project_id != null ? { project_id } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch Azure DevOps options");
  }
  return res.json();
}

export interface AdoReposResult {
  repos: { id: string; name: string; url: string; default_branch: string }[];
}

export async function fetchAdoRepos(
  org_url: string,
  project: string,
  pat_token: string,
  project_id?: number | null,
): Promise<AdoReposResult> {
  const res = await authFetch(`${API}/api/v1/projects/ado-repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_url, project, pat_token, ...(project_id != null ? { project_id } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch Azure DevOps repositories");
  }
  return res.json();
}

/**
 * Fetch all Jira project keys and Confluence spaces accessible with the
 * supplied credentials.  Throws an Error with a user-friendly message on
 * failure (bad credentials, unreachable host, etc.).
 */
export async function fetchJiraLookups(
  jira_url: string,
  email: string,
  api_token: string,
  project_id?: number | null,
): Promise<JiraLookupResult> {
  const res = await authFetch(`${API}/api/v1/projects/jira-lookups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jira_url, email, api_token, ...(project_id != null ? { project_id } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Failed to fetch Jira options");
  }
  return res.json();
}

export interface GitLabProjectsResult {
  projects: { id: string; name: string; path: string; default_branch: string; http_url: string }[];
}

export class ApiError extends Error {
  status?: number;
  body?: any;
  constructor(message: string, status?: number, body?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Fetch all GitLab projects accessible with the supplied personal-access-token.
 * Works for gitlab.com and self-hosted instances.
 * Throws an Error with a user-friendly message on failure.
 */
export async function fetchGitLabProjects(
  gitlab_url: string,
  access_token: string,
  project_id?: number | null,
): Promise<GitLabProjectsResult> {
  const res = await authFetch(`${API}/api/v1/projects/gitlab-projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gitlab_url, access_token, ...(project_id != null ? { project_id } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(body.detail ?? "Failed to fetch GitLab projects", res.status, body);
  }
  return res.json();
}

export async function fetchGitLabBranches(
  projectId: number,
  gitUrl: string,
): Promise<{ branches: string[] }> {
  const res = await authFetch(`${API}/api/v1/projects/${projectId}/gitlab-branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ git_url: gitUrl }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(body.detail ?? "Failed to fetch GitLab branches", res.status, body);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
//  TEAMS (used by project create / edit pages)
// ═══════════════════════════════════════════════════════════════════════════

export interface TeamItem {
  id: number;
  name: string;
  description?: string;
}

/**
 * Fetch teams list. Admins get all groups, non-admins get their own groups.
 * Filters out the "Administrators" built-in group.
 */
export function useTeams(isAdmin: boolean) {
  return useQuery<TeamItem[]>({
    queryKey: queryKeys.teams(isAdmin),
    queryFn: async () => {
      const endpoint = isAdmin
        ? `${API}/api/v1/admin/groups`
        : `${API}/api/v1/me/groups`;
      const res = await authFetch(endpoint, {}, { silent: true });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.groups ?? [])
        .filter((g: { name: string }) => g.name !== "Administrators")
        .map((g: { id: number; name: string; description?: string }) => ({
          id: g.id,
          name: g.name,
          description: g.description,
        }));
    },
    staleTime: 60_000,
  });
}
