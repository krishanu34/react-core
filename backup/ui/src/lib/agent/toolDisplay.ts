/**
 * toolDisplay — Claude-Code-style presentation for agent tool calls.
 *
 * Pure helpers (no React) that turn a raw tool name + its JSON result string
 * into the friendly label and one-line result summary Claude Code shows next to
 * each step (e.g. "Read · 42 lines", "Search · 3 matches", "Edit · +5 −2").
 *
 * Icons live in the component (ChatDock) since they're lucide React elements;
 * everything text-based lives here so it stays testable.
 */

/* Friendly display names — matches how Claude Code labels its tools. */
const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  batch_read_files: "Read",
  file_write: "Write",
  create_output: "Create",
  code_edit: "Edit",
  notebook_edit: "Notebook",
  grep_search: "Search",
  file_search: "Glob",
  list_directory: "List",
  workspace_tree: "Files",
  // server-side
  run_terminal: "Bash",
  git: "Git",
  web_fetch: "Fetch",
  web_search: "Web Search",
  lsp: "Symbols",
  sub_agent: "Agent",
  ask_user: "Ask",
  project_context: "Project",
  task_manager: "Todos",
  remember: "Remember",
  update_project_memory: "Memory",
  summarize_workspace: "Summarize",
  monitor: "Monitor",
};

/**
 * Tools that are the agent's own machinery, not work the user asked for.
 *
 * `skill` loads one catalog entry's instructions into the model's context. It
 * is the same class of thing as the `skills_loaded` chips the message renderer
 * already suppresses (see ChatDock): prompt material the backend selects for
 * itself. The user asked a question — they did not ask for "python_backend" —
 * so a row naming an internal file leaks implementation detail while implying
 * they chose it. Claude Code doesn't narrate its own prompt assembly either.
 *
 * Hidden means hidden from the CHAT TIMELINE only. The call still runs, still
 * streams, still counts as a tool call, and is still carried on the run for
 * debugging/analytics — and `skill` stays in the block picker, so anyone who
 * wants it off can still turn it off. This is presentation, never capability.
 *
 * Add a tool here only if seeing it would tell the user nothing about their own
 * request. Anything that touches their files, their machine or the network must
 * stay visible — that is what the timeline is for.
 */
const INTERNAL_TOOLS = new Set<string>(["skill"]);

export function isInternalTool(tool: string): boolean {
  return INTERNAL_TOOLS.has(tool);
}

/** Split an internal mcp__<server>__<tool> name into its parts (tool may itself
 *  contain "__"). Returns null for non-MCP names. */
export function parseMcpTool(tool: string): { server: string; name: string } | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice("mcp__".length);
  const i = rest.indexOf("__");
  if (i <= 0) return null;
  return { server: rest.slice(0, i), name: rest.slice(i + 2) };
}

export function toolLabel(tool: string): string {
  // External MCP tools: show the user-defined server name + the tool, never the
  // raw mcp__server__tool wire name (Claude Code's presentation). The internal
  // name stays mcp__… everywhere routing/permissions need it — this is display
  // only. e.g. mcp__filesystem__list_allowed_directories → "filesystem: list_allowed_directories"
  const mcp = parseMcpTool(tool);
  if (mcp) return `${mcp.server}: ${mcp.name}`;
  return TOOL_LABELS[tool] ?? tool;
}

/** The primary argument to show inline after the label (path, query, command). */
export function toolTarget(tool: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  // MCP tools have server-specific args — show the first meaningful string
  // value (path, query, url, …) so the row still says what it's acting on.
  if (parseMcpTool(tool)) {
    const pref = s(input.path) ?? s(input.query) ?? s(input.url) ?? s(input.name);
    if (pref) return pref;
    const first = Object.values(input).find((v) => typeof v === "string" && v.length <= 120);
    return (first as string) ?? null;
  }
  switch (tool) {
    case "read_file":
    case "file_write":
    case "code_edit":
    case "notebook_edit":
      return s(input.path);
    case "create_output":
      return s(input.filename) ?? s(input.path);
    case "grep_search":
      return s(input.query);
    case "file_search":
      return s(input.pattern);
    case "list_directory":
    case "workspace_tree":
      return s(input.path) ?? ".";
    case "run_terminal":
      return s(input.command);
    case "batch_read_files":
      return Array.isArray(input.paths) ? `${input.paths.length} files` : null;
    default:
      return s(input.path) ?? s(input.query) ?? null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Parse a tool's JSON result string into the short summary badge shown on the
 * row header. Returns null when there's nothing meaningful (or on parse error),
 * in which case the row just shows no badge.
 */
export function toolResultSummary(
  tool: string,
  observation: string | null | undefined,
): string | null {
  if (!observation) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(observation);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.error) return null;

  const n = (v: unknown) => (typeof v === "number" ? v : null);
  const plural = (c: number, word: string) => `${c} ${word}${c === 1 ? "" : "s"}`;

  switch (tool) {
    case "read_file": {
      if (data.binary) return "binary";
      const total = n(data.total_lines);
      return total != null ? plural(total, "line") : null;
    }
    case "batch_read_files": {
      const c = n(data.count);
      return c != null ? plural(c, "file") : null;
    }
    case "file_write": {
      const b = n(data.bytes);
      return b != null ? `${formatBytes(b)} written` : "written";
    }
    case "create_output":
      return "created";
    case "code_edit": {
      const r = n(data.replacements);
      const diff = typeof data.diff === "string" ? data.diff : "";
      if (diff) {
        const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        return `+${added} −${removed}`;
      }
      return r != null ? plural(r, "edit") : "edited";
    }
    case "notebook_edit":
      return "cell edited";
    case "grep_search": {
      const c = n(data.count);
      if (c == null) return null;
      return `${plural(c, "match")}${data.truncated ? "+" : ""}`;
    }
    case "file_search": {
      const c = n(data.count);
      return c != null ? plural(c, "match") : null;
    }
    case "list_directory": {
      const c = n(data.count);
      return c != null ? plural(c, "item") : null;
    }
    case "workspace_tree": {
      const c = n(data.total);
      return c != null ? `${c} ${c === 1 ? "entry" : "entries"}` : null;
    }
    default:
      return null;
  }
}
