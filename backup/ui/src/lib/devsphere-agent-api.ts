/**
 * devsphere-agent-api — client for the DevSphere AI streaming coding agent.
 *
 * All requests go through the Next.js rewrite at /devsphere-api/* which proxies
 * to the DevSphere AI backend (configured via NEXT_PUBLIC_DEVSPHERE_API_URL).
 * POST /devsphere-api/agent/stream returns an SSE stream directly and needs a
 * FormData body (message + optional files) — EventSource can't do POST, so this
 * parses the stream manually via fetch() + ReadableStream.
 *
 * `message`, `thread_id`, `workspace_path` and `permission_mode` are always
 * sent on every request (permission_mode defaults to "manual") — the backend
 * accepts them as optional Form fields on /api/agent/stream.
 */

const DEVSPHERE_BASE = "/devsphere-api";

/** Tool-access mode passed to the agent on every request.
 *
 *  "manual" (default) — reads run freely, every change asks for approval.
 *  "auto"             — nothing is gated.
 *
 *  The retired modes (ask / standard / strict) are still ACCEPTED by the
 *  backend and normalised to "manual", so a browser holding a stale bundle
 *  keeps working; they are gone from this union so no new code can pick one. */
export type PermissionMode = "manual" | "auto";

/** Preview of a pending change, shown on the approval card.
 *  `diff`    — an edit: a unified diff of the replaced region. Line numbers
 *              are relative to the snippet, not the file: the server does not
 *              have the file (it usually lives on the user's machine), so it
 *              cannot anchor them.
 *  `content` — a whole-file write. Deliberately NOT presented as a diff:
 *              without reading the file we cannot know if it creates or
 *              overwrites, and implying a comparison we did not make is worse
 *              than admitting what we know.
 *  `command` — a terminal call, shown in full. Never abbreviate the middle of
 *              a command; that is exactly where the dangerous part hides. */
export interface ChangePreview {
  kind: "diff" | "content" | "command";
  path?: string;
  diff?: string;
  content?: string;
  command?: string;
  language?: string;
  added?: number;
  removed?: number;
  lines?: number;
  truncated?: boolean;
  summary?: string;
}

/** User's answer to a permission_request (manual mode).
 *  "allow_session" is a blanket grant for the rest of the session — nothing
 *  prompts again — not a per-tool one. */
export type PermissionDecision = "allow" | "allow_session" | "deny";

/** Spec-Driven Development mode for a stream request (SPEC_DRIVEN_PLAN.md).
 *  Omitted → normal agent run. */
export type SpecMode = "generation" | "execution";

/** User's answer to a gate_request (spec generation phases). */
export type GateDecision = "approve" | "revise" | "abort";

/** One custom agent parsed from an agent definition file — either a
 *  one-agent-per-file definition (.devaccel/agents/<name>.md,
 *  .claude/agents/<name>.md, BMAD compiled agents) or a stacked roster
 *  (legacy agents.md). `skills` is the BMAD-style association: names of
 *  skill folders (skills/<name>/SKILL.md) injected when the agent runs. */
export interface SpecAgent {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
  tasks: string[];
  system_prompt: string;
  /** Identity — how the user addresses this agent. All optional: an agent
   *  without them still works, it just isn't a someone. */
  persona?: string;
  title?: string;
  icon?: string;
  when_to_use?: string;
}

/** One definition parsed from a SKILL.md / skills.md block. */
export interface SkillDef {
  name: string;
  description: string;
  instructions: string;
  /** OPEN set — "skill", "template", "workflow", "orchestration", or
   *  whatever the framework's `type:` declares. Never validated. */
  kind?: string;
  persona?: string;
  title?: string;
  icon?: string;
  when_to_use?: string;
}

/** One catalog line sent to the server: METADATA ONLY. Bodies stay on this
 *  machine until the agent asks for one through the `skill` tool. */
export interface CatalogEntry {
  name: string;
  kind: string;
  description: string;
  path: string;
  persona?: string;
  title?: string;
  icon?: string;
  when_to_use?: string;
  links?: string[];
}

/** Progress row from GET /spec/{thread}/status (mirrors devsphere_spec_workflows). */
export interface SpecStatus {
  thread_id: string;
  feature_slug: string;
  feature_number: string;
  current_phase: string;
  status: "running" | "awaiting_gate" | "paused" | "completed" | "aborted" | "failed";
  gates: Record<string, { decision: string; feedback?: string }>;
}

