/// <reference types="vitest/globals" />
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Executes the previously "read-only" hop: the Next.js proxy route that
 * forwards same-origin /workspace-api/* → the Workspace Studio backend.
 * global.fetch is mocked so we can assert the exact rewritten target URL,
 * forwarded headers/body, and that the upstream response is relayed back.
 */
import { POST } from "@/app/workspace-api/[...path]/route";

function makeRequest(opts: {
  method?: string;
  search?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const { method = "POST", search = "", headers = {}, body } = opts;
  return {
    method,
    headers: new Headers(headers),
    nextUrl: { search },
    arrayBuffer: async () =>
      body ? new TextEncoder().encode(body).buffer : new ArrayBuffer(0),
  } as unknown as import("next/server").NextRequest;
}

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe("workspace-api proxy route — real forwarding hop", () => {
  const realFetch = global.fetch;
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.WORKSPACE_STUDIO_API_URL;
  });

  it("rewrites /workspace-api/workspaces/123/sync → {backend}/api/workspaces/123/sync and relays the response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "synced", sync_version: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock as typeof global.fetch;

    const req = makeRequest({
      method: "POST",
      search: "?project_id=1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
        host: "localhost:3000",
        connection: "keep-alive",
      },
      body: JSON.stringify({ client_id: "c1", batch_id: "b1", operations: [] }),
    });

    const res = await POST(req, ctx(["workspaces", "123", "sync"]));

    // ── Forwarded to the correct rewritten target (default backend base) ──
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe("http://127.0.0.1:8003/api/workspaces/123/sync?project_id=1");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");

    // ── Hop-by-hop headers stripped, auth + body forwarded ──
    const fwd = init.headers as Headers;
    expect(fwd.get("authorization")).toBe("Bearer tok");
    expect(fwd.get("host")).toBeNull();
    expect(fwd.get("connection")).toBeNull();
    const sentBody = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(JSON.parse(sentBody)).toMatchObject({ client_id: "c1", batch_id: "b1" });

    // ── Upstream response relayed back to the browser unchanged ──
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "synced", sync_version: 3 });
  });

  it("honors WORKSPACE_STUDIO_API_URL and normalizes localhost + trailing /api", async () => {
    process.env.WORKSPACE_STUDIO_API_URL = "http://localhost:9999/api";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as typeof global.fetch;

    await POST(makeRequest({ body: "{}" }), ctx(["workspaces", "5", "sync"]));

    const [target] = fetchMock.mock.calls[0] as unknown as [URL];
    // localhost → 127.0.0.1, trailing /api stripped, then /api/... re-appended.
    expect(target.toString()).toBe("http://127.0.0.1:9999/api/workspaces/5/sync");
  });

  it("returns 502 when the backend is unreachable", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as typeof global.fetch;

    const res = await POST(makeRequest({ body: "{}" }), ctx(["workspaces", "1", "sync"]));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ detail: "Workspace Studio proxy failed" });
  });
});
