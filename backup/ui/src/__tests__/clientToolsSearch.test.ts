/**
 * clientTools search routing — the Pattern C half of brownfield search.
 *
 * Verifies the two-engine contract from the browser side:
 *   1. With a daemon transport, grep/glob are DELEGATED (one round trip) and
 *      every Claude-Code-parity parameter passes through intact.
 *   2. Without one (FS-API), the in-browser fallback honours the same
 *      parameters — per-file cap, survey modes, context — just slower.
 *   3. A daemon hiccup falls back instead of failing the tool call.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAccess: Record<string, unknown> = {};

vi.mock("@/lib/fileAccess", () => ({
  resolveWorkspaceFileAccess: () => mockAccess,
}));
vi.mock("@/lib/fileAccess/agentClient", () => ({
  getDaemonPlatform: () => "windows",
}));
vi.mock("@/lib/mcp/mcpClient", () => ({
  callMcpTool: vi.fn(),
  isMcpToolName: () => false,
}));

import { executeClientTool } from "@/lib/agent/clientTools";

/** A tiny brownfield workspace served from memory via the FS-API-shaped API. */
const FILES: Record<string, string> = {
  "legacy/bundle.js": Array.from({ length: 40 }, (_, i) => `function authenticate_${i}() {}`).join("\n"),
  "src/auth/service.py":
    "class AuthService:\n    def authenticate(self, user, pw):\n        # real\n        return check(user, pw)\n",
  "src/api/routes.py": "from auth.service import AuthService  # authenticate\n",
};

function useFsApiTransport() {
  for (const k of Object.keys(mockAccess)) delete mockAccess[k];
  Object.assign(mockAccess, {
    kind: "fs-api",
    scan: async () =>
      Object.keys(FILES).map((path) => ({ path, type: "file", parentPath: "" })),
    read: async (path: string) => {
      if (!(path in FILES)) throw new Error("not found");
      return FILES[path];
    },
  });
}

function useDaemonTransport(grepImpl: (...a: unknown[]) => unknown) {
  for (const k of Object.keys(mockAccess)) delete mockAccess[k];
  Object.assign(mockAccess, {
    kind: "agent",
    scan: async () => [],
    read: async () => "",
    grep: grepImpl,
    glob: vi.fn(async () => ({ files: [], sorted_by: "modification time, newest first" })),
  });
}

beforeEach(() => useFsApiTransport());

describe("grep_search routing", () => {
  it("delegates to the daemon with every parameter intact", async () => {
    const grep = vi.fn(async () => ({ matches: [], total_matches: 0, engine: "daemon" }));
    useDaemonTransport(grep);

    await executeClientTool(1, "grep_search", {
      query: "authenticate",
      file_pattern: "*.py",
      output_mode: "files_with_matches",
      context: 3,
      case_sensitive: false,
      multiline: true,
      head_limit: 20,
      offset: 5,
    });

    expect(grep).toHaveBeenCalledWith("authenticate", {
      file_pattern: "*.py",
      case_sensitive: false,
      output_mode: "files_with_matches",
      context: 3,
      multiline: true,
      head_limit: 20,
      offset: 5,
    });
  });

  it("falls back to the browser engine when the daemon call throws", async () => {
    useDaemonTransport(vi.fn(async () => { throw new Error("daemon down"); }));
    // Fallback needs real files:
    (mockAccess as { scan: unknown }).scan = async () =>
      Object.keys(FILES).map((path) => ({ path, type: "file", parentPath: "" }));
    (mockAccess as { read: unknown }).read = async (path: string) => FILES[path];

    const result = (await executeClientTool(1, "grep_search", {
      query: "authenticate",
    })) as { engine: string; total_matches: number };
    expect(result.engine).toBe("browser");
    expect(result.total_matches).toBeGreaterThan(0);
  });
});

describe("browser fallback engine", () => {
  it("caps one noisy file so real results survive", async () => {
    const result = (await executeClientTool(1, "grep_search", {
      query: "authenticate",
    })) as { matches: Array<{ file: string }> };

    const perFile: Record<string, number> = {};
    for (const m of result.matches) perFile[m.file] = (perFile[m.file] ?? 0) + 1;
    expect(perFile["legacy/bundle.js"]).toBeLessThanOrEqual(5);
    expect(perFile["src/auth/service.py"]).toBe(1);
  });

  it("files_with_matches surveys the distribution", async () => {
    const result = (await executeClientTool(1, "grep_search", {
      query: "authenticate",
      output_mode: "files_with_matches",
    })) as { files: string[]; total_files: number };
    expect(result.total_files).toBe(3);
    expect(result.files).toContain("src/auth/service.py");
  });

  it("count mode ranks hot spots first", async () => {
    const result = (await executeClientTool(1, "grep_search", {
      query: "authenticate",
      output_mode: "count",
    })) as { counts: Array<{ file: string; matches: number }> };
    expect(result.counts[0].file).toBe("legacy/bundle.js");
    expect(result.counts[0].matches).toBe(40);
  });

  it("context produces a before/after snippet with the match marked", async () => {
    const result = (await executeClientTool(1, "grep_search", {
      query: "def authenticate",
      context: 2,
    })) as { matches: Array<{ file: string; snippet?: string }> };
    const hit = result.matches.find((m) => m.file === "src/auth/service.py");
    expect(hit?.snippet).toContain("class AuthService"); // before
    expect(hit?.snippet).toContain("# real");            // after
  });
});

describe("file_search routing", () => {
  it("uses daemon glob (mtime ordering) when available", async () => {
    useDaemonTransport(vi.fn());
    await executeClientTool(1, "file_search", { pattern: "*.py" });
    // Third argument is include_ignored, defaulted to false — an omitted flag
    // must not become "search node_modules".
    expect((mockAccess as { glob: ReturnType<typeof vi.fn> }).glob)
      .toHaveBeenCalledWith("*.py", undefined, false);
  });

  it("forwards include_ignored to the daemon glob", async () => {
    // The daemon has its own scan policy (daemon/scanPolicy.js), so the opt-in
    // has to survive the client bridge. When it did not, a model asking about
    // an installed package got an empty result on daemon workspaces and an
    // answer on server ones — the same question, two different truths.
    useDaemonTransport(vi.fn());
    await executeClientTool(1, "file_search", {
      pattern: "*.js",
      path: "node_modules/express",
      include_ignored: true,
    });
    expect((mockAccess as { glob: ReturnType<typeof vi.fn> }).glob)
      .toHaveBeenCalledWith("*.js", "node_modules/express", true);
  });

  it("forwards include_ignored to the daemon grep", async () => {
    useDaemonTransport(vi.fn());
    await executeClientTool(1, "grep_search", {
      query: "createServer",
      include_ignored: true,
    });
    const [, options] = (mockAccess as { grep: ReturnType<typeof vi.fn> }).grep.mock.calls[0];
    expect(options.include_ignored).toBe(true);
  });
});