/* ── SSE event shapes (mirrors devsphere_ai agents + router/agent_stream.py) ── */

export type AgentSSEEvent =
  | { type: "thread_id"; thread_id: string }
  // End-of-run mirror of the thread's long-term memory — the client persists
  // it to ~/.devaccel/projects/<root>/memory/<thread>.json (canonical copy).
  | { type: "memory_snapshot"; thread_id: string; entries: unknown[] }
  | { type: "workspace_resolved"; requested_path: string | null; resolved_path: string; matched_requested: boolean }
  // `content_type` is the type DETECTED from the file's bytes, not the one the
  // browser declared (that is `declared_content_type`). `notes` carries any
  // limitation the extractor hit — e.g. a scanned PDF, or a video that cannot
  // be transcribed. `rejected` lists files the server refused outright (over
  // the size limit); they were never saved, so the user has to be told.
  | {
      type: "inputs_saved";
      files: Array<{
        original_filename: string;
        path: string;
        size_bytes: number;
        content_type: string;
        declared_content_type?: string;
        kind?: string;
        label?: string;
        extracted_chars?: number;
        images?: number;
        notes?: string[];
        error?: string;
      }>;
      rejected?: string[];
      images?: number;
    }
  | { type: "classification"; route: string; intent?: unknown; reasoning?: string; resumed?: boolean }
  | { type: "content"; delta: string }
  // The stream dropped mid-response and the server is retrying the call —
  // discard the current partial text block; fresh deltas will rebuild it.
  | { type: "content_reset" }
  | { type: "thinking"; thought?: string; status?: string; step?: number }
  | { type: "narration_done"; text: string }
  | { type: "skills_loaded"; skills: string[]; reasons?: string[]; catalog?: CatalogEntry[] }
  // The agent pulled one catalog entry's full instructions — this is the file
  // that actually drove the turn, so the UI can show which of the user's own
  // definitions was in play.
  | { type: "skill_loaded"; name: string; kind: string; description?: string; source?: string; persona?: string }
  // It adopted a persona. Pin it: the agent stays in character until the user
  // dismisses it, so subsequent turns should keep sending this agent_name.
  | { type: "persona_active"; name: string; persona?: string; title?: string; icon?: string; source?: string }
  // MCP: which external servers connected this run and the tools they added.
  | { type: "mcp_tools"; servers: string[]; tools: string[]; errors?: Record<string, string> }
  // agent_id is present when the call came from a sub-agent, so the UI can
  // nest it under that agent's card instead of interleaving every child's
  // activity into one flat timeline.
  | { type: "tool_start"; tool: string; input: Record<string, unknown>; description?: string; agent_id?: string }
  | { type: "tool_result"; tool: string; observation: string; agent_id?: string }
  | { type: "tool_error"; tool: string; observation: string; agent_id?: string }
  // ── Sub-agent delegation ────────────────────────────────────────────────
  // The parent judged the task complex and split it. `agents` is advisory —
  // the actual spawns arrive as subagent_start events.
  | {
      type: "decomposition";
      complexity: string;
      agents: Array<{ role?: string; task?: string; tools?: string[]; rationale?: string }>;
    }
  | {
      type: "subagent_start";
      agent_id: string;
      role: string;
      task: string;
      tools: string[];
      // Globs this agent exclusively owns and may write. Empty => read-only.
      owns_paths?: string[];
      depth?: number;
      // Who spawned it — "" when spawned by the main agent. Drives the spawn
      // tree (descendant counts, path back to main).
      parent_agent_id?: string;
      // Running detached: the parent carried on and this agent's report arrives
      // as a notification later.
      background?: boolean;
      // Continuing a previously finished agent rather than a fresh spawn.
      resumed?: boolean;
      // The deployment this agent actually ran on (resolved, not the alias it
      // asked for) — shown so a cheaper/different model is visible, not assumed.
      model?: string;
    }
  // A background agent's report reached the parent. The card already shows the
  // outcome via subagent_done; this marks WHEN the parent was told, so the
  // timeline reads in causal order.
  | {
      type: "subagent_notification";
      agent_id: string;
      role?: string;
      status: string;
    }
  // The child failed and is being re-run once with the failure fed back in.
  | { type: "subagent_retry"; agent_id: string; role?: string; reason?: string }
  // status "unverified" = it changed code but ran no build/test, so the work
  // is NOT confirmed. Worth surfacing differently from "done".
  | {
      type: "subagent_done";
      agent_id: string;
      role?: string;
      status: string;
      steps?: number;
      files_changed?: string[];
      // What the child actually did/found — the finished card shows this
      // instead of echoing back its own instructions.
      summary?: string;
    }
  // Pattern C — server asks the browser to execute this tool locally and POST
  // the result back via postToolResult(). Rendering is still driven by the
  // tool_start/tool_result pair; this event only triggers local execution.
  | { type: "client_tool_use"; id: string; tool: string; input: Record<string, unknown> }
  // Manual mode — server paused before a change; the UI shows an approve/
  // reject card and answers via postPermissionResponse(). `category` is a
  // sensitive_ops class ("secrets", "database", "infrastructure",
  // "vcs_publish", "dependencies", "services") set when the ARGUMENTS are
  // what raised the prompt, so the card can say what is at stake rather than
  // just naming the tool; `reason` is the same thing as a sentence.
  | {
      type: "permission_request";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      description?: string;
      category?: string;
      reason?: string;
      // WHAT the call will do, built server-side from the arguments alone
      // (agents/change_preview.py) and redacted. Absent for calls with
      // nothing meaningful to show. Render it: a card that names only a tool
      // and a path is not something a human can judge, so they approve
      // everything and the gate stops protecting anyone.
      preview?: ChangePreview | null;
    }
  // agent_id present => the command came from a sub-agent, so its output
  // belongs in that agent's card rather than the main timeline.
  | { type: "terminal_start"; command: string; agent_id?: string }
  | { type: "terminal_output"; line: string; agent_id?: string }
  | { type: "terminal_done"; exit_code: number; agent_id?: string }
  // Which directory server-side tools operate on for this run.
  // source: "explicit" (workspace_path param) | "saved" (thread history) | "server_default"
  | { type: "workspace"; path: string; source?: string }
  // Live todo checklist from the task_manager tool (Claude Code TodoWrite style).
  | {
      type: "tasks";
      tasks: Array<{ id: number; title: string; status: string; note?: string }>;
      done: number;
      total: number;
    }
  | { type: "file_diff"; path?: string; diff: string }
  | {
      type: "token_usage";
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        /** Portion of prompt_tokens served from the provider's cache — a
         *  SUBSET of prompt_tokens, billed at a fraction of the rate. */
        cached_tokens?: number;
      };
    }
  /** How full the context window is RIGHT NOW, measured from the provider's
   *  own prompt_tokens for the last call. Not the cumulative token count:
   *  the whole prompt is re-sent every step, so the cumulative figure grows
   *  superlinearly and says nothing about remaining room. */
  | {
      type: "context_state";
      used: number;
      window: number;
      pct: number;
      cached: number;
      breakdown: {
        system_and_tools: number;
        memory: number;
        scratchpad: number;
        completion_reserve: number;
      };
    }
  /** History was compressed to free context. Announced so the agent's fuzzier
   *  memory of earlier steps reads as a known event, not random forgetting. */
  | { type: "compaction"; messages_before: number; messages_after: number; window: number }
  /** Which model this run is actually on. `degraded` is true when a budget
   *  forced a downgrade from the requested one. */
  | { type: "model"; key: string | null; name: string; context_window: number; degraded: boolean }
  /** Budget standing: at the start of a run, and again on each threshold
   *  crossed mid-run. Never means the run stopped — that arrives as an error. */
  | {
      type: "quota_notice";
      level: "warn" | "critical" | "exceeded" | "blocked";
      used: number;
      limit: number | null;
      window: "day" | "month";
      pct: number;
      degraded: boolean;
      model: string | null;
      message: string;
    }
  | {
      type: "ask_user";
      question?: string;
      options?: string[];
      context?: string;
      // Batched form — multiple clarifications in one card (Copilot/Claude style).
      questions?: Array<{ question: string; options?: string[]; allow_multiple?: boolean }>;
      [key: string]: unknown;
    }
  // ── Spec-Driven Development (spec_mode runs only) ─────────────────────
  // One generation phase (requirements/design/tasks/agents) started.
  | { type: "spec_phase_start"; phase: string; gate?: string | null; feature: string; round?: number; mode?: string }
  // A phase wrote one of its deliverable files.
  | { type: "spec_file_generated"; phase: string; path: string }
  // The workflow is parked: show an approval card, answer via postGateResponse().
  // `decisions` beyond approve/revise/abort are CHOICE options (e.g. the
  // gate-0 target-convention question) — the card renders them as buttons
  // and answers decision:"approve" + feedback:<option>. `labels` maps an
  // option id to its display text.
  | { type: "gate_request"; gate: string; phase: string; feature: string; files: string[]; summary?: string; decisions?: string[]; labels?: Record<string, string> }
  // Keepalive while parked at a gate — safe to ignore in the UI.
  | { type: "gate_waiting"; gate: string }
  // The gate was answered (or timed out → workflow paused, resumable).
  | { type: "gate_result"; gate: string; decision: string; feedback?: string; message?: string }
  // Execution phase task lifecycle (per-task mode).
  | { type: "spec_task_start"; id: string; title: string; phase?: string }
  | { type: "spec_task_done"; id: string; status?: string; detail?: string }
  | { type: "spec_workflow_done"; mode: string; feature: string; spec_dir?: string; agents_dir?: string; skills_dir?: string; tasks_completed?: number; message?: string }
  // A custom agent persona (agent_name) is active for this run.
  | { type: "custom_agent"; name: string }
  | { type: "stopped"; steps_taken: number }
  | { type: "error"; message: string; traceback?: string }
  | { type: "final"; answer: string }
  | { type: "run_summary"; status: string; route: string; steps_taken: number; usage: Record<string, number>; resumable: boolean; resumed?: boolean }
  | { type: "resuming"; route: string; completed_steps: string[]; message: string }
  | { type: "done" };

