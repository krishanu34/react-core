/**
 * fileAccess.test.ts — client transport-agnostic file access.
 *
 * Verifies the daemon-backed adapter (AgentFileAccess) issues the correct
 * requests and that the capability ladder detects the daemon. `fetch` is mocked
 * so no real daemon is needed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Route a mocked daemon response by URL + method. */
function mockDaemon() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const json = (obj: unknown) =>
      ({ ok: true, status: 200, json: async () => obj }) as unknown as Response;

    if (url.endsWith("/health")) return json({ ok: true, name: "devaccel-daemon", version: "0.1.0" });
    if (url.endsWith("/pair")) return json({ token: "test-token", name: "devaccel-daemon" });
    if (url.includes("/fs/open")) return json({ rootId: "root-123", root: "C:/work/app" });
    if (url.includes("/fs/write")) return json({ ok: true });
    if (url.includes("/fs/read")) return json({ content: "file-contents" });
    if (url.includes("/fs/scan")) return json({ nodes: [{ path: "a.ts", type: "file", parentPath: "" }] });
    if (url.includes("/fs/pick-folder")) return json({ path: "C:/picked/folder" });
    return json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

describe("fileAccess capability ladder", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });

  it("detects the daemon via /health probe", async () => {
    mockDaemon();
    const { getCapability } = await import("@/lib/fileAccess");
    const cap = await getCapability();
    expect(cap.agent).toBe(true);
    // jsdom has no showDirectoryPicker, so the FS API is reported unavailable.
    expect(cap.fsApi).toBe(false);
  });

  it("reports agent:false when nothing answers the probe", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    vi.stubGlobal("fetch", fetchMock);
    const { getCapability } = await import("@/lib/fileAccess");
    const cap = await getCapability();
    expect(cap.agent).toBe(false);
  });
});

describe("AgentFileAccess (daemon adapter)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });

  it("open() registers the root and write/read/scan hit the daemon with the rootId", async () => {
    const { calls } = mockDaemon();
    const { openAgentRoot } = await import("@/lib/fileAccess");

    const fa = await openAgentRoot("C:/work/app", true);
    expect(fa.kind).toBe("agent");
    expect(fa.rootLabel).toBe("C:/work/app");

    // open sent create:true
    const openCall = calls.find((c) => c.url.includes("/fs/open"));
    expect(openCall?.body).toMatchObject({ root: "C:/work/app", create: true });

    await fa.write("src/main.ts", "hello");
    const writeCall = calls.find((c) => c.url.includes("/fs/write"));
    expect(writeCall?.method).toBe("PUT");
    expect(writeCall?.body).toMatchObject({ rootId: "root-123", path: "src/main.ts", content: "hello" });

    const content = await fa.read("src/main.ts");
    expect(content).toBe("file-contents");

    const nodes = await fa.scan();
    expect(nodes).toEqual([{ path: "a.ts", type: "file", parentPath: "" }]);
  });

  it("sends the pairing token on authed requests", async () => {
    mockDaemon();
    const authHeaders: string[] = [];
    const orig = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) authHeaders.push(auth);
      return orig(url, init);
    }));
    const { openAgentRoot } = await import("@/lib/fileAccess");
    const fa = await openAgentRoot("C:/work/app");
    await fa.write("f.txt", "x");
    expect(authHeaders.some((h) => h === "Bearer test-token")).toBe(true);
  });

  it("pickFolder() returns the daemon-selected absolute path", async () => {
    mockDaemon();
    const { agentClient } = await import("@/lib/fileAccess");
    const picked = await agentClient.pickFolder();
    expect(picked).toBe("C:/picked/folder");
  });
});
