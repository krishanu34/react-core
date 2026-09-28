/**
 * API client for Code Intelligence endpoints.
 * Talks to the Code Builder backend at /cb-api/api/code-intel/*
 */

import type {
  CIAnalysisResult,
  CIGraphSummary,
  CIEntityNode,
  CISearchResult,
} from "@/types/code-intelligence";

const BASE = process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL
  ? `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL}/api`
  : "/cb-api";

/* ── helpers ───────────────────────────────────────────── */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) message = parsed.error;
      else if (parsed.detail) message = parsed.detail;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.json();
}

/* ── Analysis ──────────────────────────────────────────── */

export async function analyzeZip(
  file: File,
  options?: { projectId?: number; contextSize?: number; resume?: boolean }
): Promise<CIAnalysisResult> {
  const form = new FormData();
  form.append("file", file);
  if (options?.projectId != null) form.append("project_id", String(options.projectId));
  if (options?.contextSize != null) form.append("context_size", String(options.contextSize));
  if (options?.resume != null) form.append("resume", String(options.resume));

  const res = await fetch(`${BASE}/api/code-intel/analyze`, {
    method: "POST",
    body: form,
  });
  return json(res);
}

/* ── Graph ─────────────────────────────────────────────── */

export async function getGraphSummary(): Promise<CIGraphSummary> {
  return json(await fetch(`${BASE}/api/code-intel/graph/summary`));
}

export async function getGraphEntities(options?: {
  layer?: string;
  filePath?: string;
}): Promise<{ entities: CIEntityNode[] }> {
  const params = new URLSearchParams();
  if (options?.layer) params.set("layer", options.layer);
  if (options?.filePath) params.set("file_path", options.filePath);
  const qs = params.toString();
  return json(await fetch(`${BASE}/api/code-intel/graph/entities${qs ? `?${qs}` : ""}`));
}

/* ── Semantic Search ───────────────────────────────────── */

export async function searchCode(
  query: string,
  options?: { projectName?: string; nodeType?: string; topK?: number }
): Promise<{ results: CISearchResult[] }> {
  const res = await fetch(`${BASE}/api/code-intel/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      project_name: options?.projectName,
      node_type: options?.nodeType,
      top_k: options?.topK ?? 10,
    }),
  });
  return json(res);
}

/* ── Agent WebSocket ───────────────────────────────────── */

export function connectAgent(
  request: string,
  callbacks: {
    onEvent: (event: { type: string; data?: Record<string, unknown> }) => void;
    onDone: (result: Record<string, unknown>) => void;
    onError: (error: string) => void;
  },
  options?: { projectId?: number; zipPath?: string }
): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}${BASE}/ws/code-intel/agent`);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        request,
        project_id: options?.projectId,
        zip_path: options?.zipPath,
      })
    );
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "done") {
        callbacks.onDone(msg.data ?? {});
      } else if (msg.type === "error") {
        callbacks.onError(msg.message || msg.data?.message || "Unknown error");
      } else if (msg.type === "result") {
        callbacks.onDone(msg.data ?? {});
      } else {
        callbacks.onEvent(msg);
      }
    } catch {
      /* ignore parse errors */
    }
  };

  ws.onerror = () => {
    callbacks.onError("WebSocket connection error");
  };

  ws.onclose = () => {
    /* auto-cleanup */
  };

  return ws;
}