export interface AgentAttachment {
  filename: string;
  file: File;
}

/* ── Shared SSE-over-fetch reader ─────────────────────────────────────── */

async function readSSE(
  res: Response,
  onEvent: (evt: AgentSSEEvent) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;
      try {
        onEvent(JSON.parse(jsonStr) as AgentSSEEvent);
      } catch {
        // Malformed/partial event — skip rather than crash the stream.
      }
    }
  }
}

/* ── POST /api/agent/stream ───────────────────────────────────────────── */

export async function streamAgent({
  message,
  threadId,
  workspacePath,
  permissionMode = "manual",
  model,
  allowTools,
  denyTools,
  clientTools,
  clientOs,
  mcpLocalTools,
  repoMap,
  runtimeReport,
  projectMemory,
  threadMemoryState,
  specMode,
  specFeature,
  agentName,
  agentFile,
  skillFiles,
  skillCatalog,
  files = [],
  clientInputPaths,
  signal,
  onEvent,
}: {
  message: string;
  threadId?: string;
  workspacePath?: string;
  /** Always sent; defaults to "auto" (all tools/paths allowed). */
  permissionMode?: PermissionMode;
  /** Model key from GET /agent/models. Omit for the caller's default. A key
   *  they are not entitled to falls back to that default server-side rather
   *  than failing the run, so a stale picker never costs a user their turn. */
  model?: string;
  /** Whitelist of tool names. Everything not listed is DENIED, in every mode.
   *
   *  Not sent by the chat UI, and new callers should think twice: a whitelist
   *  is only safe when the sender knows the complete tool set, and a client
   *  never does — the registry is assembled server-side and MCP servers add
   *  tools at runtime. Sending a hand-maintained list denied `skill`,
   *  `checkpoint`, `restore_context`, `submit_plan` and every `mcp__*` tool.
   *  Use `denyTools` to restrict from a client; blocking can only ever affect
   *  what it names, so it is safe under drift. This parameter exists for
   *  operator/API callers and server-side custom-agent narrowing. */
  allowTools?: string[];
  /** Blacklist of tool names — always blocked, regardless of mode. */
  denyTools?: string[];
  /** Pattern C — tool names the browser will execute locally. For each, the
   *  server emits `client_tool_use` and waits for postToolResult(). */
  clientTools?: string[];
  /** OS the delegated commands execute on ("win32" | "darwin" | "linux") —
   *  the daemon host's platform. Lets the backend describe run_terminal for
   *  the RIGHT shell (cmd.exe vs POSIX sh) instead of the server's OS. */
  clientOs?: string;
  /** MCP (Pattern C) — JSON manifest of LOCAL stdio MCP servers the client
   *  started on the user's machine via the daemon: {server: {tools|error}}.
   *  Each tool becomes an mcp__server__tool delegating tool on the backend. */
  mcpLocalTools?: string;
  /** Phase 6 — client-built repo map (tree + symbols), sent on the first
   *  message of a thread so the model orients without many list/read calls. */
  repoMap?: string;
  /** Runtime availability report from the user's machine (daemon
   *  /runtimes/check) — tells the agent up front which language runtimes
   *  exist so it can suggest setup instead of failing commands. */
  runtimeReport?: string;
  /** devaccel.md content read from the CLIENT's workspace — persistent
   *  project memory (Claude Code's CLAUDE.md equivalent). Sent each message
   *  because the server cannot read a client-side workspace. */
  projectMemory?: string;
  /** This thread's long-term memory JSON from ~/.devaccel (canonical client
   *  copy) — lets a fresh server re-seed its store instead of forgetting. */
  threadMemoryState?: string;
  /** Spec-Driven Development — run the gated SpecWorkflow instead of a plain
   *  agent turn. "generation" produces requirements/design/tasks/agents with
   *  approval gates; "execution" walks the approved tasks.md. */
  specMode?: SpecMode;
  /** Which feature the spec run targets (e.g. "001-user-auth"). Execution
   *  falls back to the thread's latest workflow when omitted. */
  specFeature?: string;
  /** Run this turn AS a custom agent (BMAD / Claude Code file convention).
   *  Ignored by the backend when specMode is set. */
  agentName?: string;
  /** Pattern C — the selected agent's .md file content, read locally
   *  because the server cannot see a client-side workspace. */
  agentFile?: string;
  /** Pattern C — JSON object string mapping skill name → SKILL.md content
   *  for the selected agent's `skills:` list. */
  skillFiles?: string;
  /** JSON array string of everything this workspace defines — agents,
   *  skills, templates, whatever kinds it declares. METADATA ONLY: the
   *  server builds the catalog block from it, and the agent pulls one
   *  body at a time back through this client's read_file. */
  skillCatalog?: string;
  files?: AgentAttachment[];
  /** JSON object string mapping an attachment's original filename → the path
   *  it was saved to in the USER's workspace (.devaccel/input/…). The server
   *  quotes these paths to the model instead of its own temporary copy, so
   *  `read_file` on an attachment resolves on the machine where that tool
   *  actually runs. See lib/agent/saveAttachments.ts. */
  clientInputPaths?: string;
  signal?: AbortSignal;
  onEvent: (evt: AgentSSEEvent) => void;
}): Promise<void> {
  const form = new FormData();
  form.append("message", message);
  if (threadId) form.append("thread_id", threadId);
  if (workspacePath) form.append("workspace_path", workspacePath);
  // permission_mode is always sent, even though the backend treats it as optional.
  form.append("permission_mode", permissionMode);
  if (model) form.append("model", model);
  if (allowTools && allowTools.length > 0) form.append("allow_tools", allowTools.join(","));
  if (denyTools && denyTools.length > 0) form.append("deny_tools", denyTools.join(","));
  if (clientTools && clientTools.length > 0) form.append("client_tools", clientTools.join(","));
  if (clientOs) form.append("client_os", clientOs);
  if (mcpLocalTools) form.append("mcp_local_tools", mcpLocalTools);
  if (repoMap) form.append("repo_map", repoMap);
  if (runtimeReport) form.append("runtime_report", runtimeReport);
  if (projectMemory) form.append("project_memory", projectMemory);
  if (threadMemoryState) form.append("thread_memory_state", threadMemoryState);
  if (specMode) form.append("spec_mode", specMode);
  if (specFeature) form.append("spec_feature", specFeature);
  if (agentName) form.append("agent_name", agentName);
  if (agentFile) form.append("agent_file", agentFile);
  if (skillFiles) form.append("skill_files", skillFiles);
  if (skillCatalog) form.append("skill_catalog", skillCatalog);
  if (clientInputPaths) form.append("client_input_paths", clientInputPaths);
  for (const { file } of files) form.append("files", file, file.name);

  const res = await fetch(`${DEVSPHERE_BASE}/agent/stream`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!res.ok) {
    // Surface the backend's actual message (e.g. "workspace_path is required
    // on the first request of a thread") instead of a bare status code.
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch { /* non-JSON error body — fall back to status text */ }
    throw new Error(detail || `Agent stream failed: ${res.status} ${res.statusText}`);
  }
  await readSSE(res, onEvent);
}

