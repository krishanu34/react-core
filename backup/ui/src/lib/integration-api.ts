/**
 * src/lib/integration-api.ts
 * API client for the DevAccel integration handoff flow.
 */

const API_BASE = "/devsphere-api";

export class IntegrationError extends Error {
  public statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "IntegrationError";
  }
}

export interface HandoffResponse {
  access_token: string;
  token_type: string;
  launch_mode: "integrated";
  project_context: {
    project_id: number;
    project_name: string;
  };
  handoff_token_hash: string;
}

export interface DevAccelContext {
  auth_context: {
    user_id: number;
    username: string;
    roles: string[];
    permissions: string[];
  };
  project_context: {
    project_id: number;
    project_name: string;
    environment: Record<string, string>;
  };
  models: Array<{
    model_id: string;
    provider: string;
    deployment_name: string;
    endpoint: string;
    api_version: string | null;
    capabilities: string[];
  }>;
  connectors: {
    jira: object | null;
    ado: object | null;
    git: object | null;
  };
}

/**
 * Exchange a DevAccel handoff token for a Workspace Studio session token.
 */
export async function exchangeHandoffToken(handoffToken: string): Promise<HandoffResponse> {
  const resp = await fetch(`${API_BASE}/integration/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff_token: handoffToken }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    let detail: string;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {
      detail = body;
    }
    throw new IntegrationError(resp.status, detail);
  }

  return resp.json();
}

/**
 * Fetch the cached DevAccel context for the current integrated session.
 */
export async function fetchDevAccelContext(sessionToken: string): Promise<DevAccelContext> {
  const resp = await fetch(`${API_BASE}/integration/context`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    let detail: string;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {
      detail = body;
    }
    throw new IntegrationError(resp.status, detail);
  }

  return resp.json();
}
