/**
 * runtimeReport — proactive client-machine environment check.
 *
 * Detects the workspace's language(s) from manifest files, asks the daemon
 * which runtimes actually exist on this machine (POST /runtimes/check), and
 * formats a short report injected into the agent's context (same transport
 * as repo_map). The agent then knows BEFORE planning commands that e.g.
 * "this is a Python project but Python is not installed" and can guide the
 * user to set it up instead of failing a build later.
 *
 * Best-effort by design: no daemon / no manifests / any error → null, and the
 * reactive runtime_missing check inside /exec still covers execution time.
 */

import { checkRuntimes } from "@/lib/fileAccess/agentClient";
import { hasRuntimeHost } from "@/lib/agent/clientTools";
import type { WsNode } from "@/lib/db/workspaceStore";

/** Manifest file → binaries the project needs. Mirrors the backend's
 *  project_scanner manifest list (context/project_scanner.py). */
const MANIFEST_RUNTIMES: [RegExp, string[]][] = [
  [/(^|\/)package\.json$/, ["node", "npm"]],
  [/(^|\/)(requirements\.txt|pyproject\.toml|setup\.py|Pipfile)$/, ["python"]],
  [/(^|\/)pom\.xml$/, ["java", "mvn"]],
  [/(^|\/)build\.gradle(\.kts)?$/, ["java", "gradle"]],
  [/(^|\/)go\.mod$/, ["go"]],
  [/(^|\/)Cargo\.toml$/, ["cargo"]],
  [/\.(csproj|fsproj|sln)$/, ["dotnet"]],
  [/(^|\/)composer\.json$/, ["php", "composer"]],
  [/(^|\/)Gemfile$/, ["ruby"]],
  [/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i, ["docker"]],
];

/** Only look at shallow paths — a manifest in node_modules/ or a vendored
 *  subtree doesn't define the project's stack. */
const MAX_MANIFEST_DEPTH = 3;
const IGNORED_SEGMENTS = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|venv|target)(\/|$)/;

/** Binaries the workspace's manifests say the project needs. */
export function detectRequiredBinaries(nodes: WsNode[]): string[] {
  const needed = new Set<string>();
  for (const n of nodes) {
    if (n.type !== "file") continue;
    if (IGNORED_SEGMENTS.test(n.path)) continue;
    if (n.path.split("/").length > MAX_MANIFEST_DEPTH) continue;
    for (const [re, bins] of MANIFEST_RUNTIMES) {
      if (re.test(n.path)) bins.forEach((b) => needed.add(b));
    }
  }
  return [...needed];
}

/**
 * Build the runtime report string for the agent's context, or null when it
 * has nothing to say (no daemon, no recognized manifests, or check failed).
 */
export async function buildRuntimeReport(wsId: number, nodes: WsNode[]): Promise<string | null> {
  if (!hasRuntimeHost(wsId)) return null; // no shell on this client — nothing to check
  const binaries = detectRequiredBinaries(nodes);
  if (binaries.length === 0) return null;
  try {
    const runtimes = await checkRuntimes(binaries);
    const lines = Object.entries(runtimes).map(([bin, s]) =>
      s.available
        ? `- ${bin}: available${s.version ? ` (${s.version})` : ""}`
        : `- ${bin}: NOT INSTALLED${s.runtime ? ` — the user needs ${s.runtime}: ${s.install}` : ""}`,
    );
    if (lines.length === 0) return null;
    return (
      "## Runtime environment (checked on the user's machine)\n" +
      "Commands run on the user's machine. Availability of the runtimes this " +
      "project's manifests require:\n" +
      lines.join("\n") +
      "\nIf a required runtime is NOT INSTALLED, tell the user how to install " +
      "it BEFORE attempting commands that need it; file reads/writes work regardless."
    );
  } catch {
    return null; // best-effort — the reactive /exec check still protects
  }
}
