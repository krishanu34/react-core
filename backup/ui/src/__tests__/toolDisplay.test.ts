/**
 * toolDisplay — what the chat timeline is allowed to say about a tool call.
 *
 * The interesting rule here is the one about HIDING. `skill` loads prompt
 * material the backend chose for itself; surfacing it names an internal file
 * and implies the user picked it. Everything that touches the user's files,
 * machine or network must stay visible — the timeline is how they audit what
 * the agent did to their code, so the hidden set has to stay a short,
 * deliberate list rather than growing into "tools we'd rather not explain".
 */

import { describe, it, expect } from "vitest";
import { isInternalTool, toolLabel, toolTarget } from "@/lib/agent/toolDisplay";

describe("isInternalTool", () => {
  it("hides the agent's own prompt machinery", () => {
    expect(isInternalTool("skill")).toBe(true);
  });

  it("never hides a tool that touches the user's files, machine or the network", () => {
    for (const tool of [
      "read_file", "file_write", "code_edit", "notebook_edit", "create_output",
      "update_project_memory", "run_terminal", "git", "web_fetch", "web_search",
      "grep_search", "file_search", "list_directory", "workspace_tree",
      "batch_read_files", "sub_agent", "ask_user",
    ]) {
      expect(isInternalTool(tool), `${tool} must stay visible`).toBe(false);
    }
  });

  it("does not hide unknown or MCP tools", () => {
    // An unrecognised tool is somebody's real work, not our machinery — a
    // default-hide here would silently swallow every new and MCP-provided tool.
    expect(isInternalTool("mcp__filesystem__read_file")).toBe(false);
    expect(isInternalTool("some_future_tool")).toBe(false);
  });
});

describe("toolLabel / toolTarget", () => {
  it("labels edits the way Claude Code does", () => {
    expect(toolLabel("code_edit")).toBe("Edit");
    expect(toolTarget("code_edit", { path: "src/auth.py" })).toBe("src/auth.py");
  });

  it("shows an MCP tool by its server and name, never the wire name", () => {
    expect(toolLabel("mcp__filesystem__list_dirs")).toBe("filesystem: list_dirs");
  });
});
