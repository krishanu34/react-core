/**
 * toolManifest — the client capability manifest (Pattern C, Phase 0).
 *
 * The client declares which tools it can execute locally. The browser shell
 * sends this at session start; the orchestrator should only delegate these to
 * the client and run everything else itself (or in a server sandbox). This one
 * declaration is what makes hybrid execution and version-skew handling free —
 * a VS Code shell would advertise `run_terminal` too; the browser doesn't.
 *
 * Keep this in sync with CLIENT_TOOLS in clientTools.ts.
 */

import { CLIENT_TOOLS } from "@/lib/agent/clientTools";

export type ToolLocation = "client" | "server";

/** Where each backend-registry tool executes for the *browser* shell. */
export const TOOL_LOCATION: Record<string, ToolLocation> = {
  // Client — workspace manipulation via File System Access API
  read_file: "client",
  file_write: "client",
  code_edit: "client",
  list_directory: "client",
  workspace_tree: "client",
  file_search: "client",
  grep_search: "client",
  batch_read_files: "client",
  create_output: "client",
  notebook_edit: "client",

  // Server — needs a real OS, network, keys, or is pure orchestration.
  // NOTE: run_terminal/git are listed as "server" only as the static default —
  // when the daemon transport is connected, ChatDock advertises them as
  // client tools (hasRuntimeHost) and the daemon executes them via POST /exec.
  run_terminal: "server", // no shell in a browser; daemon overrides at runtime
  git: "server", // no git binary in a browser; daemon overrides at runtime
  web_fetch: "server", // CORS + SSRF control
  web_search: "server", // API keys
  lsp: "server", // language servers
  project_context: "server", // manifest scanner (can move client later)
  summarize_workspace: "server", // LLM call
  sub_agent: "server", // orchestration
  ask_user: "server", // protocol event
  task_manager: "server",
  remember: "server",
  update_project_memory: "server",
  monitor: "server",
};

/** The manifest payload to send to the orchestrator at session start. */
export function capabilityManifest() {
  return {
    protocol_version: 1,
    shell: "browser",
    // Tools the browser will execute when the server emits a matching tool_use.
    client_tools: Array.from(CLIENT_TOOLS),
    // Browser cannot run these; server must execute them itself.
    unsupported: Object.entries(TOOL_LOCATION)
      .filter(([, loc]) => loc === "server")
      .map(([name]) => name),
  };
}