/* ── POST /api/agent/tool_result ──────────────────────────────────────── */

/**
 * Pattern C — return a client-executed tool's result to the paused agent loop.
 * Called from the `client_tool_use` handler after running the tool locally.
 * `id` is the call id from the matching `client_tool_use` event.
 */
export async function postToolResult(
  threadId: string,
  id: string,
  output: unknown,
): Promise<void> {
  await fetch(`${DEVSPHERE_BASE}/agent/tool_result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, id, output }),
  }).catch(() => {
    // If this POST fails the server call times out and the loop continues with
    // an error observation — nothing to recover here.
  });
}

/* ── POST /api/agent/permission_response ──────────────────────────────── */

/**
 * Ask mode — send the user's approve/reject decision for a tool that's waiting
 * on a `permission_request` event. `id` is that event's request id.
 */
export async function postPermissionResponse(
  threadId: string,
  id: string,
  decision: PermissionDecision,
): Promise<void> {
  await fetch(`${DEVSPHERE_BASE}/agent/permission_response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, id, decision }),
  }).catch(() => {
    // If this POST fails the server request times out and denies safely.
  });
}

/* ── POST /api/agent/gate_response ────────────────────────────────────── */

/**
 * Spec-Driven Development — answer a `gate_request` (the workflow is parked
 * between phases waiting for the user's review of the generated files).
 * decision: "approve" advances, "revise" re-runs the phase with `feedback`
 * (required), "abort" stops the workflow (files stay on disk).
 */
