/**
 * devsphere-models-api — models, teams, quotas and token usage.
 *
 * Talks to DevSphere's OWN backend through the /devsphere-api proxy, NOT to
 * the legacy DevAccel platform that `admin-api.ts` calls. That distinction is
 * the point of this file: the model list in `admin-api.ts` belongs to another
 * service and has no bearing on which model an agent run actually uses, which
 * is why the chat's model dropdown was informational only.
 *
 * The proxy maps /devsphere-api/<path> to <backend>/api/<path>.
 */

import { authFetch } from "./auth";

const BASE = "/devsphere-api";

// ── Types ─────────────────────────────────────────────────────────────────

export type ModelTier = "fast" | "balanced" | "deep";

/** A model as the CALLER sees it — no endpoint, no key env var. */
export interface AllowedModel {
  id: number;
  key: string;
  display_name: string;
  provider: string;
  model_name: string;
  context_window: number;
  max_output_tokens: number;
  supports_vision: boolean;
  tier: ModelTier;
  is_default: boolean;
}

export interface MyModels {
  models: AllowedModel[];
  default_key: string | null;
  /** "database" once an admin has configured models; "env" before that, when
   *  every run uses the backend's .env deployment and there is nothing to pick. */
  source: "database" | "env";
}

/** A model as an ADMIN sees it — the full row, including where its key lives. */
export interface AdminModel extends AllowedModel {
  endpoint_url: string | null;
  api_version: string | null;
  /** Whether a key is stored on the row. The key itself is write-only —
   *  the API never returns it, so a live credential never reaches the
   *  browser, its cache, or a screenshot of this page. */
  api_key_set: boolean;
  /** Last 4 characters, enough to tell two keys apart. */
  api_key_hint: string | null;
  supports_temperature: boolean;
  tokens_param: "max_tokens" | "max_completion_tokens";
  input_cost_per_1m: string | number;
  cached_input_cost_per_1m: string | number;
  output_cost_per_1m: string | number;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface UsageWindow {
  used: number;
  limit: number | null;
  pct: number | null;
  cost_usd: number;
  cached_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  request_count: number;
}

export type QuotaLevel = "ok" | "warn" | "critical" | "exceeded" | "blocked";

export interface QuotaStatus {
  has_quota: boolean;
  scope: string | null;
  level: QuotaLevel;
  message: string;
  day: UsageWindow;
  month: UsageWindow;
  per_run_limit: number | null;
  warn_pct: number | null;
  critical_pct: number | null;
}

export interface ModelUsageRow {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  request_count: number;
}

export interface MyUsage {
  quota: QuotaStatus;
  by_model: ModelUsageRow[];
  daily: { date: string; total_tokens: number; cached_tokens: number; cost_usd: number; request_count: number }[];
}

export interface Team {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  member_count: number;
}

export interface TeamMember {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  role_in_team: string;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  last_login: string | null;
}

export type SubjectType = "global" | "role" | "team" | "user";

export interface AccessPolicy {
  id: number;
  subject_type: SubjectType;
  subject_ref: string;
  model_config_id: number;
  is_default_for_subject: boolean;
  model_key: string;
  display_name: string;
}

export interface Quota {
  id: number;
  subject_type: SubjectType;
  subject_ref: string;
  daily_token_limit: number | null;
  monthly_token_limit: number | null;
  per_run_token_limit: number | null;
  warn_pct: number;
  critical_pct: number;
  degrade_model_config_id: number | null;
  degrade_model_key: string | null;
  degrade_model_name: string | null;
  hard_block_tokens: number | null;
  is_active: boolean;
}

export interface AdminUsage {
  window: string;
  by_user: (ModelUsageRow & { user_id: number; username: string; email: string; role: string })[];
  by_team: (ModelUsageRow & { team_id: number; name: string; member_count: number })[];
  by_model: ModelUsageRow[];
}

// ── Fetch helpers ─────────────────────────────────────────────────────────

async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await authFetch(`${BASE}${path}`, {}, { silent: true });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    // Usage and model panels are ambient UI. A failure here must never take
    // down the view that hosts them — it just shows nothing.
    return fallback;
  }
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${method} ${path} failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data?.detail === "string") detail = data.detail;
      // The proxy reports its own failures as {detail, error}, where `detail`
      // is the generic "DevSphere AI proxy failed" and `error` is the actual
      // cause. Showing only `detail` made a real bug (204 responses crashing
      // the proxy) look like an unexplained network blip, so append it.
      if (typeof data?.error === "string" && data.error) detail += ` — ${data.error}`;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// ── Caller-facing ─────────────────────────────────────────────────────────

