/**
 * What the browser is allowed to put in a stream request's tool policy.
 *
 * The failure this guards against was total and immediate: the chat UI began
 * sending its `ALL_TOOLS` constant as `allow_tools` on every request. That
 * constant is a hand-maintained mirror of the backend registry, so every tool
 * missing from it — `skill`, `checkpoint`, `restore_context`, `resume_agent`,
 * `submit_plan`, and every `mcp__*` tool an MCP server adds at runtime — was
 * denied with "not in allow list" before the agent could take a single step.
 *
 * The lesson is about DIRECTION, not about that one constant. A whitelist is
 * only safe when the sender knows the complete set; a client never does. A
 * blocklist can only ever affect what it names, so it stays correct as the
 * registry grows. Hence: the browser sends `deny_tools` and never
 * `allow_tools`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { streamAgent } from "@/lib/devsphere-agent-api";

function emptySseResponse() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

let fetchMock: ReturnType<typeof vi.fn<unknown[], Promise<Response>>>;

beforeEach(() => {
  fetchMock = vi.fn<unknown[], Promise<Response>>(async () => emptySseResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentForm(): FormData {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return init.body as FormData;
}

describe("stream request tool policy", () => {
  it("omits allow_tools when the caller does not set it", async () => {
    await streamAgent({ message: "hi", onEvent: () => {} });
    expect(sentForm().get("allow_tools")).toBeNull();
  });

  it("omits allow_tools for an empty list rather than sending an empty string", async () => {
    // An empty `allow_tools=` would be indistinguishable from "allow nothing"
    // to a naive parser, so it must not be sent at all.
    await streamAgent({ message: "hi", allowTools: [], onEvent: () => {} });
    expect(sentForm().get("allow_tools")).toBeNull();
  });

  it("sends deny_tools when tools are blocked", async () => {
    // The drift-safe direction: naming run_terminal blocks run_terminal and
    // affects nothing else, however many tools the registry gains later.
    await streamAgent({
      message: "hi",
      denyTools: ["run_terminal", "git"],
      onEvent: () => {},
    });
    expect(sentForm().get("deny_tools")).toBe("run_terminal,git");
  });

  it("defaults permission_mode to manual", async () => {
    await streamAgent({ message: "hi", onEvent: () => {} });
    expect(sentForm().get("permission_mode")).toBe("manual");
  });
});

describe("the chat UI never sends a tool whitelist", () => {
  it("has no allowTools call site in ChatDock", async () => {
    // Asserted against the source, because the behaviour is an ABSENCE — there
    // is no request to inspect for something that was never added. A rendered
    // test would pass just as happily with the bug reintroduced under a
    // different condition.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(process.cwd(), "src/components/ide/ChatDock.tsx"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("allowTools:");
  });
});