export async function postGateResponse(
  threadId: string,
  gate: string,
  decision: GateDecision,
  feedback?: string,
): Promise<void> {
  await fetch(`${DEVSPHERE_BASE}/agent/gate_response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, gate, decision, feedback: feedback ?? null }),
  }).catch(() => {
    // If this POST fails the gate times out server-side and the workflow
    // pauses as awaiting_gate — resumable, nothing to recover here.
  });
}

/* ── GET /api/agent/spec/{thread_id}/status ───────────────────────────── */

/** Latest spec workflow progress for the thread (null when none exists). */
export async function getSpecStatus(threadId: string): Promise<SpecStatus | null> {
  try {
    const res = await fetch(`${DEVSPHERE_BASE}/agent/spec/${encodeURIComponent(threadId)}/status`);
    if (!res.ok) return null;
    return (await res.json()) as SpecStatus;
  } catch {
    return null;
  }
}

/* ── GET /api/agent/spec/{thread_id}/agents ───────────────────────────── */

/**
 * Custom agent roster generated by the agents phase (gate 4), parsed from
 * the feature's .devaccel/agents/<NNN-slug>/agents.md (the server falls back
 * to the legacy project-level agents.md). Empty when generation hasn't run
 * yet or the workspace lives only on this client (then it's read locally).
 */
export async function getSpecAgents(threadId: string): Promise<SpecAgent[]> {
  try {
    const res = await fetch(`${DEVSPHERE_BASE}/agent/spec/${encodeURIComponent(threadId)}/agents`);
    if (!res.ok) return [];
    const data = (await res.json()) as { agents?: SpecAgent[] };
    return Array.isArray(data.agents) ? data.agents : [];
  } catch {
    return [];
  }
}

/**
 * Client-side parser for agent definition files — mirrors the server's
 * spec_driven/parsers.py::parse_agents. Handles BOTH one-agent-per-file
 * (.devaccel/agents/<name>.md, .claude/agents/, BMAD compiled agents) and
 * stacked rosters (legacy agents.md). Blocks marked `type: skill` (roster
 * skill definitions) are not agents and are skipped.
 */
export interface FrontmatterBlock {
  meta: Record<string, string>;
  body: string;
}

/** Key/value lines of one frontmatter block. */
function parseMetaLines(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    if (key) meta[key] = line.slice(sep + 1).trim();
  }
  return meta;
}

/**
 * Every (meta, body) block in a definition file. Mirrors the server's
 * _all_frontmatter_blocks.
 *
 * Also accepts a file that opens with the frontmatter KEYS and no `---`
 * fences around them — a hand-written agent where the author knew what the
 * fields were and not that the delimiters were load-bearing. Such a file is
 * unmistakably a definition, and rejecting it over punctuation just makes
 * the agent silently disappear from the picker.
 *
 * Guarded so ordinary prose can't qualify: an unbroken run of `key: value`
 * lines from the very first line, at least two of them, with `name` or
 * `description` among the keys.
 */
export function frontmatterBlocks(content: string): FrontmatterBlock[] {
  const clean = content.replace(/^﻿/, "");
  if (!clean.trimStart().startsWith("---")) {
    const lines = clean.split(/\r?\n/);
    const head: string[] = [];
    for (const line of lines) {
      if (!line.trim()) break;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}\s*:/.test(line)) break;
      head.push(line);
    }
    const meta = parseMetaLines(head.join("\n"));
    if (Object.keys(meta).length >= 2 && (meta.name || meta.description)) {
      return [{ meta, body: lines.slice(head.length).join("\n").trim() }];
    }
  }
  // Fenced: blocks alternate [before, meta, body, meta, body, …]
  const blocks = clean.split(/^---\s*$/m);
  const out: FrontmatterBlock[] = [];
  for (let i = 1; i < blocks.length - 1; i += 2) {
    out.push({ meta: parseMetaLines(blocks[i]), body: blocks[i + 1].trim() });
  }
  return out;
}

export function parseAgentsMd(content: string): SpecAgent[] {
  const agents: SpecAgent[] = [];
  const csv = (v?: string) => (v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const { meta, body } of frontmatterBlocks(content)) {
    if (!meta.name || !meta.description) continue; // not an agent block — skip
    if ((meta.type ?? "agent").toLowerCase() === "skill") continue; // roster skill block
    agents.push({
      name: meta.name,
      description: meta.description,
      tools: csv(meta.tools),
      skills: csv(meta.skills),
      tasks: csv(meta.tasks),
      // Identity — every field optional. An agent without them still works;
      // these are what let the user address it as a person.
      persona: meta.persona || personaFromBody(body),
      title: meta.title ?? "",
      icon: meta.icon ?? "",
      when_to_use: meta.whentouse ?? meta.when_to_use ?? "",
      system_prompt: body,
    });
  }
  return agents;
}

/**
 * A BMAD Core agent: Markdown with NO frontmatter, whose definition is a
 * fenced ```yaml block carrying an `agent:` mapping. Mirrors the server's
 * spec_driven.parsers.parse_bmad_agent so both ends agree on what counts as
 * an agent — without this the client fell back to naming the agent after its
 * file and showing no description, and its `agent:` identity (BMAD's `name:`
 * is the HUMAN name, "Grace"; `id:` is the slug) never reached the UI.
 *
 * The whole file is the system prompt: a BMAD agent's activation
 * instructions explicitly tell it to read the entire file.
 */
export function parseBmadAgent(content: string, fallbackName = ""): SpecAgent | null {
  const block = /```(?:ya?ml)\s*\n([\s\S]*?)```/i.exec(content)?.[1];
  if (!block || !/^agent\s*:/m.test(block)) return null;

  // Indented scalars inside the yaml block. Deliberately regex rather than a
  // YAML parser: these files are prompt documents, and a single malformed
  // line further down must not cost us the whole agent.
  const field = (name: string): string =>
    new RegExp(`^\\s{2,}${name}\\s*:\\s*(.+)$`, "m")
      .exec(block)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "") ?? "";

  const id = field("id") || fallbackName;
  if (!id) return null;
  const whenToUse = field("whenToUse");
  const title = field("title");
  return {
    name: id,
    description: whenToUse || title,
    tools: [],
    skills: [],
    tasks: [],
    persona: field("name"),
    title,
    icon: field("icon"),
    when_to_use: whenToUse,
    system_prompt: content.trim(),
  };
}

/**
 * The human name a body declares as its opening H1 ("# Mary"), the way BMAD
 * v6 skills write it. Only the FIRST non-empty line counts — a `# Start dev
 * server` comment inside a fenced block further down is not somebody's name —
 * and it must be short, or it is a document title rather than a person.
 * Mirrors the server's _persona_from_body.
 */
function personaFromBody(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^#\s+([^\n#]+?)\s*$/.exec(line);
    if (!m) return "";
    const title = m[1].trim().replace(/\s+/g, " ");
    return title && title.split(" ").length <= 3 ? title : "";
  }
  return "";
}