const NO_MODELS: MyModels = { models: [], default_key: null, source: "env" };

/** The models this user may run on. */
export function fetchMyModels(): Promise<MyModels> {
  return get<MyModels>("/agent/models", NO_MODELS);
}

/** This user's own spend and budget standing. */
export function fetchMyUsage(days = 30): Promise<MyUsage | null> {
  return get<MyUsage | null>(`/agent/usage/me/summary?days=${days}`, null);
}

// ── Admin: models ─────────────────────────────────────────────────────────

export const fetchAdminModels = () => get<AdminModel[]>("/admin/models", []);
export const createModel = (body: Partial<AdminModel>) => send<AdminModel>("/admin/models", "POST", body);
export const updateModel = (id: number, body: Partial<AdminModel>) =>
  send<AdminModel>(`/admin/models/${id}`, "PUT", body);
export const deleteModel = (id: number) => send<void>(`/admin/models/${id}`, "DELETE");

/** Send one real completion through a model's saved configuration. */
export const testModel = (id: number) =>
  send<{ success: boolean; message: string; response_preview?: string }>(
    `/admin/models/${id}/test`,
    "POST",
  );

// ── Admin: teams ──────────────────────────────────────────────────────────

export const fetchTeams = () => get<Team[]>("/admin/teams", []);
export const createTeam = (body: { name: string; description?: string }) =>
  send<Team>("/admin/teams", "POST", body);
export const deleteTeam = (id: number) => send<void>(`/admin/teams/${id}`, "DELETE");
export const fetchTeamMembers = (id: number) => get<TeamMember[]>(`/admin/teams/${id}/members`, []);
export const addTeamMember = (teamId: number, userId: number, roleInTeam = "member") =>
  send<void>(`/admin/teams/${teamId}/members`, "POST", { user_id: userId, role_in_team: roleInTeam });
export const removeTeamMember = (teamId: number, userId: number) =>
  send<void>(`/admin/teams/${teamId}/members/${userId}`, "DELETE");
export const fetchAdminUsers = () => get<AdminUser[]>("/admin/users", []);

// ── Admin: access policies ────────────────────────────────────────────────

export const fetchPolicies = () => get<AccessPolicy[]>("/admin/model-access", []);
export const createPolicy = (body: {
  subject_type: SubjectType;
  subject_ref: string;
  model_config_id: number;
  is_default_for_subject?: boolean;
}) => send<AccessPolicy>("/admin/model-access", "POST", body);
export const deletePolicy = (id: number) => send<void>(`/admin/model-access/${id}`, "DELETE");

// ── Admin: quotas ─────────────────────────────────────────────────────────

export const fetchQuotas = () => get<Quota[]>("/admin/quotas", []);
export const upsertQuota = (body: Partial<Quota> & { subject_type: SubjectType; subject_ref: string }) =>
  send<Quota>("/admin/quotas", "POST", body);
export const deleteQuota = (id: number) => send<void>(`/admin/quotas/${id}`, "DELETE");

export const fetchAdminUsage = (window = "month") =>
  get<AdminUsage | null>(`/admin/usage?window=${window}`, null);

// ── Formatting ────────────────────────────────────────────────────────────

/** Compact token count: 1234 → "1.2k", 2400000 → "2.4M". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Sub-cent costs are common per request, so don't round them to "$0.00". */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
