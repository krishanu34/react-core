import { apiUrl } from "./api";

export type Provider = "jira" | "confluence";

export interface CredentialSummary {
  id: string;
  provider: Provider;
  base_url: string;
  email: string | null;
  auth_type: "basic" | "pat" | "bearer";
  token_masked: string;
  updated_at: string;
}

export interface CredentialInput {
  provider: Provider;
  base_url: string;
  token: string;
  email?: string | null;
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const res = await fetch(apiUrl("/api/settings/credentials"));
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return (await res.json()) as CredentialSummary[];
}

export async function upsertCredential(
  input: CredentialInput,
): Promise<CredentialSummary> {
  const res = await fetch(apiUrl("/api/settings/credentials"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: input.provider,
      base_url: input.base_url,
      token: input.token,
      email: input.email ?? null,
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      `save failed: ${res.status}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return (await res.json()) as CredentialSummary;
}

export async function deleteCredential(provider: Provider): Promise<void> {
  const res = await fetch(apiUrl(`/api/settings/credentials/${provider}`), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete failed: ${res.status}`);
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
