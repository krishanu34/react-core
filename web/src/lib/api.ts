/**
 * Typed HTTP client for the react-core backend.
 *
 * Backend URL resolution (runtime, in this order):
 *   1. `window.__ENV__.API_BASE_URL` — injected by the server-rendered root
 *      layout on every request. Reads `process.env.API_BASE_URL` at request
 *      time so `docker run -e API_BASE_URL=…` takes effect immediately
 *      with no rebuild.
 *   2. `http://localhost:8080` — dev fallback for SSR before the client
 *      hydrates, and for any hand-rolled Node script.
 *
 * Multi-worker note: the backend today keeps `ask_user` futures and stop
 * flags in per-process memory. In production this deploys behind an LB
 * that hashes on thread_id (see docs) so every request for a thread hits
 * the same worker. We help that by always passing `thread_id` as a query
 * param — nginx `hash $arg_thread_id consistent;` covers it.
 */

import { parseSseStream, type AgentEvent } from "./sse";

function resolveBaseUrl(): string {
  if (typeof window !== "undefined") {
    const runtime = window.__ENV__?.API_BASE_URL?.trim();
    if (runtime) return runtime.replace(/\/+$/, "");
  }
  return "http://localhost:8080";
}

function apiUrl(path: string, threadId?: string | null): string {
  const url = new URL(path, resolveBaseUrl());
  if (threadId) url.searchParams.set("thread_id", threadId);
  return url.toString();
}

export { apiUrl };

export interface StreamAgentInput {
  message: string;
  threadId?: string | null;
  files?: File[];
  workspacePath?: string;
  projectId?: string | null;
  maxSteps?: number;
  signal?: AbortSignal;
}

export async function* streamAgent(
  input: StreamAgentInput,
): AsyncGenerator<AgentEvent, void, void> {
  const form = new FormData();
  form.append("message", input.message);
  if (input.threadId) form.append("thread_id", input.threadId);
  if (input.workspacePath) form.append("workspace_path", input.workspacePath);
  if (input.projectId) form.append("project_id", input.projectId);
  if (input.maxSteps != null) form.append("max_steps", String(input.maxSteps));
  for (const f of input.files ?? []) form.append("files", f, f.name);

  const res = await fetch(apiUrl("/api/agent/stream", input.threadId), {
    method: "POST",
    body: form,
    signal: input.signal,
    // Explicit: SSE is text/event-stream; no transformation from fetch.
    headers: { Accept: "text/event-stream" },
  });

  if (!res.ok || !res.body) {
    const detail = await safeReadText(res);
    throw new Error(
      `stream request failed: ${res.status} ${res.statusText}${
        detail ? ` — ${detail}` : ""
      }`,
    );
  }

  yield* parseSseStream(res.body, input.signal);
}

export async function stopAgent(threadId: string): Promise<void> {
  const res = await fetch(apiUrl("/api/agent/stop", threadId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId }),
  });
  if (!res.ok) {
    throw new Error(`stop failed: ${res.status} ${res.statusText}`);
  }
}

export async function answerAgent(
  threadId: string,
  callId: string,
  answer: string,
): Promise<void> {
  const res = await fetch(apiUrl("/api/agent/answer", threadId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thread_id: threadId,
      call_id: callId,
      answer,
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      `answer failed: ${res.status} ${res.statusText}${
        detail ? ` — ${detail}` : ""
      }`,
    );
  }
}

export interface HistoryResponse {
  thread_id: string;
  workspace_path: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string; ts?: number }>;
}

export async function fetchHistory(
  threadId: string,
): Promise<HistoryResponse | null> {
  const res = await fetch(apiUrl(`/api/agent/history/${threadId}`, threadId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`history failed: ${res.status}`);
  return (await res.json()) as HistoryResponse;
}

export function debugDownloadUrl(threadId: string): string {
  return apiUrl(`/api/agent/debug/${threadId}`, threadId);
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(apiUrl("/api/projects"));
  if (!res.ok) throw new Error(`list projects failed: ${res.status}`);
  return (await res.json()) as Project[];
}

export async function createProject(
  name: string,
  description?: string,
): Promise<Project> {
  const res = await fetch(apiUrl("/api/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: description ?? null }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(`create project failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return (await res.json()) as Project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/projects/${projectId}`), { method: "DELETE" });
  if (!res.ok) throw new Error(`delete project failed: ${res.status}`);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "";
  }
}