/**
 * Client-side parser for skills/<name>/SKILL.md — mirrors the server's
 * parse_skill. Files without frontmatter fall back to the folder name and
 * their raw content as instructions.
 */
export function parseSkillMd(content: string, fallbackName: string): SkillDef | null {
  const blocks = frontmatterBlocks(content);
  if (blocks.length > 0) {
    const { meta, body } = blocks[0];
    if (meta.name || meta.description) {
      return {
        name: meta.name || fallbackName,
        description: meta.description ?? "",
        instructions: body,
        // `kind` is an OPEN set: whatever `type:` says. A framework may ship
        // templates, checklists, workflows, orchestrations or a kind nobody
        // has invented yet, and all of them list and load the same way.
        kind: (meta.type ?? "").trim().toLowerCase() || "skill",
        persona: meta.persona || personaFromBody(body),
        title: meta.title ?? "",
        icon: meta.icon ?? "",
        when_to_use: meta.whentouse ?? meta.when_to_use ?? "",
      };
    }
  }
  const trimmed = content.trim();
  return trimmed
    ? { name: fallbackName, description: "", instructions: trimmed, kind: "skill" }
    : null;
}

/**
 * A STACKED skills file (skills.md) — one definition per frontmatter block.
 * Some frameworks keep every skill in one file instead of one folder each;
 * both are valid, and this is the reader for the first. Mirrors the server's
 * parse_skills_file.
 */
