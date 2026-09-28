// ─────────────────────────────────────────────────────────────────────────────
// API client for the Admin endpoints (/api/v1/admin/*)
// ─────────────────────────────────────────────────────────────────────────────

import { authFetch } from "./auth";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Types ─────────────────────────────────────────────────────────────────

export interface AdminRole {
  id: number;
  name: string;
  display_name: string;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  last_login: string | null;
  roles: string[];
}

export interface AdminGroup {
  id: number;
  name: string;
  description: string;
  group_type: string;
  is_active: boolean;
  roles: string[];
}

export interface GroupMember {
  id: number;
  username: string;
  email: string;
  full_name: string;
  group_role: string;
}

export interface GroupProject {
  project_id: number;
  project_name: string;
  access_level: string;
}

export interface ProjectOption {
  id: number;
  name: string;
}

export type ModelType = "chat" | "vision" | "embedding";
export type Vendor = "azure_openai" | "google_gemini" | "openai" | "anthropic" | "ollama" | "other";

export interface ModelConfig {
  id: number;
  display_name: string;
  vendor: Vendor;
  vendor_label: string;
  model_type: ModelType;
  model_type_label: string;
  model_name: string;
  endpoint_url: string | null;
  config: Record<string, unknown>;
  max_output_tokens: number | null;
  is_active: boolean;
  created_by: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProbeModel {
  model_name: string;
  model_type: "chat" | "vision" | "embedding";
  description: string;
}

export interface ProbeResponse {
  success: boolean;
  vendor: string;
  models: ProbeModel[];
  message: string;
}

// ── Users ─────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<AdminUser[]> {
  const res = await authFetch(`${API}/api/v1/admin/users?page=1&page_size=10000`);
  const d = await res.json();
  return d.users ?? [];
}

export async function createUser(body: {
  username: string;
  email: string;
  full_name: string;
  password: string;
  role: string;
  team_ids?: number[];
}): Promise<{ id: number }> {
  const res = await authFetch(`${API}/api/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.detail ?? "Failed to create user");
  }
  return res.json();
}

export async function deactivateUser(userId: number): Promise<void> {
  await authFetch(`${API}/api/v1/admin/users/${userId}`, { method: "DELETE" });
}

export async function setUserRoles(userId: number, roleIds: number[]): Promise<void> {
  await authFetch(`${API}/api/v1/admin/users/${userId}/roles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_ids: roleIds }),
  });
}

export async function getUserGroups(userId: number): Promise<{ id: number }[]> {
  const res = await authFetch(`${API}/api/v1/admin/users/${userId}/groups`);
  const d = await res.json();
  return d.groups ?? [];
}

// ── Roles ─────────────────────────────────────────────────────────────────

export async function listRoles(): Promise<AdminRole[]> {
  const res = await authFetch(`${API}/api/v1/admin/roles`);
  const d = await res.json();
  return d.roles ?? [];
}

// ── Groups ────────────────────────────────────────────────────────────────

export async function listGroups(): Promise<AdminGroup[]> {
  const res = await authFetch(`${API}/api/v1/admin/groups`);
  const d = await res.json();
  return d.groups ?? [];
}

export async function createGroup(body: {
  name: string;
  description: string;
  group_type: string;
}): Promise<{ id?: number; group?: { id: number } }> {
  const res = await authFetch(`${API}/api/v1/admin/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.detail ?? "Failed to create group");
  }
  return res.json();
}

export async function setGroupRoles(groupId: number, roleIds: number[]): Promise<void> {
  await authFetch(`${API}/api/v1/admin/groups/${groupId}/roles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_ids: roleIds }),
  });
}

export async function getGroupMembers(groupId: number): Promise<GroupMember[]> {
  const res = await authFetch(`${API}/api/v1/admin/groups/${groupId}/members`);
  const d = await res.json();
  return d.members ?? [];
}

export async function addGroupMember(groupId: number, userId: number, role: string): Promise<void> {
  await authFetch(`${API}/api/v1/admin/groups/${groupId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, role }),
  });
}

export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  await authFetch(`${API}/api/v1/admin/groups/${groupId}/members/${userId}`, { method: "DELETE" });
}

export async function getGroupProjects(groupId: number): Promise<GroupProject[]> {
  const res = await authFetch(`${API}/api/v1/admin/groups/${groupId}/projects`);
  const d = await res.json();
  return d.projects ?? [];
}

export async function addGroupProject(groupId: number, projectId: number, accessLevel: string): Promise<void> {
  await authFetch(`${API}/api/v1/admin/groups/${groupId}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, access_level: accessLevel }),
  });
}

export async function removeGroupProject(groupId: number, projectId: number): Promise<void> {
  await authFetch(`${API}/api/v1/admin/groups/${groupId}/projects/${projectId}`, { method: "DELETE" });
}

// ── Projects (non-admin endpoint, used by groups page) ────────────────────

export async function listAllProjects(): Promise<ProjectOption[]> {
  const res = await authFetch(`${API}/api/v1/projects`);
  const d = await res.json();
  const arr = d.projects ?? d ?? [];
  return arr.map((p: { id: number; name: string }) => ({ id: p.id, name: p.name }));
}

// ── Models ────────────────────────────────────────────────────────────────

export async function listModels(): Promise<ModelConfig[]> {
  const res = await authFetch(`${API}/api/v1/admin/models`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function testModel(body: Record<string, unknown>): Promise<{ success: boolean; message?: string; response_preview?: string }> {
  const res = await authFetch(`${API}/api/v1/admin/models/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function createModel(body: Record<string, unknown>): Promise<void> {
  const res = await authFetch(`${API}/api/v1/admin/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.detail ?? "Save failed");
  }
}

export async function updateModel(id: number, body: Record<string, unknown>): Promise<void> {
  const res = await authFetch(`${API}/api/v1/admin/models/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.detail ?? "Update failed");
  }
}

export async function probeOllama(endpointUrl: string): Promise<ProbeResponse> {
  const res = await authFetch(`${API}/api/v1/admin/models/probe/ollama`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint_url: endpointUrl }),
  });
  return res.json();
}

export async function toggleModelActive(id: number, isActive: boolean): Promise<void> {
  await authFetch(`${API}/api/v1/admin/models/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_active: isActive }),
  });
}

export async function deleteModel(id: number): Promise<void> {
  await authFetch(`${API}/api/v1/admin/models/${id}`, { method: "DELETE" });
}