export function parseSkillsMd(content: string): SkillDef[] {
  const out: SkillDef[] = [];
  for (const { meta, body } of frontmatterBlocks(content)) {
    if (!meta.name) continue; // divider or hand-edited noise
    out.push({
      name: meta.name,
      description: meta.description ?? "",
      instructions: body,
      kind: (meta.type ?? "").trim().toLowerCase() || "skill",
      persona: meta.persona || personaFromBody(body),
      title: meta.title ?? "",
      icon: meta.icon ?? "",
      when_to_use: meta.whentouse ?? meta.when_to_use ?? "",
    });
  }
  return out;
}

/* ── GET /api/agent/custom-agents/{thread_id} ─────────────────────────── */

/** Server-side file-convention discovery result. `server_visible: false`
 *  means the workspace lives on this client — scan it locally instead. */
export interface CustomAgentsScan {
  agents: Array<SpecAgent & { source?: string; resolved_skills?: string[] }>;
  skills: Array<SkillDef & { source?: string }>;
  server_visible: boolean;
}

/**
 * File-convention agent discovery (BMAD / Claude Code model): every agent
 * defined under .devaccel/agents/, .claude/agents/ or a BMAD install in the
 * thread's workspace — generated and hand-copied files alike.
 */
export async function getCustomAgents(threadId: string): Promise<CustomAgentsScan | null> {
  try {
    const res = await fetch(`${DEVSPHERE_BASE}/agent/custom-agents/${encodeURIComponent(threadId)}`);
    if (!res.ok) return null;
    return (await res.json()) as CustomAgentsScan;
  } catch {
    return null;
  }
}

/* ── POST /api/agent/stop ─────────────────────────────────────────────── */

export async function stopAgent(threadId: string): Promise<void> {
  await fetch(`${DEVSPHERE_BASE}/agent/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId }),
  }).catch(() => {});
}

/* ── POST /api/agent/resume ───────────────────────────────────────────── */

export async function resumeAgent({
  threadId,
  signal,
  onEvent,
}: {
  threadId: string;
  signal?: AbortSignal;
  onEvent: (evt: AgentSSEEvent) => void;
}): Promise<void> {
  const res = await fetch(`${DEVSPHERE_BASE}/agent/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId }),
    signal,
  });
  if (!res.ok) throw new Error(`Agent resume failed: ${res.status} ${res.statusText}`);
  await readSSE(res, onEvent);
}
