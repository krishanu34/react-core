"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MessageSquare,
  ChevronDown,
  Plus,
  ChevronUp,
  Minimize2,
  Maximize2,
  X,
  Paperclip,
  SendHorizonal,
  Square,
  Check,
  Sparkles,
  Pencil,
  Copy,
  Trash2,
  Settings,
  Bot,
  Code2,
  Eye,
  Bug,
  FileText,
  FileCode2,
  FolderOpen,
  ChevronRight,
  Loader2,
  AlertCircle,
  Wrench,
  Terminal,
  Brain,
  HelpCircle,
  Ban,
  Shield,
  ShieldAlert,
  Search,
  FilePlus,
  ListTree,
  ListTodo,
  GitBranch,
  Globe,
  Cpu,
  type LucideIcon,
} from "lucide-react";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import { useGlobalProject } from "@/providers/ProjectProvider";
// Legacy spec-api — kept ONLY so old persisted spec-gen/spec-exec messages
// still render and their "Approve & Execute" button keeps working. NEW spec
// runs go through the streaming agent with spec_mode (devsphere-agent-api).
import { specExecute, type SpecPlan, type SpecProjectContext } from "@/lib/spec-api";
import {
  saveChatSessions as syncSaveSessions,
  loadChatSessions as syncLoadSessions,
} from "@/lib/workspace-sync-api";
import { writeSpecFilesToWorkspace, gatherWorkspaceContext } from "@/lib/spec-workspace-writer";
import {
  streamAgent,
  stopAgent,
  postToolResult,
  postPermissionResponse,
  postGateResponse,
  getSpecAgents,
  getCustomAgents,
  parseAgentsMd,
  parseBmadAgent,
  parseSkillMd,
  parseSkillsMd,
  type AgentSSEEvent,
  type AgentAttachment,
  type CatalogEntry,
  type ChangePreview,
  type PermissionMode,
  type PermissionDecision,
  type SpecMode,
  type GateDecision,
  type SpecAgent,
  type SkillDef,
} from "@/lib/devsphere-agent-api";
import {
  ContextMeter,
  QuotaBanner,
  TokenBadge,
  type ContextState,
  type QuotaNotice,
} from "@/components/ide/ContextMeter";
import { fetchMyModels, type AllowedModel } from "@/lib/devsphere-models-api";
import { scanDirectory } from "@/lib/localFs";
import { fitChatSessions, setItem as storageSet } from "@/lib/storage";
import { uuid } from "@/lib/uuid";
import { describeAttachment, humanSize, summariseAttachments } from "@/lib/attachmentSupport";
import { CLIENT_TOOLS, RUNTIME_TOOLS, detectClientOs, executeClientTool, hasRuntimeHost, readProjectMemory } from "@/lib/agent/clientTools";
import { startLocalMcpServers } from "@/lib/mcp/mcpClient";
import { resolveWorkspaceFileAccess } from "@/lib/fileAccess";
import { readStateFile, writeStateFile } from "@/lib/fileAccess/agentClient";
import { toolLabel, toolTarget, toolResultSummary, isInternalTool } from "@/lib/agent/toolDisplay";
import { descendantCount, lineagePath, type SubagentNode } from "@/lib/agent/subagentTree";
import { buildRepoMap } from "@/lib/agent/repoMap";
import { saveAttachmentsToWorkspace } from "@/lib/agent/saveAttachments";
import { buildRuntimeReport } from "@/lib/agent/runtimeReport";
import { replaceNodes, isLocalWorkspaceId, getAllNodes, type WsNode } from "@/lib/db/workspaceStore";
import { fetchFileContent, fetchWorkspaceTree } from "@/lib/workspace-api";

/* Legacy project-level roster path — current workflows write per feature to
   .devaccel/agents/<NNN-slug>/agents.md; this is the fallback read. */
/** Remembers the user's model choice across reloads. Validated against their
 *  current entitlements on load — an admin may have revoked it since. */
const MODEL_CHOICE_KEY = "devsphere.chat.model";
const AGENTS_MD_PATH = ".devaccel/agents/agents.md";
/* agents.md wherever it lives: the agent sometimes scaffolds the app in a
   SUBFOLDER (e.g. ./library-application/) and writes .devaccel there, not at
   the workspace root — match both so the roster is still found. */
const AGENTS_MD_RE = /(?:^|\/)\.devaccel\/agents\/agents\.md$/;
/* Per-feature roster: .devaccel/agents/<NNN-slug>/agents.md — one folder per
   spec feature, at the workspace root or nested in a project subfolder. */
const AGENTS_FEATURE_MD_RE = /(?:^|\/)\.devaccel\/agents\/(\d{3}-[^/]+)\/agents\.md$/;

/** One agents.md roster — a feature folder's file (or the legacy/root copy). */
interface SpecRoster {
  /** <NNN-slug> feature the roster belongs to; null for the legacy root file. */
  feature: string | null;
  path: string;
  agents: SpecAgent[];
}

/* ── Custom agents — file-convention discovery (BMAD / Claude Code) ──────
   Mirrors the server's custom_agent_registry._classify(). BMAD v6 "skills
   architecture": an agent's canonical content may live as a skill folder,
   with the per-IDE agent file a thin stub (.github/agents/<name>.agent.md,
   description-only frontmatter, body pointing at the SKILL.md). */
const COPILOT_STUB_RE = /(?:^|\/)\.github\/agents\/([^/]+)\.(?:agent|chatmode)\.md$/i;
/* THE FOLDER DECIDES, and the NEAREST declaring folder wins.

     agents/mary.md                        an agent
     agents/priya/AGENT.md                 an agent
     agents/priya/anything.md              an agent
     skills/java-python/SKILL.md           a skill
     skills/java-python/checklists/x.md    that skill's CHECKLIST, not a skill

   A file with no declaring ancestor is not a definition, wherever it sits —
   so "agents live under agents/" is checkable by looking at the tree, and a
   stray note can never become an agent. Mirrors the server's _classify(). */
const ARTIFACT_DIR_KINDS: Record<string, string> = {
  template: "template", templates: "template",
  checklist: "checklist", checklists: "checklist",
  task: "task", tasks: "task",
  workflow: "workflow", workflows: "workflow",
  data: "data",
  reference: "reference", references: "reference",
};
const AGENT_DIR_NAMES = new Set(["agent", "agents", "chatmode", "chatmodes", "persona", "personas"]);
const SKILL_DIR_NAMES = new Set(["skill", "skills"]);
const DOC_BASENAMES = new Set([
  "readme.md", "changelog.md", "license.md", "contributing.md",
  "index.md", "todo.md", "notes.md",
]);
/* Each artifact costs one fetch, so cap it. A framework with more supporting
   files than this is one the model should explore with read_file, not one we
   should pull whole into a dropdown. */
const MAX_ARTIFACTS = 60;

/** What a path IS: "agent" | "skill" | an artifact kind, or null. */
function classifyPath(path: string): string | null {
  const parts = path.split("/");
  const base = (parts.pop() ?? "").toLowerCase();
  if (base === "skill.md" || base === "skills.md") return "skill";
  if (base === "agent.md" || base === "agents.md") return "agent";
  if (/\.(?:agent|chatmode)\.md$/i.test(base)) return "agent";
  if (!base.endsWith(".md") || DOC_BASENAMES.has(base)) return null;
  // Nearest ancestor first — a checklist inside a skill is a checklist.
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const dir = parts[i].toLowerCase();
    if (ARTIFACT_DIR_KINDS[dir]) return ARTIFACT_DIR_KINDS[dir];
    if (AGENT_DIR_NAMES.has(dir)) return "agent";
    if (SKILL_DIR_NAMES.has(dir)) return "skill";
  }
  return null;
}
/** A definition's fallback NAME when its frontmatter declares none.
 *
 *  For a stub the filename is the name (`bmad-agent-dev.agent.md` → the
 *  agent). But a PRINCIPAL file is named by its folder: `agents/priya/
 *  AGENT.md` is Priya's agent, not one called "AGENT" — the folder exists
 *  for it, which is the whole point of the folder-per-agent layout. */
const PRINCIPAL_BASENAMES = new Set(["agent.md", "agents.md", "skill.md", "skills.md"]);

function fileStem(path: string): string {
  const parts = path.split("/");
  const base = parts.pop() ?? "";
  if (PRINCIPAL_BASENAMES.has(base.toLowerCase())) {
    return parts.pop() ?? base.replace(/\.md$/i, "");
  }
  return base.replace(/\.(?:agent|chatmode)\.md$/i, "").replace(/\.md$/i, "");
}
/* BMAD v6 agent personas that exist only as skill folders (no stub). */
const BMAD_AGENT_SKILL_PREFIX = "bmad-agent-";
/* skills.md is deliberately absent — it IS a definition file (see above). */
const NON_AGENT_BASENAMES = new Set(["agents.md", "roster.md", "readme.md"]);

/** One discovered custom agent — definition + the file it came from (content
 *  kept so Pattern C sends it as agent_file; the server can't read it). */
interface CustomAgentEntry {
  agent: SpecAgent;
  path: string;
  fileContent: string;
}
interface SkillEntry extends SkillDef {
  path: string;
  content: string;
}

/* Executable spec features: .devaccel/spec/<NNN-slug>/ folders that have a
   tasks.md (the execution phase walks that file task-by-task) — at the
   workspace root OR nested in a project subfolder. */
const SPEC_TASKS_RE = /(?:^|\/)\.devaccel\/spec\/(\d{3}-[^/]+)\/tasks\.md$/;
function findSpecFeatures(nodes: WsNode[]): string[] {
  const features = new Set<string>();
  for (const n of nodes) {
    if (n.type !== "file" || n.deleted) continue;
    const m = SPEC_TASKS_RE.exec(n.path);
    if (m) features.add(m[1]);
  }
  return [...features].sort();
}

/* ========================================================================== *
 *  Permission modes. Mirrors the backend's `permission_mode` contract on
 *  /api/agent/stream (context/permissions.py): manual | auto.
 *
 *  Manual is FIRST and is the default. The expensive failure on an existing
 *  codebase is an unreviewed edit, not a slow one, so the safe mode is the
 *  one you get without choosing. `ask`/`standard`/`strict` were retired; the
 *  backend still normalises them to manual for clients on a stale bundle.
 * ========================================================================== */
const PERMISSION_MODES: { id: PermissionMode; label: string; Icon: typeof Shield; desc: string }[] = [
  {
    id: "manual",
    label: "Manual edit",
    Icon: ShieldAlert,
    desc: "Reads run freely; every edit, command and high-impact change asks you first",
  },
  {
    id: "auto",
    label: "Auto",
    Icon: Shield,
    desc: "No prompts — the agent edits and runs commands on its own",
  },
];

/* Tool names for the BLOCK picker. This mirrors the backend registry
   (devsphere_ai/tools/*.py `name = "..."`) and will drift from it — a client
   cannot know the server's registry, and MCP servers add tools at runtime.
   That is tolerable ONLY because this list drives a blocklist: a tool missing
   from here simply cannot be blocked from the UI. It must never drive an
   allow-list, which is what briefly happened and denied `skill`,
   `checkpoint`, `restore_context`, `submit_plan` and every mcp__* tool on
   every request. */
const ALL_TOOLS: { id: string; label: string }[] = [
  { id: "read_file", label: "Read File" },
  { id: "grep_search", label: "Grep Search" },
  { id: "workspace_tree", label: "Workspace Tree" },
  { id: "list_directory", label: "List Directory" },
  { id: "file_search", label: "File Search" },
  { id: "batch_read_files", label: "Batch Read Files" },
  { id: "project_context", label: "Project Context" },
  { id: "file_write", label: "Write File" },
  { id: "code_edit", label: "Code Edit" },
  { id: "create_output", label: "Create Output" },
  { id: "notebook_edit", label: "Notebook Edit" },
  { id: "run_terminal", label: "Run Terminal" },
  { id: "git", label: "Git" },
  { id: "web_fetch", label: "Web Fetch" },
  { id: "web_search", label: "Web Search" },
  { id: "lsp", label: "LSP (Symbols)" },
  { id: "ask_user", label: "Ask User" },
  { id: "sub_agent", label: "Sub Agent" },
  { id: "summarize_workspace", label: "Summarize Workspace" },
  { id: "task_manager", label: "Task Manager" },
  { id: "remember", label: "Remember" },
  { id: "update_project_memory", label: "Update Project Memory" },
  { id: "monitor", label: "Monitor" },
  { id: "skill", label: "Skill" },
  { id: "checkpoint", label: "Checkpoint" },
  { id: "restore_context", label: "Restore Context" },
  { id: "resume_agent", label: "Resume Agent" },
  { id: "submit_plan", label: "Submit Plan" },
];

type AgentId = string;

/* ========================================================================== *
 *  Message types (discriminated union)
 * ========================================================================== */
interface TextMsg {
  kind: "text";
  role: "user" | "assistant";
  text: string;
}

interface SpecFileInfo {
  path: string;
  language: string;
  purpose: string;
  hasContent: boolean;
}

interface SpecMsg {
  kind: "spec-gen" | "spec-exec";
  role: "assistant";
  answer: string;
  plan: SpecPlan;
  files: SpecFileInfo[];
  projectName: string;
  writtenToWorkspace: boolean;
}

interface LoadingMsg {
  kind: "loading";
  role: "assistant";
}

interface ErrorMsg {
  kind: "error";
  role: "assistant";
  text: string;
}

/* Inline folder-access request. Injected when the user sends a message that
   needs local files but access isn't live yet. One click grants access (daemon
   or browser picker) and auto-continues the stashed message. */
interface AccessRequestMsg {
  kind: "access-request";
  role: "assistant";
  /** The user message stashed to auto-resend once access is granted. */
  pendingText: string;
  /** Set once resolved so the card locks into a final state. */
  resolved?: "granted" | "dismissed";
  /** Last grant attempt error, shown inline. */
  error?: string;
}

/* AUTO mode only — one chronological step in a DevSphere AI agent run.
   Rendered in arrival order to give the Copilot-style "narrate → do → narrate"
   flow. Narrative blocks are segmented by tool/terminal/diff boundaries, so no
   `narration_done` event is required (it's honored when present). */
type TimelineItem =
  | { kind: "text"; text: string; done: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: string; input: Record<string, unknown>; description?: string; observation?: string; isError?: boolean; agentId?: string }
  // One delegated sub-agent. Its own tool calls are collected in `children`
  // rather than pushed onto the main timeline, so a parallel fan-out doesn't
  // interleave three agents' activity into one unreadable stream.
  | {
      kind: "subagent";
      agentId: string;
      role: string;
      task: string;
      tools: string[];
      ownsPaths?: string[];
      // "running" | "done" | "unverified" | "failed" | "stopped" | "error"
      status: string;
      steps?: number;
      filesChanged?: string[];
      retried?: boolean;
      // Nesting level (1 = spawned by the main agent). Drives indentation so a
      // grandchild reads as belonging to its parent rather than as a peer.
      depth?: number;
      // Who spawned it ("" = the main agent). Depth alone can't distinguish two
      // sibling subtrees, so the real parent link is what makes descendant
      // counts and the lineage path correct.
      parentAgentId?: string;
      // Detached: the parent kept working instead of waiting for this one.
      background?: boolean;
      // Continuing a previously finished agent, not a fresh spawn.
      resumed?: boolean;
      // The parent has been told this agent's result (background only).
      notified?: boolean;
      // Deployment it actually ran on. Only surfaced when it differs from the
      // main agent's, so the common case stays uncluttered.
      model?: string;
      // When it started — drives the running card's elapsed-time clock, the
      // one signal that tells a user "slow" apart from "stuck".
      startedAt?: number;
      // What it actually did, from its own final report — shown once finished
      // instead of re-displaying the task it was given.
      summary?: string;
      children: { tool: string; description?: string; observation?: string; isError?: boolean }[];
    }
  | { kind: "terminal"; command: string; lines: string[]; exitCode?: number }
  // Live todo checklist (task_manager `tasks` events) — ONE block per run,
  // updated in place as statuses change, like Claude Code's TodoWrite widget.
  | { kind: "tasks"; tasks: { id: number; title: string; status: string; note?: string }[]; done: number; total: number }
  | { kind: "diff"; path?: string; diff: string }
  | {
      kind: "ask_user";
      question: string;
      options?: string[];
      context?: string;
      // Batched clarifications — rendered as one multi-question card.
      questions?: { question: string; options?: string[]; allowMultiple?: boolean }[];
    }
  | {
      kind: "permission";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      description?: string;
      category?: string;
      reason?: string;
      preview?: ChangePreview | null;
    }
  // Spec-Driven Development — the workflow is parked between phases waiting
  // for the user's file review. `result` is filled from gate_result so the
  // card locks in even when the decision came from another client/timeout.
  | {
      kind: "gate"; gate: string; phase: string; feature: string; files: string[]; summary?: string;
      /** Choice options beyond approve/revise/abort (e.g. gate-0 target
       *  question) — rendered as buttons answering approve + feedback. */
      decisions?: string[]; labels?: Record<string, string>;
      result?: { decision: string; feedback?: string };
    };

/* AUTO mode only — a streamed DevSphere AI agent run. SPEC mode never produces this. */
interface AgentRunMsg {
  kind: "agent-run";
  role: "assistant";
  /** Stable id set once at creation — updateRun() targets by this, never by
   *  array position, so a late event from an old run can't mutate a newer one. */
  runId: string;
  /** Authoritative final answer (from the `final` event); mirrors the last text block. */
  answer: string;
  /** Ordered steps rendered as the Copilot-style timeline. */
  timeline: TimelineItem[];
  status: "running" | "done" | "stopped" | "error";
  errorMessage?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
  };
  /** Context-window occupancy from the last LLM call (context_state). Distinct
   *  from `usage`: that is cumulative SPEND, this is current OCCUPANCY. */
  contextState?: ContextState;
  /** Budget warning for this run (quota_notice), newest wins. */
  quotaNotice?: QuotaNotice;
  /** Model the run is actually on (model event) — not necessarily the one
   *  picked, since a spent budget silently downgrades it. */
  runModel?: { key: string | null; name: string; degraded: boolean };
  /** How many times history was compressed to free context (compaction). */
  compactions?: number;
  /** Domain skills the backend injected (skills_loaded). */
  skills?: string[];
  /** External MCP servers that connected this run (mcp_tools). */
  mcpServers?: string[];
  /** Uploaded inputs, as parsed by the server (inputs_saved). */
  savedInputs?: Array<{
    name: string;
    label: string;
    kind: string;
    chars: number;
    images: number;
    notes: string[];
  }>;
  /** Attachments the server refused (too large) — never saved or read. */
  rejectedInputs?: string[];
  /** Resume banner text (resuming). */
  resumingMessage?: string;
  /** Run totals (run_summary). */
  runSummary?: { status: string; steps_taken: number };
  /** Stop requested but not yet server-confirmed. */
  stopRequested?: boolean;
  /** Stopped because the client gave up (timeout), not a server-confirmed stop. */
  forcedStop?: boolean;
  /** Restored from storage still marked "running" — the page went away
   *  mid-run, so no terminal event could ever arrive. See closeInterruptedRun. */
  interrupted?: boolean;
  /** Server couldn't use the bound folder and fell back to its own default. */
  workspaceWarning?: string;
  /** Directory server-side tools operate on (workspace event). */
  serverWorkspace?: { path: string; source?: string };
  /** Run start (ms epoch) — drives the live working-indicator timer. */
  startedAt?: number;
}

type Msg = TextMsg | SpecMsg | AgentRunMsg | LoadingMsg | ErrorMsg | AccessRequestMsg;

/* ── Migrate old { role, text } messages to new discriminated union ───── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateMsg(raw: any): Msg {
  if (raw && raw.kind) return closeInterruptedRun(raw as Msg);
  return { kind: "text", role: raw?.role ?? "assistant", text: raw?.text ?? "" };
}

/**
 * A run persisted as "running" was interrupted, not left running.
 *
 * `status` is saved with the message, so a run that never reached a terminal
 * event — tab closed mid-run, reload, browser crash — comes back from storage
 * still marked "running". Nothing can ever finish it: the SSE stream that
 * would have delivered `done` died with the old page. The UI then renders a
 * live working indicator whose elapsed clock counts up from an hours-old
 * `startedAt`, so a conversation the user finished yesterday looks like the
 * backend is still grinding away on it.
 *
 * Any restored run is therefore closed here, at the storage boundary, before
 * it can reach the renderer. "stopped" rather than "error" because nothing
 * failed — the work may well have completed server-side; this client just
 * stopped listening. The thread is intact, so the next message continues it.
 */
export function closeInterruptedRun(msg: Msg): Msg {
  if (msg.kind !== "agent-run" || msg.status !== "running") return msg;
  return {
    ...msg,
    status: "stopped",
    stopRequested: false,
    forcedStop: false,
    interrupted: true,
  };
}

interface ChatSession {
  id: string;
  name: string;
  messages: Msg[];
  createdAt: number;
  /** AUTO mode only — DevSphere AI agent thread this session maps to. */
  threadId?: string;
}

/* AUTO mode only — same check used elsewhere to detect a real absolute local path. */
const FULL_PATH_RE = /^[A-Za-z]:[\\/]|^\//;

/* ========================================================================== *
 *  Session persistence (localStorage per workspace)
 * ========================================================================== */
const DEFAULT_GREETING =
  "How can I help you today?\n\nDemo command: `Create file demo/hello.txt with content: Hello from Workspace Studio`";

export function parseCreateFileCommand(text: string): { path: string; content: string } | null {
  const match = text.match(/^create\s+file\s+(.+?)\s+with\s+content:\s*([\s\S]*)$/i);
  if (!match) return null;
  const path = match[1].trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) {
    throw new Error("Please use a relative file path inside the workspace.");
  }
  return { path, content: match[2] };
}

function makeSess(name: string): ChatSession {
  return {
    id: uuid(),
    name,
    messages: [{ kind: "text", role: "assistant", text: DEFAULT_GREETING }],
    createdAt: Date.now(),
  };
}

function loadSessionsSync(wsId: number | null): ChatSession[] {
  if (typeof window === "undefined") return [makeSess("Session 1")];
  try {
    const raw = localStorage.getItem(`chat_sessions_${wsId ?? "default"}`);
    if (raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(raw) as any[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s) => ({
          ...s,
          messages: (s.messages ?? []).map(migrateMsg),
        }));
      }
    }
  } catch { /* ignore */ }
  return [makeSess("Session 1")];
}

/** ~/.devaccel/projects/<stateId>/sessions/sessions.json — the CANONICAL
 *  session store on the user's machine (Claude Code keeps transcripts under
 *  ~/.claude/projects the same way). Server sync + localStorage are caches. */
function sessionsStatePath(wsId: number): string | null {
  const stateId = resolveWorkspaceFileAccess(wsId)?.stateId;
  return stateId ? `projects/${stateId}/sessions/sessions.json` : null;
}

async function loadSessions(wsId: number | null): Promise<ChatSession[]> {
  if (wsId == null) return loadSessionsSync(wsId);
  // 1. The user's machine first — survives a server DB wipe.
  const statePath = sessionsStatePath(wsId);
  if (statePath) {
    try {
      const raw = await readStateFile(statePath);
      if (raw) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(raw) as any[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((s) => ({ ...s, messages: (s.messages ?? []).map(migrateMsg) }));
        }
      }
    } catch { /* fall through to server/local caches */ }
  }
  // 2. Server sync, 3. localStorage — as before.
  const remote = await syncLoadSessions(wsId);
  if (remote && Array.isArray(remote) && remote.length > 0) {
    return remote.map((s) => ({
      ...s,
      messages: ((s as { messages?: unknown[] }).messages ?? []).map(migrateMsg),
    })) as ChatSession[];
  }
  return loadSessionsSync(wsId);
}

function saveSessionsLocal(wsId: number | null, sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  // Capped: this is the last of the three tiers documented above, and an
  // uncapped transcript per workspace is what filled the origin's storage —
  // at which point login itself could not write its token. The full list is
  // still written to disk and the server by syncSessionsRemote().
  const { sessions: cacheable } = fitChatSessions(sessions);
  storageSet(`chat_sessions_${wsId ?? "default"}`, JSON.stringify(cacheable));
}

function syncSessionsRemote(wsId: number | null, sessions: ChatSession[]) {
  if (typeof window === "undefined" || wsId == null) return;
  syncSaveSessions(wsId, sessions as import("@/lib/workspace-sync-api").ChatSession[]);
  // Write-through to the user's machine (canonical copy) — best-effort.
  const statePath = sessionsStatePath(wsId);
  if (statePath) {
    void writeStateFile(statePath, JSON.stringify(sessions)).catch(() => {});
  }
}

/* ========================================================================== *
 *  SpecMessage — renders markdown answer + plan steps + collapsible file list
 *  Used for both Spec Gen (files have no content) and Spec Exec (full files)
 * ========================================================================== */
function SpecMessage({
  msg,
  onOpenFile,
  onApproveSpec,
}: {
  msg: SpecMsg;
  onOpenFile?: (path: string) => void;
  onApproveSpec?: (specAnswer: string) => void;
}) {
  const { bumpTreeRevision } = useWorkspace();
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const isExec = msg.kind === "spec-exec";

  return (
    <div className="space-y-2">
      {/* Markdown answer */}
      <div className="chat-prose text-[13px] leading-relaxed text-[var(--ide-text)]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.answer}</ReactMarkdown>
      </div>

      {/* Plan steps */}
      {msg.plan?.subtasks?.length > 0 && (
        <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-bg)] overflow-hidden">
          <button
            type="button"
            onClick={() => setPlanExpanded((v) => !v)}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${planExpanded ? "rotate-90" : ""}`}
            />
            <span className="font-medium">Plan</span>
            <span className="text-[10px] px-1.5 py-px rounded-full bg-sky-600/20 text-sky-300">
              {msg.plan?.subtasks?.length ?? 0} steps
            </span>
          </button>
          {planExpanded && (
            <div className="border-t border-[var(--ide-border)] px-3 py-2 space-y-1">
              {msg.plan?.reasoning && (
                <p className="text-[11px] text-[var(--ide-muted)] italic">{msg.plan.reasoning}</p>
              )}
              <ol className="list-decimal list-inside space-y-0.5">
                {msg.plan?.subtasks?.map((t) => (
                  <li key={t.id} className="text-[11px] text-[var(--ide-text)]">
                    {t.description}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {/* File structure / generated files */}
      {msg.files?.length > 0 && (
        <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-bg)] overflow-hidden">
          <button
            type="button"
            onClick={() => setFilesExpanded((v) => !v)}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${filesExpanded ? "rotate-90" : ""}`}
            />
            <FolderOpen className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="font-medium">{isExec ? "Generated Files" : "Proposed Files"}</span>
            <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-600/20 text-violet-300">
              {msg.files.length}
            </span>
          </button>

          {filesExpanded && (
            <div className="border-t border-[var(--ide-border)] max-h-[200px] overflow-y-auto">
              {msg.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => f.hasContent && onOpenFile?.(f.path)}
                  title={f.purpose}
                  className={`flex items-center gap-2 w-full px-3 py-1 text-left transition-colors ${
                    f.hasContent ? "hover:bg-[var(--ide-hover)] cursor-pointer" : "cursor-default opacity-80"
                  }`}
                >
                  <FileCode2 className="h-3 w-3 text-[var(--ide-muted)] shrink-0" />
                  <span className="text-[11px] text-[var(--ide-text)] truncate flex-1">
                    {f.path}
                  </span>
                  <span className="text-[9px] px-1 py-px rounded bg-[var(--ide-surface-2)] text-[var(--ide-muted)] shrink-0">
                    {f.language}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Footer: View in Explorer */}
          {msg.writtenToWorkspace && (
            <div className="border-t border-[var(--ide-border)] px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => bumpTreeRevision()}
                className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
              >
                View in Explorer
              </button>
            </div>
          )}
        </div>
      )}

      {/* Approve & Execute — only on spec-gen messages */}
      {!isExec && onApproveSpec && (
        <button
          type="button"
          onClick={() => onApproveSpec(msg.answer)}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-medium transition-colors"
        >
          <Check className="h-3 w-3" />
          Approve &amp; Execute
        </button>
      )}
    </div>
  );
}

/* ========================================================================== *
 *  AUTO mode timeline pieces — a DevSphere AI agent run renders its events in
 *  arrival order (Copilot-style step-by-step). SPEC mode never uses any of these.
 * ========================================================================== */

/* Read-only unified-diff viewer. Phase 2 will wrap this with accept/reject;
   keeping it standalone means that upgrade is zero-rework. */
function DiffViewer({ path, diff }: { path?: string; diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-bg)] overflow-hidden">
      {path && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-[var(--ide-border)] text-[10px] font-mono text-[var(--ide-muted)]">
          <FileCode2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{path}</span>
        </div>
      )}
      <pre className="overflow-x-auto text-[10.5px] leading-[1.5] font-mono py-1">
        {lines.map((ln, i) => {
          const isMeta = ln.startsWith("@@") || ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ");
          const isAdd = !isMeta && ln.startsWith("+");
          const isDel = !isMeta && ln.startsWith("-");
          const cls = isMeta
            ? "text-sky-400/70 bg-sky-500/5"
            : isAdd
              ? "text-emerald-300 bg-emerald-500/10"
              : isDel
                ? "text-red-300 bg-red-500/10"
                : "text-[var(--ide-muted)]";
          return <div key={i} className={`px-2.5 ${cls}`}>{ln || " "}</div>;
        })}
      </pre>
    </div>
  );
}

/* Reasoning block (thinking) — shown expanded by default so the agent's
   thinking is visible in the chat; click the header to collapse it. */
function TimelineThinking({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="rounded-md border border-sky-500/20 bg-sky-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-[var(--ide-hover)] transition-colors"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Brain className="h-3 w-3 shrink-0 text-sky-400" />
        <span className="text-[11px] font-medium text-sky-300">Thinking</span>
      </button>
      {expanded && (
        <div className="px-3 py-1.5 border-t border-sky-500/15 text-[11px] leading-relaxed text-[var(--ide-muted)] italic whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
}

/* Per-tool icon — mirrors how Claude Code icons its tool calls. */
const TOOL_ICON: Record<string, LucideIcon> = {
  read_file: FileText,
  batch_read_files: FileText,
  file_write: FilePlus,
  create_output: FilePlus,
  code_edit: Pencil,
  notebook_edit: Pencil,
  grep_search: Search,
  file_search: FolderOpen,
  list_directory: ListTree,
  workspace_tree: ListTree,
  run_terminal: Terminal,
  git: GitBranch,
  web_fetch: Globe,
  web_search: Globe,
  lsp: Code2,
  sub_agent: Bot,
};

/* Safely parse a tool's JSON result string (may be truncated → null). */
function parseObservation(observation: string | null | undefined): Record<string, unknown> | null {
  if (!observation) return null;
  try {
    const v = JSON.parse(observation);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* One tool call — Claude-Code style: icon + label + target, a result badge on
   the right, an inline diff for edits, and collapsible raw output. */
function TimelineToolRow({
  item,
  onOpenFile,
  runActive,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  onOpenFile?: (path: string) => void;
  /** True only while the run is still streaming — a pending tool spins only then. */
  runActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const path = typeof item.input?.path === "string" ? item.input.path : null;
  // No result yet. It only "spins" while the run is live; once the run is
  // stopped/errored/done, a pending tool was interrupted, not still working.
  const pending = item.observation == null;
  const interrupted = pending && !runActive;

  const Icon = TOOL_ICON[item.tool] ?? Wrench;
  const label = toolLabel(item.tool);
  const target = toolTarget(item.tool, item.input);
  const parsed = parseObservation(item.observation);
  const summary = item.isError ? null : toolResultSummary(item.tool, item.observation);
  const diff = typeof parsed?.diff === "string" ? (parsed.diff as string) : null;
  // Diffs render inline (like Claude Code); other output is collapsible.
  const hasRawOutput = item.observation != null && !diff;

  return (
    <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-bg)] overflow-hidden">
      {/* A <div> with button semantics, NOT a <button>: the row contains the
          nested "open file" button, and <button> inside <button> is invalid
          HTML (hydration error). */}
      <div
        role={hasRawOutput ? "button" : undefined}
        tabIndex={hasRawOutput ? 0 : undefined}
        onClick={() => hasRawOutput && setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (hasRawOutput && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className={`flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left transition-colors ${
          hasRawOutput ? "cursor-pointer hover:bg-[var(--ide-hover)]" : ""
        }`}
      >
        {interrupted
          ? <Ban className="h-3 w-3 shrink-0 text-[var(--ide-muted)]" />
          : pending
            ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ide-muted)]" />
            : item.isError
              ? <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
              : <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
        <Icon className={`h-3 w-3 shrink-0 ${item.isError ? "text-red-400" : "text-amber-400"}`} />
        <span className={`text-[11px] font-semibold ${item.isError ? "text-red-400" : "text-violet-300"}`}>{label}</span>
        {target && (
          path && onOpenFile ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenFile(path); }}
              title={`Open ${path}`}
              className="text-[10.5px] font-mono text-[var(--ide-muted)] hover:text-violet-300 hover:underline truncate max-w-[220px]"
            >
              {target}
            </button>
          ) : (
            <span className="text-[10.5px] font-mono text-[var(--ide-muted)] truncate max-w-[220px]">{target}</span>
          )
        )}
        {summary && (
          <span className="ml-auto shrink-0 text-[9.5px] font-mono px-1.5 py-px rounded-full bg-[var(--ide-surface-2)] text-[var(--ide-muted)]">
            {summary}
          </span>
        )}
        {hasRawOutput && (
          <ChevronRight className={`${summary ? "" : "ml-auto"} h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
      </div>

      {/* Inline diff for edits — always visible, like Claude Code. */}
      {diff && (
        <div className="border-t border-[var(--ide-border)] p-1.5">
          <DiffViewer diff={diff} />
        </div>
      )}

      {/* Collapsible raw output for everything else. */}
      {expanded && hasRawOutput && (
        <p className={`px-3 py-1.5 border-t border-[var(--ide-border)] text-[10px] font-mono whitespace-pre-wrap break-words ${item.isError ? "text-red-400/80" : "text-[var(--ide-muted)]"}`}>
          {item.observation}
        </p>
      )}
    </div>
  );
}

/* Live terminal block (terminal_start/output/done). */
function TimelineTerminal({ item }: { item: Extract<TimelineItem, { kind: "terminal" }> }) {
  return (
    <div className="rounded-md border border-[var(--ide-border)] bg-black/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-[var(--ide-border)]">
        <Terminal className="h-3 w-3 shrink-0 text-emerald-400" />
        <span className="text-[10.5px] font-mono text-[var(--ide-text)] truncate">{item.command}</span>
        {item.exitCode != null && (
          <span className={`ml-auto text-[10px] font-mono ${item.exitCode === 0 ? "text-emerald-400" : "text-red-400"}`}>
            {item.exitCode === 0 ? "✓ exit 0" : `✗ exit ${item.exitCode}`}
          </span>
        )}
      </div>
      {item.lines.length > 0 && (
        <pre className="max-h-[160px] overflow-auto px-2.5 py-1 text-[10.5px] leading-[1.5] font-mono text-[var(--ide-muted)] whitespace-pre-wrap break-words">
          {item.lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

/* Claude Code-style live working indicator: a shimmering cycling verb +
   elapsed seconds + live token count, always animating while the run is
   active so long silent phases (LLM latency, slow commands) never look
   frozen. Hidden while the agent is parked on an ask_user / permission
   card — nothing is running then, the agent is waiting on the user. */
const WORKING_WORDS = [
  "Thinking", "Cogitating", "Brewing", "Conjuring", "Percolating",
  "Weaving", "Assembling", "Synthesizing", "Orchestrating", "Distilling",
  "Reticulating", "Polishing",
];

function WorkingIndicator({
  startedAt,
  usage,
  activity,
  phaseKey,
}: {
  startedAt?: number;
  usage?: { total_tokens: number; prompt_tokens?: number; completion_tokens?: number };
  activity?: string;
  /** Changes when the agent moves to a new step — drives the verb swap. */
  phaseKey?: string | number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The verb changes when the agent actually moves to a new phase, not on a
  // timer. A word that ticks over every 3 seconds while nothing happens is
  // decoration; a word that changes when the agent takes its next step is
  // information — the user can see progress in the one place a long silent
  // LLM call otherwise shows none. Random with no immediate repeat, so two
  // consecutive phases never look like a frozen screen.
  const [word, setWord] = useState(() => WORKING_WORDS[0]);
  const wordRef = useRef(word);
  useEffect(() => {
    const pool = WORKING_WORDS.filter((w) => w !== wordRef.current);
    const next = pool[Math.floor(Math.random() * pool.length)];
    wordRef.current = next;
    setWord(next);
  }, [phaseKey]);

  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  // A concrete activity (running a command, writing a file) always beats
  // whimsy — naming the real work is more useful than a mood word.
  const label = activity ?? word;
  // Input and output split rather than one summed figure: they price
  // differently, and "12.4k up / 3.1k down" says what the run is doing in a
  // way a single growing number never does. The context gauge in the composer
  // covers the other question (how full the window is).
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const tokenLabel =
    usage == null
      ? ""
      : usage.prompt_tokens != null && usage.completion_tokens != null
        ? `${fmt(usage.prompt_tokens)}↑ ${fmt(usage.completion_tokens)}↓`
        : `${fmt(usage.total_tokens)} tokens`;

  return (
    <p className="inline-flex items-center gap-1.5 text-[11px]" aria-live="polite">
      {/* Rotating glyph rather than a pulse: rotation reads as "still moving"
          even when the verb and the elapsed second both hold steady. */}
      <span className="ide-spin-slow inline-block text-violet-400">✳</span>
      <span className="font-medium text-violet-300">{label}…</span>
      <span className="text-[10px] font-mono text-[var(--ide-muted)]">
        {elapsed}s{tokenLabel ? ` · ${tokenLabel}` : ""}
      </span>
    </p>
  );
}

/* Live todo checklist (task_manager `tasks` events) — Claude Code's TodoWrite
   widget: one block per run, statuses update in place as the agent works. */
function TimelineTasks({ item }: { item: Extract<TimelineItem, { kind: "tasks" }> }) {
  const statusIcon = (status: string) => {
    switch (status) {
      case "done":
        return <Check className="h-3 w-3 shrink-0 text-emerald-400" />;
      case "in_progress":
        return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-violet-400" />;
      case "blocked":
        return <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />;
      case "skipped":
        return <Ban className="h-3 w-3 shrink-0 text-[var(--ide-muted)]" />;
      default: // pending
        return <span className="h-3 w-3 shrink-0 flex items-center justify-center"><span className="h-2 w-2 rounded-full border border-[var(--ide-muted)]" /></span>;
    }
  };
  return (
    <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-[var(--ide-border)]">
        <ListTodo className="h-3 w-3 shrink-0 text-violet-400" />
        <span className="text-[11px] font-semibold text-violet-300">Todos</span>
        <span className="ml-auto text-[10px] font-mono text-[var(--ide-muted)]">
          {item.done}/{item.total}
        </span>
      </div>
      <ul className="px-2.5 py-1.5 space-y-1">
        {item.tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-1.5">
            <span className="mt-[3px]">{statusIcon(t.status)}</span>
            <span
              className={`text-[11.5px] leading-snug ${
                t.status === "done" || t.status === "skipped"
                  ? "line-through text-[var(--ide-muted)]"
                  : t.status === "in_progress"
                    ? "text-[var(--ide-text)] font-medium"
                    : "text-[var(--ide-text)]"
              }`}
            >
              {t.title}
              {t.note ? <span className="text-[10px] text-[var(--ide-muted)]"> — {t.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* One delegated sub-agent. Its tool calls render INSIDE this card rather than
   on the main timeline — during a parallel fan-out three agents' activity
   would otherwise interleave into one unreadable stream.

   "unverified" is called out deliberately: it means the agent changed code but
   ran no build or test, so the work is NOT confirmed. Showing that as a plain
   success is how confidently-wrong output reaches the user. */
function TimelineSubAgent({
  item,
  siblings = [],
}: {
  item: Extract<TimelineItem, { kind: "subagent" }>;
  siblings?: SubagentNode[];
}) {
  const running = item.status === "running";
  const unverified = item.status === "unverified";
  const failed = item.status === "failed" || item.status === "error" || item.status === "stopped";

  // Collapsed by default. With several agents in flight, expanding every one
  // by default produced a wall of tool rows that buried the actual progress —
  // the header alone has to answer "what is it doing, is it stuck?".
  const [open, setOpen] = useState(false);

  // Elapsed-time clock, ticking only while running — the signal that tells a
  // user "slow" apart from "stuck" instead of a static line that looks the
  // same either way.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const elapsed = item.startedAt ? Math.max(0, Math.floor((now - item.startedAt) / 1000)) : 0;

  const done = item.children.filter((c) => c.observation != null).length;
  // The one line that matters while running: what it is doing RIGHT NOW. A
  // burst of the same tool (six reads in a row) collapses to a count instead
  // of flickering file-to-file — "Read (6)" rather than six separate lines.
  const tail = item.children[item.children.length - 1];
  let repeatCount = 0;
  for (let i = item.children.length - 1; i >= 0 && item.children[i].tool === tail?.tool; i--) repeatCount++;
  const activity =
    tail == null
      ? item.task
      : repeatCount > 1
        ? `${toolLabel(tail.tool)} (${repeatCount})`
        : tail.description || toolLabel(tail.tool);
  const errors = item.children.filter((c) => c.isError).length;

  const accent = running
    ? "text-violet-300"
    : unverified
      ? "text-amber-300"
      : failed
        ? "text-red-300"
        : "text-emerald-300";

  // Grandchildren indent under their parent instead of reading as peers.
  const indent = Math.max(0, (item.depth ?? 1) - 1);

  // How much work hangs beneath this agent, and where it sits in the tree. With
  // nesting on, a collapsed row that says "+4" tells the user this one card
  // stands for five agents' work — without it, a deep fan-out looks flat.
  const descendants = descendantCount(item.agentId, siblings);
  const lineage = lineagePath(item.agentId, siblings);

  return (
    <div style={{ marginLeft: indent * 14 }}>
      <div className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface)] overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-2.5 py-1 text-left hover:bg-[var(--ide-hover)]"
        >
          {running ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-violet-400" />
          ) : unverified ? (
            <AlertCircle className="h-3 w-3 shrink-0 text-amber-400" />
          ) : failed ? (
            <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
          ) : (
            <Check className="h-3 w-3 shrink-0 text-emerald-400" />
          )}

          <span className={`text-[11px] font-semibold shrink-0 ${accent}`}>{item.role}</span>

          {descendants > 0 && (
            <span
              className="text-[10px] font-mono shrink-0 text-violet-400/80"
              title={`${descendants} nested agent${descendants === 1 ? "" : "s"}`}
            >
              +{descendants}
            </span>
          )}

          {/* While running show live activity; once finished show what it
              actually did, not what it was asked to do. */}
          <span className="text-[10.5px] text-[var(--ide-muted)] truncate min-w-0 flex-1">
            {running ? activity : item.summary || item.task}
          </span>

          {/* Background agents run while the parent works on something else —
              without a marker, a card sitting at "running" while the parent
              narrates elsewhere reads as the UI having lost track of it. */}
          {item.background && (
            <span
              className="text-[10px] shrink-0 text-sky-400/80"
              title={
                running
                  ? "Running detached — the main agent is working on something else"
                  : item.notified
                    ? "Finished; its report reached the main agent"
                    : "Finished; waiting to report to the main agent"
              }
            >
              {running ? "background" : item.notified ? "reported" : "done · reporting"}
            </span>
          )}
          {item.resumed && (
            <span className="text-[10px] shrink-0 text-violet-400/80" title="Continued with its earlier context">
              resumed
            </span>
          )}
          {item.retried && <span className="text-[10px] shrink-0 text-amber-400/80">retried</span>}
          {errors > 0 && (
            <span className="text-[10px] shrink-0 text-red-400/80">{errors} failed</span>
          )}
          <span className="text-[10px] font-mono shrink-0 text-[var(--ide-muted)]">
            {running ? `${done}/${item.children.length} · ${elapsed}s` : item.status}
          </span>
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>

        {open && (
          <div className="px-2.5 py-1.5 space-y-1 border-t border-[var(--ide-border)]">
            {/* Where this agent sits in the spawn tree. Only worth showing once
                nesting is actually in play — at depth 1 it's just "main › me". */}
            {lineage.length > 2 && (
              <p className="text-[10px] font-mono text-[var(--ide-muted)]">
                {lineage.join(" › ")}
              </p>
            )}

            <p className="text-[11px] leading-snug text-[var(--ide-text)]">{item.task}</p>

            <p className="text-[10px] font-mono text-[var(--ide-muted)]">
              {item.ownsPaths && item.ownsPaths.length > 0
                ? `writes ${item.ownsPaths.join(", ")}`
                : "read-only"}
              {item.model ? ` · ${item.model}` : ""}
            </p>

            {item.children.length > 0 && (
              <ul className="space-y-0.5 border-l border-[var(--ide-border)] pl-2 mt-1">
                {item.children.map((c, j) => (
                  <li key={j} className="flex items-center gap-1.5">
                    <span
                      className={`h-1 w-1 rounded-full shrink-0 ${
                        c.isError
                          ? "bg-red-400"
                          : c.observation != null
                            ? "bg-emerald-400"
                            : "bg-violet-400"
                      }`}
                    />
                    <span className="text-[10.5px] text-[var(--ide-muted)] truncate">
                      {c.description || c.tool}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {item.filesChanged && item.filesChanged.length > 0 && (
              <p className="text-[10px] font-mono text-[var(--ide-muted)] break-all">
                {item.filesChanged.join(", ")}
              </p>
            )}
          </div>
        )}

        {/* Never hidden behind a collapse: the work is NOT confirmed. */}
        {unverified && (
          <p className="px-2.5 pb-1.5 text-[10.5px] text-amber-400/90">
            Changed files but ran no build or test — this work is not verified.
          </p>
        )}
      </div>
    </div>
  );
}

/* Interactive clarification prompt (ask_user). Renders ONE card with ALL the
   agent's questions (Copilot/Claude style), collects every answer, and submits
   them together as the next message on the same thread. Falls back to a single
   question when the agent only asked one. */
function AskUserBlock({
  item,
  onAnswer,
  disabled,
}: {
  item: Extract<TimelineItem, { kind: "ask_user" }>;
  onAnswer?: (text: string) => void;
  disabled?: boolean;
}) {
  const questions = useMemo(
    () =>
      item.questions && item.questions.length > 0
        ? item.questions
        : [{ question: item.question, options: item.options, allowMultiple: false }],
    [item],
  );

  const [answered, setAnswered] = useState(false);
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState<string[][]>(() => questions.map(() => []));
  const [free, setFree] = useState<string[]>(() => questions.map(() => ""));
  const done = answered || disabled;
  const multi = questions.length > 1;
  const last = step === questions.length - 1;

  const answerFor = (i: number) => (free[i]?.trim() ? free[i].trim() : (sel[i] ?? []).join(", "));
  const allAnswered = questions.every((_, i) => answerFor(i).length > 0);

  const toggle = (i: number, opt: string, allowMultiple?: boolean) => {
    if (done) return;
    setSel((prev) => {
      const next = prev.map((a) => [...a]);
      if (allowMultiple) {
        next[i] = next[i].includes(opt) ? next[i].filter((o) => o !== opt) : [...next[i], opt];
      } else {
        next[i] = [opt];
      }
      return next;
    });
    if (!allowMultiple) setFree((prev) => { const n = [...prev]; n[i] = ""; return n; });
  };

  const setFreeAt = (i: number, v: string) =>
    setFree((prev) => { const n = [...prev]; n[i] = v; return n; });

  const submit = () => {
    if (done || !onAnswer || !allAnswered) return;
    setAnswered(true);
    const composed =
      questions.length === 1
        ? answerFor(0) // single question → send the plain answer (back-compat)
        : questions.map((q, i) => `${i + 1}. ${q.question}\n→ ${answerFor(i)}`).join("\n\n");
    onAnswer(composed);
  };

  /* One question rendered per panel — Copilot-style wizard when multi. */
  const q = questions[step];

  return (
    <div className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 space-y-2.5">
      {/* Header: title + progress */}
      <div className="flex items-center gap-1.5">
        <HelpCircle className="h-3.5 w-3.5 shrink-0 text-sky-400" />
        <span className="text-[11px] font-medium text-sky-300">
          {multi ? "A few quick questions" : "Quick question"}
        </span>
        {multi && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-[var(--ide-muted)]">
              {step + 1} / {questions.length}
            </span>
            <span className="flex gap-1">
              {questions.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 w-1.5 rounded-full ${
                    i === step ? "bg-sky-400" : answerFor(i) ? "bg-emerald-400/80" : "bg-[var(--ide-border)]"
                  }`}
                />
              ))}
            </span>
          </span>
        )}
      </div>

      {item.context && <p className="text-[10px] text-[var(--ide-muted)]">{item.context}</p>}

      {!done ? (
        <>
          {/* Current question, numbered */}
          <p className="text-[12.5px] text-[var(--ide-text)]">
            {multi && <span className="font-semibold text-sky-300 mr-1">Q{step + 1}.</span>}
            {q.question}
          </p>

          {/* Numbered suggestion chips — horizontal row */}
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => {
                const active = (sel[step] ?? []).includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggle(step, opt, q.allowMultiple)}
                    className={`inline-flex items-center h-7 px-2.5 rounded-md text-[11px] transition-colors ${
                      active ? "bg-sky-500 text-white" : "bg-sky-600/40 hover:bg-sky-500/70 text-white"
                    }`}
                  >
                    <span className={`mr-1.5 text-[9.5px] font-mono ${active ? "opacity-90" : "opacity-60"}`}>
                      {oi + 1}.
                    </span>
                    {opt}
                    {q.allowMultiple && active && <Check className="h-3 w-3 ml-1" />}
                  </button>
                );
              })}
            </div>
          )}

          <input
            value={free[step] ?? ""}
            onChange={(e) => setFreeAt(step, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && answerFor(step)) {
                if (last) { if (allAnswered) submit(); }
                else setStep((s) => s + 1);
              }
            }}
            placeholder={q.options && q.options.length ? "…or type your own answer" : "Type an answer…"}
            className="w-full h-7 px-2 rounded bg-[var(--ide-surface)] border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)] focus:outline-none focus:border-sky-500"
          />

          {/* Footer: Back · Next / Submit */}
          <div className="flex items-center gap-1.5">
            {multi && (
              <button
                type="button"
                disabled={step === 0}
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="inline-flex items-center h-7 px-2.5 rounded-md border border-[var(--ide-border)] text-[11px] text-[var(--ide-text)] hover:bg-[var(--ide-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="h-3 w-3 rotate-180 mr-0.5" /> Back
              </button>
            )}
            {multi && !last ? (
              <button
                type="button"
                disabled={!answerFor(step)}
                onClick={() => setStep((s) => s + 1)}
                className="inline-flex items-center h-7 px-3 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-medium transition-colors"
              >
                Next <ChevronRight className="h-3 w-3 ml-0.5" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!allAnswered}
                onClick={submit}
                className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-medium transition-colors"
              >
                <Check className="h-3 w-3" /> {multi ? "Submit answers" : "Send"}
              </button>
            )}
          </div>
        </>
      ) : (
        /* Answered — compact summary of every Q → A */
        <div className="space-y-0.5">
          {questions.map((qq, i) => (
            <p key={i} className="text-[10.5px] text-[var(--ide-muted)]">
              <span className="font-mono text-sky-400/80">Q{i + 1}.</span> {qq.question}{" "}
              <span className="text-emerald-400">→ {answerFor(i) || "—"}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* What a sensitive_ops category means, in the user's words. The backend sends
   the category id; the wording lives here so the card can be read at a glance
   without the user knowing what a "category" is.

   Why this exists at all: a card that says only "run_terminal" teaches people
   to click Approve without reading. Naming the stake — credentials, schema,
   deployment — is the difference between consent and a reflex. */
const PERMISSION_CATEGORY: Record<string, { label: string; hint: string }> = {
  secrets:        { label: "Credentials",   hint: "Touches secret configuration (.env, keys, credentials)" },
  database:       { label: "Database",      hint: "Changes database schema or data" },
  infrastructure: { label: "Deployment",    hint: "Changes deployment or infrastructure configuration" },
  vcs_publish:    { label: "Publish",       hint: "Publishes or rewrites version-control history" },
  dependencies:   { label: "Dependencies",  hint: "Installs or changes project dependencies" },
  services:       { label: "Services",      hint: "Starts, stops or reconfigures a running service" },
};

/* WHAT the pending call will do. Rendered above the buttons, expanded by
   default.

   Expanded, not collapsed: a preview you have to click to see is a preview
   most people never look at, and the entire point of the card is that the
   decision is informed. It collapses for the cases where it would dominate
   the chat — a long file write — and the header always states the size, so
   collapsing never hides the fact that something big is about to happen. */
function ChangePreviewBlock({ preview }: { preview: ChangePreview }) {
  // Big content starts collapsed; a diff or a command never does. A 400-line
  // generated file pushes the Approve button off-screen, which is its own
  // kind of failure — the user scrolls past the decision instead of making it.
  const bulky = preview.kind === "content" && (preview.lines ?? 0) > 40;
  const [open, setOpen] = useState(!bulky);

  const label =
    preview.kind === "diff"
      ? "Proposed change"
      : preview.kind === "content"
        ? "Contents to be written"
        : "Command to run";

  const body =
    preview.kind === "diff" ? (
      <DiffViewer path={preview.path} diff={preview.diff ?? ""} />
    ) : (
      <pre className="rounded-md border border-[var(--ide-border)] bg-[var(--ide-bg)] px-2.5 py-1.5 overflow-x-auto text-[10.5px] leading-[1.5] font-mono text-[var(--ide-text)] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
        {preview.kind === "command" ? preview.command : preview.content}
      </pre>
    );

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-[var(--ide-muted)] transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">{label}</span>
        {preview.summary && (
          <span className="text-[10px] font-mono text-[var(--ide-muted)] truncate">
            {preview.summary}
          </span>
        )}
      </button>
      {open && body}
      {preview.truncated && (
        // Silent truncation reads as "that is the whole change". Say it.
        <p className="text-[10px] text-amber-400/90">
          Preview shortened — the full change is larger than shown.
        </p>
      )}
    </div>
  );
}

/* Approve/reject card (manual mode) — shown before a change runs. The user's
   choice is POSTed to the paused agent, which then runs or skips it. Manages
   its own decided state (like AskUserBlock) so the buttons lock in. */
function PermissionCard({
  item,
  onDecide,
  disabled,
}: {
  item: Extract<TimelineItem, { kind: "permission" }>;
  onDecide?: (id: string, decision: PermissionDecision) => void;
  disabled?: boolean;
}) {
  const [decided, setDecided] = useState<PermissionDecision | null>(null);
  const Icon = TOOL_ICON[item.tool] ?? Wrench;
  const label = toolLabel(item.tool);
  const target = toolTarget(item.tool, item.input);
  const command = typeof item.input?.command === "string" ? item.input.command : null;
  const cat = item.category ? PERMISSION_CATEGORY[item.category] : undefined;
  const choose = (d: PermissionDecision) => {
    if (decided || disabled || !onDecide) return;
    setDecided(d);
    onDecide(item.id, d);
  };
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-2">
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="text-[12px] font-medium text-[var(--ide-text)]">Permission required</span>
        {cat && (
          <span
            title={cat.hint}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/25 text-amber-200 border border-amber-400/30"
          >
            {cat.label}
          </span>
        )}
      </div>
      {cat && <p className="text-[10.5px] text-amber-200/90">{cat.hint}</p>}
      <div className="flex items-center gap-1.5 text-[11px]">
        <Icon className="h-3 w-3 shrink-0 text-amber-400" />
        <span className="font-semibold text-violet-300">{label}</span>
        {target && <span className="font-mono text-[var(--ide-muted)] truncate max-w-[240px]">{target}</span>}
      </div>
      {/* The preview supersedes the old command-only block: it covers diffs
          and file contents too, and it is redacted server-side. `command` is
          kept as the fallback for a stale backend that sends no preview — an
          approval card must never regress to naming a tool and nothing else. */}
      {item.preview ? (
        <ChangePreviewBlock preview={item.preview} />
      ) : command ? (
        <pre className="text-[10.5px] font-mono text-[var(--ide-muted)] bg-black/30 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-words">
          {command}
        </pre>
      ) : null}
      {!decided ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => choose("allow")}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] transition-colors"
          >
            <Check className="h-3 w-3" /> Approve
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => choose("allow_session")}
            title="Stop asking for the rest of this session — the agent finishes the whole task without interrupting again"
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-sky-600/80 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] transition-colors"
          >
            <Shield className="h-3 w-3" /> Allow for this session
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => choose("deny")}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-red-600/80 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] transition-colors"
          >
            <Ban className="h-3 w-3" /> Reject
          </button>
        </div>
      ) : (
        <p className="text-[10.5px] text-[var(--ide-muted)]">
          {decided === "deny"
            ? "Rejected — the agent skipped this tool."
            : decided === "allow_session"
              ? "Allowed for this session — nothing else will be gated until the session ends."
              : "Approved."}
        </p>
      )}
    </div>
  );
}

/* Spec-Driven Development — phase approval card (gate_request). The workflow
   is parked until the user reviews the generated files and decides:
   Approve → next phase · Request changes → same phase re-runs with feedback ·
   Abort → workflow stops (files stay on disk). Mirrors PermissionCard's
   self-managed decided state; also locks when gate_result arrives (timeout
   or a decision delivered from another client).
   IMPORTANT: an UNANSWERED gate stays decidable even when the client run is
   no longer "running" — the SSE stream can drop (proxy idle timeout, reload)
   while the workflow is still parked server-side, and the gate_response POST
   still reaches it. Disabling on run status stranded users at the gate. */
function GateCard({
  item,
  onDecide,
  onOpenFile,
  streamLive,
}: {
  item: Extract<TimelineItem, { kind: "gate" }>;
  onDecide?: (gate: string, decision: GateDecision, feedback?: string) => void;
  onOpenFile?: (path: string) => void;
  /** True while this run's SSE stream is still delivering events. */
  streamLive?: boolean;
}) {
  const [decided, setDecided] = useState<GateDecision | null>(null);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  // A decision that arrived via gate_result (other tab, timeout) wins.
  const settled = item.result?.decision ?? decided;

  const choose = (d: GateDecision, fb?: string) => {
    if (settled || !onDecide) return;
    setDecided(d);
    setRevising(false);
    onDecide(item.gate, d, fb);
  };

  // Choice gate (e.g. gate-0 "which convention?"): decisions beyond the
  // standard approve/revise/abort become option buttons — each answers
  // approve + feedback:<option id>, which the parked workflow reads.
  const choiceOptions = (item.decisions ?? []).filter(
    (d) => !["approve", "revise", "abort"].includes(d),
  );

  return (
    <div className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 space-y-2">
      <div className="flex items-center gap-1.5">
        <ListTodo className="h-3.5 w-3.5 shrink-0 text-violet-400" />
        <span className="text-[12px] font-medium text-[var(--ide-text)]">
          Review checkpoint — <span className="capitalize">{item.phase}</span> phase
        </span>
        <span className="text-[9px] px-1.5 py-px rounded-full bg-violet-600/25 text-violet-300 uppercase tracking-wider">{item.gate}</span>
      </div>

      {item.summary && (
        <p className="text-[11px] leading-relaxed text-[var(--ide-muted)] whitespace-pre-wrap">{item.summary}</p>
      )}

      {item.files.length > 0 && (
        <div className="space-y-0.5">
          {item.files.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onOpenFile?.(f)}
              className="flex items-center gap-1.5 text-[10.5px] font-mono text-sky-300 hover:text-sky-200 hover:underline truncate max-w-full"
              title={`Open ${f}`}
            >
              <FilePlus className="h-3 w-3 shrink-0" />
              <span className="truncate">{f}</span>
            </button>
          ))}
        </div>
      )}

      {!settled ? (
        <>
          {choiceOptions.length > 0 ? (
            // Choice gate — one button per option (vertical, with labels).
            <div className="space-y-1.5">
              <div className="flex flex-col gap-1">
                {choiceOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => choose("approve", opt)}
                    className="flex items-start gap-2 w-full px-2.5 py-1.5 rounded-md border border-violet-500/30 bg-violet-600/15 hover:bg-violet-600/30 text-left transition-colors"
                  >
                    <Check className="h-3 w-3 shrink-0 mt-0.5 text-violet-300" />
                    <span className="text-[11px] text-[var(--ide-text)]">
                      <span className="font-medium">{opt}</span>
                      {item.labels?.[opt] && (
                        <span className="text-[var(--ide-muted)]"> — {item.labels[opt]}</span>
                      )}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => choose("abort")}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md self-start text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-red-400 text-[11px] transition-colors"
                >
                  <Ban className="h-3 w-3" /> Cancel workflow
                </button>
              </div>
              {!streamLive && (
                <p className="text-[10px] text-[var(--ide-muted)]">
                  Waiting for your choice — the workflow stays paused until you decide;
                  it then continues in the background and results appear in the workspace.
                </p>
              )}
            </div>
          ) : !revising ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => choose("approve")}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] transition-colors"
                >
                  <Check className="h-3 w-3" /> Approve — next phase
                </button>
                <button
                  type="button"
                  onClick={() => setRevising(true)}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-sky-600/80 hover:bg-sky-500 text-white text-[11px] transition-colors"
                >
                  <HelpCircle className="h-3 w-3" /> Request changes
                </button>
                <button
                  type="button"
                  onClick={() => choose("abort")}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-red-600/80 hover:bg-red-500 text-white text-[11px] transition-colors"
                >
                  <Ban className="h-3 w-3" /> Abort
                </button>
              </div>
              {!streamLive && (
                <p className="text-[10px] text-[var(--ide-muted)]">
                  Waiting for your decision — the workflow stays paused until you choose.
                  After deciding it continues in the background; results appear in the
                  workspace and on your next message.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <textarea
                autoFocus
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should change? (e.g. add rate-limiting requirements)"
                rows={2}
                className="w-full rounded-md bg-black/30 border border-[var(--ide-border)] px-2 py-1.5 text-[11px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] resize-y focus:outline-none focus:border-sky-500/50"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={!feedback.trim()}
                  onClick={() => choose("revise", feedback.trim())}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-sky-600/80 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] transition-colors"
                >
                  <Check className="h-3 w-3" /> Send revision request
                </button>
                <button
                  type="button"
                  onClick={() => { setRevising(false); setFeedback(""); }}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] text-[11px] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-[10.5px] text-[var(--ide-muted)]">
          {settled === "approve"
            ? "Approved — continuing to the next phase."
            : settled === "revise"
              ? `Revision requested${item.result?.feedback || feedback ? `: "${item.result?.feedback ?? feedback}"` : ""} — re-running this phase.`
              : settled === "timeout"
                ? "No decision in time — workflow paused (resumable: send another spec message on this thread)."
                : "Aborted — generated files remain on disk for manual editing."}
        </p>
      )}
    </div>
  );
}

/* ========================================================================== *
 *  AgentRunMessage — AUTO mode only. Streamed answer + step-by-step timeline
 *  for a DevSphere AI agent run. SPEC mode never renders this.
 * ========================================================================== */
function AgentRunMessage({
  msg,
  onOpenFile,
  onAnswer,
  onPermission,
  onGate,
  sending,
  fileAccessReady,
  onGrantAccess,
}: {
  msg: AgentRunMsg;
  onOpenFile?: (path: string) => void;
  onAnswer?: (text: string) => void;
  onPermission?: (id: string, decision: PermissionDecision) => void;
  onGate?: (gate: string, decision: GateDecision, feedback?: string) => void;
  sending?: boolean;
  /** True once local file access is live — hides stale post-run warnings. */
  fileAccessReady?: boolean;
  /** Grant access + refresh the Explorer; returns true on success. */
  onGrantAccess?: () => Promise<boolean>;
}) {
  // Local state for the actionable post-run "Grant Access" warning button.
  const [grantingWarn, setGrantingWarn] = useState(false);
  const [grantWarnError, setGrantWarnError] = useState<string | null>(null);
  // Legacy agent-run messages (persisted by an earlier version) have no
  // `timeline` — default to [] and fall back to `answer` so they never crash.
  const timeline = msg.timeline ?? [];
  const noContentYet = msg.status === "running" && timeline.length === 0 && !msg.answer;
  if (noContentYet) {
    return (
      <div className="flex items-center gap-1.5 pt-1.5">
        <span className="ide-bounce-dot h-2 w-2 rounded-full bg-violet-400" />
        <span className="ide-bounce-dot h-2 w-2 rounded-full bg-violet-400" />
        <span className="ide-bounce-dot h-2 w-2 rounded-full bg-violet-400" />
      </div>
    );
  }

  const lastIdx = timeline.length - 1;
  // Flat view of the spawn tree, shared by every sub-agent card so each can
  // report its descendant count and lineage without re-scanning the timeline.
  const subagentNodes: SubagentNode[] = timeline
    .filter((it): it is Extract<TimelineItem, { kind: "subagent" }> => it.kind === "subagent")
    .map((it) => ({ agentId: it.agentId, role: it.role, parentAgentId: it.parentAgentId }));

  return (
    <div className="space-y-2">
      {/* Internal skill packs (python_backend, security, …) are NOT rendered.
          They are prompt material the backend selects for itself — the user
          never asked for "security", they asked a question, and a chip naming
          our internal file leaks implementation detail while implying the user
          chose it. `msg.skills` is still captured from skills_loaded for
          debugging and analytics; a persona the USER picked stays visible via
          the custom-agent/persona chip, because that one they did choose. */}

      {msg.resumingMessage && (
        <p className="flex items-start gap-1.5 text-[11px] text-sky-300 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5">
          <Loader2 className="h-3.5 w-3.5 shrink-0 mt-px animate-spin" />
          {msg.resumingMessage}
        </p>
      )}

      {/* Actionable post-run warning: files were written but the Explorer can't
         refresh because local access isn't live. A "Grant Access" button here
         grants access AND refreshes the Explorer, so the user never leaves the
         chat. Once access is live (fileAccessReady), the warning auto-clears. */}
      {msg.workspaceWarning && !fileAccessReady && (
        <div className="text-[11px] text-amber-400 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5">
          <p className="flex items-start gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
            {msg.workspaceWarning}
          </p>
          {onGrantAccess && (
            <div className="mt-1.5 pl-5">
              <button
                type="button"
                disabled={grantingWarn}
                onClick={async () => {
                  setGrantWarnError(null);
                  setGrantingWarn(true);
                  let ok = false;
                  try { ok = await onGrantAccess(); } catch { ok = false; }
                  setGrantingWarn(false);
                  if (!ok) {
                    setGrantWarnError("Couldn't get folder access. Make sure the DevAccel daemon is running (or use HTTPS/localhost), then try again.");
                  }
                }}
                className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-[11px] font-medium text-white transition-colors"
              >
                <FolderOpen className="h-3 w-3" />
                {grantingWarn ? "Granting…" : "Grant Access"}
              </button>
              {grantWarnError && <p className="text-[10px] text-red-400 mt-1">{grantWarnError}</p>}
            </div>
          )}
        </div>
      )}

      {/* Hidden for server_default: that's the server's internal directory
          (e.g. /home/azureuser/…) — an implementation detail that shouldn't
          be surfaced to clients. Only show paths the user chose themselves. */}
      {msg.serverWorkspace && msg.serverWorkspace.source !== "server_default" && (
        <p
          className="inline-flex items-center gap-1 text-[10px] font-mono text-[var(--ide-muted)] truncate"
          title={`Server-side tools (terminal, scaffolding) run in this directory (${msg.serverWorkspace.source ?? "resolved"})`}
        >
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate">
            workspace: {msg.serverWorkspace.path}
          </span>
        </p>
      )}

      {/* Attachments: what the server made of each one. "saved" alone was not
          enough — a file can be saved and still be unreadable (a scanned PDF, a
          video), and the user needs to know that BEFORE reading an answer built
          without it. Notes come straight from the extractor. */}
      {msg.savedInputs && msg.savedInputs.length > 0 && (
        <div className="flex flex-col gap-0.5 text-[10px] text-[var(--ide-muted)]">
          {msg.savedInputs.map((f, i) => (
            <p key={i} className="inline-flex items-start gap-1">
              <span>📎</span>
              <span className="truncate max-w-[22rem]" title={f.name}>{f.name}</span>
              <span className="opacity-70">
                {f.label}
                {f.chars > 0 && ` · ${f.chars.toLocaleString()} chars read`}
                {f.images > 0 && ` · ${f.images} image${f.images === 1 ? "" : "s"}`}
              </span>
              {f.notes.length > 0 && (
                <span className="text-amber-500/80" title={f.notes.join("\n")}>⚠</span>
              )}
            </p>
          ))}
        </div>
      )}

      {msg.rejectedInputs && msg.rejectedInputs.length > 0 && (
        <div className="flex flex-col gap-0.5 text-[10px] text-amber-500/90">
          {msg.rejectedInputs.map((reason, i) => (
            <p key={i}>⚠ {reason}</p>
          ))}
        </div>
      )}

      {/* Legacy fallback: an old agent-run message with no timeline but an answer. */}
      {timeline.length === 0 && msg.answer && (
        <div className="chat-prose text-[13px] leading-relaxed text-[var(--ide-text)]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.answer}</ReactMarkdown>
        </div>
      )}

      {timeline.map((item, i) => {
        switch (item.kind) {
          case "text":
            if (!item.text) return null;
            return (
              <div key={i} className="chat-prose text-[13px] leading-relaxed text-[var(--ide-text)]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                {msg.status === "running" && i === lastIdx && !item.done && (
                  <span className="ide-bounce-dot inline-block h-1.5 w-1.5 rounded-full bg-violet-400 ml-0.5" />
                )}
              </div>
            );
          case "thinking":
            return <TimelineThinking key={i} text={item.text} />;
          case "tool":
            return <TimelineToolRow key={i} item={item} onOpenFile={onOpenFile} runActive={msg.status === "running"} />;
          case "subagent":
            return <TimelineSubAgent key={i} item={item} siblings={subagentNodes} />;
          case "terminal":
            return <TimelineTerminal key={i} item={item} />;
          case "tasks":
            return <TimelineTasks key={i} item={item} />;
          case "diff":
            return <DiffViewer key={i} path={item.path} diff={item.diff} />;
          case "ask_user":
            return <AskUserBlock key={i} item={item} onAnswer={onAnswer} disabled={sending} />;
          case "permission":
            // Clickable while the run is live (it's parked waiting on this);
            // locked once the run ends.
            return <PermissionCard key={i} item={item} onDecide={onPermission} disabled={msg.status !== "running"} />;
          case "gate":
            // Spec-driven: the workflow is parked at a phase checkpoint.
            return <GateCard key={i} item={item} onDecide={onGate} onOpenFile={onOpenFile} streamLive={msg.status === "running"} />;
          default:
            return null;
        }
      })}

      {msg.status === "running" && !msg.stopRequested && !msg.answer && (() => {
        const last = timeline[timeline.length - 1];
        // Parked on a question/approval/gate card → the agent is waiting on
        // the user, not working; showing a spinner there would be a lie.
        if (last?.kind === "ask_user" || last?.kind === "permission") return null;
        if (last?.kind === "gate" && !last.result) return null;
        let activity: string | undefined;
        if (last?.kind === "terminal" && last.exitCode == null) activity = "Running command";
        else if (last?.kind === "tool" && last.observation == null) activity = toolLabel(last.tool);
        // Phase = which step we're on and what kind it is. A new tool call, a
        // new text block or a state change on the current one all count as a
        // transition; a slow LLM call in between does not, so the verb holds
        // steady exactly while the agent is genuinely on one thing.
        const phaseKey = `${timeline.length}:${last?.kind ?? "start"}:${activity ?? ""}`;
        return (
          <WorkingIndicator
            startedAt={msg.startedAt}
            usage={msg.usage}
            activity={activity}
            phaseKey={phaseKey}
          />
        );
      })()}

      {msg.stopRequested && msg.status === "running" && (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-400">
          <Loader2 className="h-3 w-3 animate-spin" /> Stopping…
        </p>
      )}

      {msg.status === "stopped" && (
        <p className="text-[11px] text-amber-400">
          {msg.interrupted
            ? "Interrupted — this page reloaded while the run was in flight, so its live updates were lost. The work may have finished on the server; your next message continues the same thread."
            : msg.forcedStop
              ? "Stopped — the connection was closed after the stop request. The server halts at its next step; your next message continues the same thread."
              : "Stopped before completion."}
        </p>
      )}

      {msg.status === "error" && (
        <p className="text-[11px] text-red-400">{msg.errorMessage ?? "The agent run failed."}</p>
      )}

      {msg.quotaNotice && <QuotaBanner notice={msg.quotaNotice} />}

      {(msg.usage || msg.runSummary) && (
        <p className="inline-flex items-center flex-wrap gap-1.5 text-[10px] text-[var(--ide-muted)]">
          {msg.usage && <TokenBadge usage={msg.usage} />}
          {msg.contextState && (
            <span
              className="opacity-70"
              title={`The window was ${msg.contextState.pct.toFixed(0)}% full on the last step (${msg.contextState.used.toLocaleString()} of ${msg.contextState.window.toLocaleString()})`}
            >
              · {msg.contextState.pct.toFixed(0)}% context
            </span>
          )}
          {msg.runModel?.name && (
            <span className="opacity-70" title={msg.runModel.degraded ? "Downgraded because a token budget was reached" : "Model this run used"}>
              · {msg.runModel.name}
              {msg.runModel.degraded ? " (budget)" : ""}
            </span>
          )}
          {msg.compactions ? (
            <span className="opacity-70" title="History was compressed to free context">
              · compacted {msg.compactions}×
            </span>
          ) : null}
          {msg.runSummary && (
            <span className="opacity-70">
              · {msg.runSummary.steps_taken} step{msg.runSummary.steps_taken === 1 ? "" : "s"} · {msg.runSummary.status}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/* ========================================================================== *
 *  ChatDock — AI assistant with full session management + window controls
 * ========================================================================== */
export function ChatDock({
  onClose,
  onOpenFile,
}: {
  onClose?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { workspaceId, bumpTreeRevision, fsHandle, localPathLabel, fileAccessReady, grantFsAccess } = useWorkspace();
  const { projectSelection } = useGlobalProject();

  /* Model picker (beside Send). Reads DevSphere's OWN entitlements — the
     models this user's role/team/user policy allows — and the choice is
     actually SENT with the run.

     This previously listed the legacy DevAccel platform's per-project model
     configs, which the DevSphere agent never consulted: picking an entry
     changed nothing. A picker that doesn't pick is worse than no picker.

     An empty list means no catalogue is configured and every run uses the
     backend's .env deployment, so the control hides itself rather than
     offering a choice that doesn't exist. */
  const [modelMenu, setModelMenu] = useState(false);
  const [allowedModels, setAllowedModels] = useState<AllowedModel[]>([]);
  const [defaultModelKey, setDefaultModelKey] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyModels().then((data) => {
      if (cancelled) return;
      setAllowedModels(data.models);
      setDefaultModelKey(data.default_key);
      // Restore the last choice, but only if it's still allowed — an admin may
      // have revoked it since, and the server would silently fall back anyway.
      const remembered =
        typeof window !== "undefined" ? window.localStorage.getItem(MODEL_CHOICE_KEY) : null;
      setSelectedModelKey(
        remembered && data.models.some((m) => m.key === remembered) ? remembered : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveModelKey = selectedModelKey ?? defaultModelKey;
  const chatModelName =
    allowedModels.find((m) => m.key === effectiveModelKey)?.display_name ?? null;

  const chooseModel = useCallback((key: string) => {
    setSelectedModelKey(key);
    setModelMenu(false);
    try {
      window.localStorage.setItem(MODEL_CHOICE_KEY, key);
    } catch {
      /* private browsing — the choice just won't survive a reload */
    }
  }, []);

  /* In-chat folder-access flow: when a send needs local files but access isn't
     live, we inject an AccessRequestMsg (with the stashed text) instead of
     running; granting from the card auto-resends the stashed message. */
  const [grantingAccess, setGrantingAccess] = useState(false);

  /* Mode: auto = direct generation, spec = spec workflow */
  const [mode, setMode] = useState<"auto" | "spec">("auto");
  const [specSubMode, setSpecSubMode] = useState<"gen" | "exec">("gen");
  const spec = mode === "spec";

  /* Window state */
  const [collapsed,  setCollapsed]  = useState(false);
  const [maximized,  setMaximized]  = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  /* Session state — SSR-safe placeholder; hydrated from localStorage in useEffect */
  const [sessions,  setSessions]  = useState<ChatSession[]>([]);
  const sessionsRef = useRef<ChatSession[]>([]);
  const [activeId,  setActiveId]  = useState<string>("");
  const [sessionMenu, setSessionMenu] = useState(false);
  const [sending, setSending] = useState(false);

  /* Inline rename */
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  /* Composer */
  const [input, setInput] = useState("");

  /* AUTO mode only — file attachments sent to the DevSphere AI agent */
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /* Fallback timer: force-abort only if the server never confirms a graceful stop. */
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Agent selector — only used in Spec Exec mode */
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId>("");
  const [agentMenu, setAgentMenu] = useState(false);
  const [specMenu, setSpecMenu] = useState(false);
  /* SPEC mode — custom agent rosters generated by the agents phase (gate 4),
     one per .devaccel/agents/<NNN-slug>/agents.md folder, shown as info chips. */
  const [specRosters, setSpecRosters] = useState<SpecRoster[]>([]);
  /* SPEC EXEC — which .devaccel/spec/<NNN-slug> feature to execute. Sent as
     spec_feature so execution works outside the thread that ran generation.
     Auto-selected (newest feature); no picker UI — the visible chip is the
     agents.md roster. */
  const [specFeature, setSpecFeature] = useState<string | null>(null);

  /* CUSTOM AGENTS — file-convention discovery (BMAD / Claude Code model).
     Every .md under .devaccel/agents/, .claude/agents/ or a BMAD install
     appears here automatically — generated by the agent builder OR copied
     in by the user. Selecting one runs the next turns AS that agent
     (agent_name + its file + its skills' SKILL.md go with the request). */
  const [customAgents, setCustomAgents] = useState<CustomAgentEntry[]>([]);
  const [customSkills, setCustomSkills] = useState<SkillEntry[]>([]);
  /* The PINNED agent, if the user chose one from the model menu. Null is the
     normal case: the model picks from the catalog itself. Also set by the
     persona_active event, so an agent the model adopted stays in character
     across the next messages. */
  const [selectedCustomAgent, setSelectedCustomAgent] = useState<string | null>(null);
  /* The pinned agent resolved against what actually exists — a selection
     naming an agent that has since been deleted must not label the button
     after a file that is gone. */
  const pinnedAgent = selectedCustomAgent
    ? customAgents.find((a) => a.agent.name === selectedCustomAgent) ?? null
    : null;

  /* AUTO mode only — tool-access mode sent as permission_mode on every request. */
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("manual");
  const [permissionMenu, setPermissionMenu] = useState(false);
  /* AUTO mode only — allow_tools whitelist, only meaningful (and only sent) in Strict mode. */
  /* AUTO mode only — deny_tools blocklist. Independent of permission mode — the
     backend applies this "in all modes including auto" — so unlike allow_tools
     it's not gated to Strict. Empty by default (nothing extra blocked). */
  const [deniedTools, setDeniedTools] = useState<Set<string>>(new Set());
  const [denyMenu, setDenyMenu] = useState(false);

  /* Refs */
  const menuRef       = useRef<HTMLDivElement>(null);
  const agentMenuRef  = useRef<HTMLDivElement>(null);
  const specMenuRef   = useRef<HTMLDivElement>(null);
  const permMenuRef   = useRef<HTMLDivElement>(null);
  const denyMenuRef   = useRef<HTMLDivElement>(null);
  const modelMenuRef  = useRef<HTMLDivElement>(null);
  const listRef      = useRef<HTMLDivElement>(null);
  const editRef      = useRef<HTMLInputElement>(null);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];

  /* Context occupancy for the composer's gauge: the most recent agent run in
     this session that reported one. Deliberately NOT cleared when a run ends —
     the window stays as full as the last run left it, and the next message
     starts from there. Showing an empty gauge between runs would suggest the
     history had been dropped. */
  const liveContextState = useMemo(() => {
    const msgs = activeSession?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (m.kind === "agent-run" && m.contextState) return m.contextState;
    }
    return null;
  }, [activeSession?.messages]);

  /* SPEC mode — the custom agent roster (agents.md). Server-side parse first;
     for client-side workspaces the server never sees agents.md (404 → []), so
     read the client copy: the agent writes via FileAccess (daemon / FS-API) to
     the real local folder, uploads live in IndexedDB.
     Extracted into a callable so the roster can ALSO be refreshed on demand
     (opening the Spec dropdown) — the effect-only version could load once at
     the wrong moment (file not written yet / access not bound yet) and then
     never retry, leaving Execution permanently disabled even though agents.md
     existed on disk. */
  const [rosterLoading, setRosterLoading] = useState(false);
  const rosterSeq = useRef(0);
  const refreshSpecRoster = useCallback(async () => {
    const seq = ++rosterSeq.current; // stale-response guard (thread/ws switches)
    setRosterLoading(true);
    try {
      const threadId = activeSession?.threadId;
      let features: string[] = [];
      const rosters: SpecRoster[] = [];
      if (workspaceId != null) {
        // Executable features — .devaccel/spec/<NNN-slug>/tasks.md folders.
        // Scanned FIRST because the agents roster lives per feature now, and
        // spec files may live under a project subfolder, so the tree tells us
        // where agents.md actually is. Same source ladder the editor uses:
        // live scan (daemon/FS-API) → IndexedDB → server tree.
        const access = resolveWorkspaceFileAccess(workspaceId);
        let nodes: WsNode[] | null = access ? await access.scan().catch(() => null) : null;
        if (!nodes || nodes.length === 0) nodes = await getAllNodes(workspaceId).catch(() => null);
        if (!nodes || nodes.length === 0) nodes = await fetchWorkspaceTree(workspaceId).catch(() => null);
        if (nodes) features = findSpecFeatures(nodes);

        // EVERY per-feature roster in the tree — not just the newest feature's.
        // Prefer the shortest path per feature (root copy over a nested one).
        const featurePaths = new Map<string, string>();
        for (const n of nodes ?? []) {
          if (n.type !== "file" || n.deleted) continue;
          const m = AGENTS_FEATURE_MD_RE.exec(n.path);
          if (!m) continue;
          const prev = featurePaths.get(m[1]);
          if (!prev || n.path.length < prev.length) featurePaths.set(m[1], n.path);
        }
        // The tree can lag right after generation writes the roster — assume
        // the conventional path for any spec feature the scan missed.
        for (const f of features) {
          if (!featurePaths.has(f)) featurePaths.set(f, `.devaccel/agents/${f}/agents.md`);
        }

        // Same read ladder the editor uses to open files (workspace-api):
        // live folder (daemon/FS-API) → IndexedDB → server file API.
        const readRoster = (path: string) =>
          fetchFileContent(workspaceId, path)
            .then((f) => parseAgentsMd(f.content))
            .catch(() => [] as SpecAgent[]);
        for (const [feature, path] of [...featurePaths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const agents = await readRoster(path);
          if (agents.length > 0) rosters.push({ feature, path, agents });
        }
        if (rosters.length === 0) {
          // No per-feature rosters — agents.md at the workspace root or the
          // NEAREST nested copy, legacy path last.
          const legacyPaths = (nodes ?? [])
            .filter((n) => n.type === "file" && !n.deleted && AGENTS_MD_RE.test(n.path))
            .map((n) => n.path)
            .sort((a, b) => a.length - b.length)
            .concat(AGENTS_MD_PATH)
            .filter((p, i, arr) => arr.indexOf(p) === i);
          for (const path of legacyPaths) {
            const agents = await readRoster(path);
            if (agents.length > 0) { rosters.push({ feature: null, path, agents }); break; }
          }
        }
      }
      if (rosters.length === 0 && threadId) {
        // Server-side parse as the last resort (it resolves the path per
        // thread) — covers threads whose workspace files never reached
        // any client-readable source.
        const agents = await getSpecAgents(threadId);
        if (agents.length > 0) rosters.push({ feature: null, path: AGENTS_MD_PATH, agents });
      }
      // TEMP diagnostics for the "Execution stays disabled" report — remove
      // once the roster reliably loads in all environments.
      console.info(
        `[spec-roster] ws=${workspaceId} thread=${threadId ?? "none"} ` +
        `access=${workspaceId != null ? (resolveWorkspaceFileAccess(workspaceId)?.kind ?? "none") : "none"} ` +
        `ready=${fileAccessReady} features=[${features.join(", ")}] ` +
        `rosters=[${rosters.map((r) => `${r.feature ?? r.path}:${r.agents.length}`).join(", ")}]`,
      );
      if (seq === rosterSeq.current) {
        setSpecRosters(rosters);
        // Default to the newest feature (highest NNN prefix — list is sorted).
        setSpecFeature((cur) =>
          cur && features.includes(cur) ? cur : features[features.length - 1] ?? null,
        );
      }
    } finally {
      if (seq === rosterSeq.current) setRosterLoading(false);
    }
  }, [activeSession?.threadId, workspaceId, fileAccessReady]);

  /* Roster the Execution run will actually use — the selected feature's;
     falls back to the first found (legacy/root file) so the chip and the
     Execution gate still work for pre-per-feature workspaces. */
  const activeRoster = useMemo(
    () => specRosters.find((r) => r.feature != null && r.feature === specFeature) ?? specRosters[0],
    [specRosters, specFeature],
  );
  const specAgents = useMemo(() => activeRoster?.agents ?? [], [activeRoster]);

  /* Refresh whenever spec mode is active on a thread and no run is in flight —
     after a generation run completes gate 4, this picks the new roster up. */
  useEffect(() => {
    if (!spec || sending) return;
    void refreshSpecRoster();
  }, [spec, sending, refreshSpecRoster]);

  /* Execution needs agents — custom agents (agent builder / pasted BMAD) or
     a legacy roster. Drop back to Generation if both disappear (thread
     switch, cleared workspace). Guarded on !sending so approveSpec's
     programmatic switch to exec isn't undone mid-run, and on !rosterLoading
     so a slow read doesn't demote Execution that's about to be valid. */
  useEffect(() => {
    if (!sending && !rosterLoading && specSubMode === "exec"
        && specAgents.length === 0 && customAgents.length === 0) {
      setSpecSubMode("gen");
    }
  }, [sending, rosterLoading, specSubMode, specAgents, customAgents]);

  /* CUSTOM AGENTS discovery — client-side scan of the same file conventions
     the server registry uses (.devaccel/agents, .claude/agents, BMAD
     installs, skills/<name>/SKILL.md), because the workspace usually lives
     on THIS machine; server scan is the fallback for server-visible
     workspaces. Purely file-driven: uploading an existing BMAD agent .md is
     enough for it to appear — no registration step. */
  const customAgentsSeq = useRef(0);
  const refreshCustomAgents = useCallback(async () => {
    const seq = ++customAgentsSeq.current;
    const threadId = activeSession?.threadId;
    const agents: CustomAgentEntry[] = [];
    const skills: SkillEntry[] = [];
    try {
      if (workspaceId != null) {
        // Same source ladder the editor uses: live folder → IndexedDB → server tree.
        const access = resolveWorkspaceFileAccess(workspaceId);
        let nodes: WsNode[] | null = access ? await access.scan().catch(() => null) : null;
        if (!nodes || nodes.length === 0) nodes = await getAllNodes(workspaceId).catch(() => null);
        if (!nodes || nodes.length === 0) nodes = await fetchWorkspaceTree(workspaceId).catch(() => null);

        const agentPaths: string[] = [];
        const stubPaths: Array<{ path: string; name: string }> = [];
        const skillPaths: Array<{ path: string; folder: string }> = [];
        const artifactPaths: Array<{ path: string; kind: string }> = [];
        for (const n of nodes ?? []) {
          if (n.type !== "file" || n.deleted) continue;
          const base = n.path.slice(n.path.lastIndexOf("/") + 1).toLowerCase();
          const kind = classifyPath(n.path);
          if (kind === null) continue;
          if (kind === "agent") {
            if (NON_AGENT_BASENAMES.has(base) && base !== "agents.md") continue;
            const st = COPILOT_STUB_RE.exec(n.path);
            if (st) stubPaths.push({ path: n.path, name: st[1] });
            else agentPaths.push(n.path);
            continue;
          }
          if (kind === "skill") {
            // SKILL.md is named by its FOLDER; any other filename must
            // declare its own name, or a stray file would register itself.
            const folder = base === "skill.md"
              ? (n.path.split("/").slice(-2, -1)[0] ?? "")
              : "";
            skillPaths.push({ path: n.path, folder });
            continue;
          }
          // Supporting material nested inside a skill or agent folder.
          artifactPaths.push({ path: n.path, kind });
        }
        // Skills first — .agents/ sorts before .claude/ and .devaccel/, so
        // the BMAD-canonical copy wins the name dedupe; agents claim their
        // persona folders out of this list below.
        for (const { path, folder } of skillPaths.sort((a, b) => a.path.localeCompare(b.path))) {
          try {
            const f = await fetchFileContent(workspaceId, path);
            // A stacked skills.md holds several definitions; a SKILL.md holds
            // one. parseSkillsMd returns both shapes as a list.
            const parsedList = path.toLowerCase().endsWith("/skills.md")
              ? parseSkillsMd(f.content)
              : [parseSkillMd(f.content, folder)];
            for (const parsed of parsedList) {
              // A nameless parse means the file declared nothing and had no
              // folder to be named after — documentation, not a skill.
              if (parsed?.name && !skills.some((s) => s.name === parsed.name)) {
                skills.push({ ...parsed, path, content: f.content });
              }
            }
          } catch { /* unreadable — skip */ }
        }
        for (const path of agentPaths.sort((a, b) => a.localeCompare(b))) {
          try {
            const f = await fetchFileContent(workspaceId, path);
            const parsed = parseAgentsMd(f.content);
            if (parsed.length > 0) {
              for (const agent of parsed) {
                if (agents.some((a) => a.agent.name === agent.name)) continue;
                agents.push({ agent, path, fileContent: f.content });
              }
              continue;
            }
            // BMAD Core: no frontmatter at all, the definition is a ```yaml
            // block with an `agent:` mapping. Parsed before the stub pass so
            // the agent keeps its real identity — persona "Grace", its title
            // and whenToUse — instead of being named after its file and
            // listed with no description.
            const bmad = parseBmadAgent(f.content, fileStem(path));
            if (bmad) {
              if (!agents.some((a) => a.agent.name === bmad.name)) {
                agents.push({ agent: bmad, path, fileContent: f.content });
              }
              continue;
            }
            // Nothing parsed — but a BMAD v6 STUB is a real agent whose
            // frontmatter carries only `description:`; its name is the
            // filename, and its body points at the canonical SKILL.md. That
            // is the shape a BMAD install drops into .devaccel/agents/, and
            // requiring name+description silently discarded every one of
            // them. Deferred to the stub pass, which resolves the SKILL.md
            // when it exists and keeps a thin persona when it doesn't.
            const stubName = fileStem(path);
            if (stubName) stubPaths.push({ path, name: stubName });
          } catch { /* unreadable — skip */ }
        }
        // BMAD v6: an agent whose canonical content is a skill folder.
        // Claims the folder out of `skills` (a persona is not a plain skill)
        // and uses the full SKILL.md as the definition sent to the server.
        const claimAgentFromSkill = (
          name: string,
          stub?: { path: string; description: string; body: string; raw: string },
        ) => {
          if (agents.some((a) => a.agent.name === name)) return;
          const idx = skills.findIndex((s) => s.name === name);
          if (idx >= 0) {
            const sk = skills[idx];
            const parsed = parseAgentsMd(sk.content)[0];
            agents.push({
              agent: parsed
                ? { ...parsed, name }
                : { name, description: sk.description, tools: [], skills: [], tasks: [], system_prompt: sk.instructions },
              path: sk.path,
              fileContent: sk.content,
            });
            skills.splice(idx, 1);
          } else if (stub) {
            // Stub without a resolvable SKILL.md — usable, just thinner.
            agents.push({
              agent: { name, description: stub.description, tools: [], skills: [], tasks: [], system_prompt: stub.body },
              path: stub.path,
              fileContent: stub.raw,
            });
          }
        };
        for (const { path, name } of stubPaths.sort((a, b) => a.name.localeCompare(b.name))) {
          try {
            const f = await fetchFileContent(workspaceId, path);
            const meta = parseSkillMd(f.content, name);
            claimAgentFromSkill(name, {
              path,
              description: meta?.description ?? "",
              body: meta?.instructions ?? f.content,
              raw: f.content,
            });
          } catch { /* unreadable — skip */ }
        }
        for (const sk of [...skills]) {
          if (sk.name.startsWith(BMAD_AGENT_SKILL_PREFIX)) claimAgentFromSkill(sk.name);
        }

        // Supporting material nested inside a skill or agent folder —
        // its gates, templates and tasks. Listed so the model knows they
        // exist; the kind comes from the folder, and ownership is read
        // off the path server-side.
        for (const { path, kind } of artifactPaths
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, MAX_ARTIFACTS)) {
          try {
            const f = await fetchFileContent(workspaceId, path);
            const parsed = parseSkillMd(f.content, fileStem(path));
            if (parsed?.name && !skills.some((s) => s.name === parsed.name)) {
              skills.push({ ...parsed, kind, path, content: f.content });
            }
          } catch { /* unreadable — skip */ }
        }
      }
      if (agents.length === 0 && threadId) {
        // Server-visible workspace — the backend scans the same conventions;
        // no fileContent needed (the server resolves agent_name itself).
        const scan = await getCustomAgents(threadId);
        for (const agent of (scan?.agents ?? []) as Array<SpecAgent & { source?: string }>) {
          if (!agents.some((a) => a.agent.name === agent.name)) {
            agents.push({ agent, path: agent.source ?? "", fileContent: "" });
          }
        }
        for (const skill of scan?.skills ?? []) {
          if (!skills.some((s) => s.name === skill.name)) {
            skills.push({ ...skill, path: skill.source ?? "", content: skill.instructions });
          }
        }
      }
    } finally {
      if (seq === customAgentsSeq.current) {
        setCustomAgents(agents);
        setCustomSkills(skills);
        // Drop a selection whose file disappeared.
        setSelectedCustomAgent((cur) =>
          cur && agents.some((a) => a.agent.name === cur) ? cur : null,
        );
      }
    }
    // fileAccessReady: re-scan when local folder access binds (same as the
    // spec roster) — the first scan can run before the daemon/FS-API is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.threadId, workspaceId, fileAccessReady]);

  /* Re-discover whenever the dock is idle — picks up files the agent builder
     just scaffolded AND files the user dropped in by hand. */
  useEffect(() => {
    if (sending) return;
    void refreshCustomAgents();
  }, [sending, refreshCustomAgents]);

  /* Entering SPEC → Execution with no agent picked: pre-select the first
     discovered custom agent so Execution is one click away after gate 2. */
  useEffect(() => {
    if (spec && specSubMode === "exec" && !selectedCustomAgent && customAgents.length > 0) {
      setSelectedCustomAgent(customAgents[0].agent.name);
    }
  }, [spec, specSubMode, selectedCustomAgent, customAgents]);

  /* Re-load sessions when workspace changes */
  useEffect(() => {
    let cancelled = false;
    loadSessions(workspaceId).then((loaded) => {
      if (cancelled) return;
      setSessions(loaded);
      setActiveId(loaded[0]?.id ?? "");
    });
    return () => { cancelled = true; };
  }, [workspaceId]);

  /* Persist whenever sessions mutate — skip the empty SSR placeholder */
  useEffect(() => {
    if (sessions.length === 0) return;
    sessionsRef.current = sessions;
    saveSessionsLocal(workspaceId, sessions);
  }, [sessions, workspaceId]);

  /* Pin the view to the top of the newest message when one is added; while a
     reply streams (same message growing) the view stays put instead of
     auto-scrolling to the bottom on every chunk. */
  const lastScrollKeyRef = useRef("");
  useEffect(() => {
    const count = activeSession?.messages.length ?? 0;
    const key = `${activeSession?.id ?? ""}:${count}`;
    if (count === 0 || key === lastScrollKeyRef.current) return;
    lastScrollKeyRef.current = key;
    (listRef.current?.lastElementChild as HTMLElement | null)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeSession?.id, activeSession?.messages]);

  /* Close session dropdown on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setSessionMenu(false);
        setEditingId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* Close agent + spec + permission dropdowns on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setAgentMenu(false);
      }
      if (specMenuRef.current && !specMenuRef.current.contains(e.target as Node)) {
        setSpecMenu(false);
      }
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setPermissionMenu(false);
      }
      if (denyMenuRef.current && !denyMenuRef.current.contains(e.target as Node)) {
        setDenyMenu(false);
      }
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* Focus rename input */
  useEffect(() => {
    if (editingId) setTimeout(() => editRef.current?.focus(), 20);
  }, [editingId]);

  /* AUTO mode only — abort any in-flight agent stream on unmount */
  useEffect(() => () => {
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    abortRef.current?.abort();
  }, []);

  /* ── Session operations ────────────────────────────────────────────────── */
  const handleCreateSession = () => {
    setSessions((prev) => {
      const newSess = makeSess(`Session ${prev.length + 1}`);
      setActiveId(newSess.id);
      return [...prev, newSess];
    });
    setSessionMenu(false);
  };

  const switchSession = (id: string) => {
    setActiveId(id);
    setSessionMenu(false);
    setEditingId(null);
  };

  const startRename = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingName(name);
  };

  const commitRename = () => {
    const trimmed = editingName.trim();
    if (editingId && trimmed) {
      setSessions((prev) =>
        prev.map((s) => (s.id === editingId ? { ...s, name: trimmed } : s)),
      );
    }
    setEditingId(null);
  };

  const duplicateSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const src = sessions.find((s) => s.id === id);
    if (!src) return;
    const copy: ChatSession = {
      ...src,
      id: uuid(),
      name: `${src.name} (copy)`,
      createdAt: Date.now(),
    };
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      setActiveId(copy.id);
      return next;
    });
    setSessionMenu(false);
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions((prev) => {
      if (prev.length === 1) {
        const fresh = makeSess("Session 1");
        setActiveId(fresh.id);
        return [fresh];
      }
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  };

  /* ── AUTO mode only: attachments for the DevSphere AI agent ──────────────
     SPEC mode never reads `attachments` — its send path below is untouched. */
  const handleAttachClick = () => fileInputRef.current?.click();

  const handleFilesPicked = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setAttachments((prev) => [...prev, ...Array.from(fileList)]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (idx: number) =>
    setAttachments((prev) => prev.filter((_, i) => i !== idx));

  /* AUTO mode only — rescan the local folder so the Explorer reflects any file
     edits the agent made on disk (Explorer reads from IndexedDB, not disk). */
  const rescanAfterRun = useCallback(async () => {
    if (workspaceId == null) return;
    // Transport-agnostic: rescan through whichever access backs this workspace —
    // the daemon (HTTP) OR the browser FS handle — so the Explorer reflects the
    // files the agent just wrote, regardless of transport.
    const access = resolveWorkspaceFileAccess(workspaceId);
    if (!access) return;
    try {
      const nodes = await access.scan();
      await replaceNodes(workspaceId, nodes);
      bumpTreeRevision();
    } catch { /* best-effort */ }
  }, [workspaceId, bumpTreeRevision]);

  /* Refresh the Explorer WHILE the agent works, not only when it finishes.
     The Explorer reads from IndexedDB, so a file the agent writes is invisible
     until something rescans the folder. Rescanning only in the run's `finally`
     meant a build that writes 30 files over ten minutes showed an empty tree
     for ten minutes, and users learned to click "Sync local folder" by hand —
     which is the defect, not the workaround.

     Debounced rather than per-event: a scaffold emits writes in bursts, and a
     full directory scan per file would hammer the daemon and thrash the tree.
     One scan ~1.2s after the last write in a burst keeps the Explorer close to
     live while collapsing a burst of 30 into a single scan. */
  const liveRescanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLiveRescan = useCallback(() => {
    if (liveRescanTimer.current) clearTimeout(liveRescanTimer.current);
    liveRescanTimer.current = setTimeout(() => {
      liveRescanTimer.current = null;
      void rescanAfterRun();
    }, 1200);
  }, [rescanAfterRun]);

  // A run that ends (or a component that unmounts) must not leave a scan
  // queued against a workspace the user has already navigated away from.
  useEffect(() => () => {
    if (liveRescanTimer.current) clearTimeout(liveRescanTimer.current);
  }, []);

  /* Grant local folder access AND refresh the Explorer — wired into the
     actionable post-run warning button so the user never leaves the chat. */
  const grantAndRescan = useCallback(async (): Promise<boolean> => {
    const ok = await grantFsAccess();
    if (ok) await rescanAfterRun();
    return ok;
  }, [grantFsAccess, rescanAfterRun]);

  /* ── The DevSphere AI streaming agent — BOTH modes go through here. ──────
     AUTO sends a plain agent turn; SPEC passes specMode ("generation" |
     "execution") so the backend runs the gated SpecWorkflow instead — same
     stream, same timeline rendering, plus gate/spec events. */
  const sendToAutoAgent = useCallback(
    async (text: string, currentActiveId: string, specModeArg?: SpecMode, specFeatureArg?: string) => {
      setSending(true);
      const pendingAttachments = attachments;
      setAttachments([]);

      // The user's copy of an attachment belongs on the USER's disk. Write it
      // into <workspace>/.devaccel/input/ first, then tell the server where it
      // landed — read_file runs on THIS machine, so a server path is a path
      // that tool cannot resolve. Best-effort: with no local folder access the
      // upload still carries the contents, exactly as before.
      const savedLocally = await saveAttachmentsToWorkspace(workspaceId, pendingAttachments);
      const clientInputPaths = savedLocally.length
        ? JSON.stringify(Object.fromEntries(savedLocally.map((a) => [a.filename, a.clientPath])))
        : undefined;

      const existingThreadId = sessions.find((s) => s.id === currentActiveId)?.threadId;
      // Always send a thread_id — even on the very first message. If this session
      // has none yet, mint one client-side and persist it immediately, so the
      // first request already carries it (the backend reuses whatever id we pass).
      const threadId = existingThreadId ?? uuid();
      // Strip stray wrapping quotes (e.g. pasted from Windows' "Copy as path").
      const cleanedPathLabel = localPathLabel?.replace(/^["']+|["']+$/g, "").trim();
      const workspacePath =
        cleanedPathLabel && FULL_PATH_RE.test(cleanedPathLabel) ? cleanedPathLabel : undefined;

      const userMsg: Msg = {
        kind: "text",
        role: "user",
        text: pendingAttachments.length > 0
          ? `${text}${text ? "\n\n" : ""}📎 ${pendingAttachments.map((f) => f.name).join(", ")}`
          : text,
      };
      const runId = uuid();
      const runMsg: AgentRunMsg = {
        kind: "agent-run",
        role: "assistant",
        runId,
        answer: "",
        timeline: [],
        status: "running",
        startedAt: Date.now(),
      };

      const sessionsAfterSubmit = sessions.map((s) =>
        s.id === currentActiveId
          ? { ...s, threadId: s.threadId ?? threadId, messages: [...s.messages, userMsg, runMsg] }
          : s,
      );
      sessionsRef.current = sessionsAfterSubmit;
      setSessions(sessionsAfterSubmit);
      syncSessionsRemote(workspaceId, sessionsAfterSubmit);

      // Targets by runId, not array position — a stray update from this run can
      // never land on a different, newer message.
      const updateRun = (updater: (r: AgentRunMsg) => AgentRunMsg) => {
        const sourceSessions = sessionsRef.current.length > 0 ? sessionsRef.current : sessions;
        const nextSessions = sourceSessions.map((s) => {
          if (s.id !== currentActiveId) return s;
          const idx = s.messages.findIndex((m) => m.kind === "agent-run" && m.runId === runId);
          if (idx === -1) return s;
          const next = [...s.messages];
          next[idx] = updater(next[idx] as AgentRunMsg);
          return { ...s, messages: next };
        });
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
      };

      // Close the currently-open narrative block (if any) so the next step
      // renders after it — this is what produces the step-by-step flow.
      const closeText = (tl: TimelineItem[]): TimelineItem[] => {
        const last = tl[tl.length - 1];
        if (last && last.kind === "text") tl[tl.length - 1] = { ...last, done: true };
        return tl;
      };

      /** Index of a sub-agent's card, or -1. Searched from the end because a
       *  fan-out has several open at once and the newest is usually the match. */
      const findSubagent = (tl: TimelineItem[], agentId: string): number => {
        for (let i = tl.length - 1; i >= 0; i--) {
          const it = tl[i];
          if (it.kind === "subagent" && it.agentId === agentId) return i;
        }
        return -1;
      };

      let sawToolCalls = false;
      let completionSyncScheduled = false;
      const syncAfterCompletion = () => {
        if (completionSyncScheduled || typeof window === "undefined") return;
        completionSyncScheduled = true;
        window.setTimeout(() => {
          syncSessionsRemote(workspaceId, sessionsRef.current);
        }, 0);
      };
      // Phase 6: on the first message of a thread, build a repo map (tree +
      // symbols) so the model orients without many list/read calls. Best-effort
      // and only when a local folder is bound.
      let repoMap: string | undefined;
      let runtimeReport: string | undefined;
      let projectMemory: string | undefined;
      let threadMemoryState: string | undefined;
      // Project memory (devaccel.md) is read EVERY message — the agent may
      // have updated it in the previous turn, and the server can't read a
      // client-side workspace itself.
      if (workspaceId != null) {
        try {
          projectMemory = (await readProjectMemory(workspaceId)) ?? undefined;
        } catch {
          /* best-effort — no memory just means a colder start */
        }
        // Thread long-term memory: the canonical copy lives on this machine
        // (~/.devaccel, written from memory_snapshot events). Sending it lets
        // a fresh server re-seed its store instead of forgetting the thread.
        const memStateId = resolveWorkspaceFileAccess(workspaceId)?.stateId;
        if (memStateId && threadId) {
          threadMemoryState =
            (await readStateFile(`projects/${memStateId}/memory/${threadId}.json`)) ?? undefined;
        }
      }
      if (!existingThreadId && fsHandle && workspaceId != null) {
        try {
          repoMap = await buildRepoMap(workspaceId);
        } catch {
          /* best-effort — a missing map just means a slower cold start */
        }
        // Proactive environment check: which runtimes the project's manifests
        // need vs. what's installed on the user's machine (daemon check). The
        // agent then suggests setup BEFORE attempting builds/tests.
        try {
          const nodes = await getAllNodes(workspaceId);
          if (nodes.length > 0) {
            runtimeReport = (await buildRuntimeReport(workspaceId, nodes)) ?? undefined;
          }
        } catch {
          /* best-effort — the reactive /exec check still covers execution */
        }
      }

      // Custom agent persona — runs this turn AS the selected agent, with
      // its definition file and its skills' SKILL.md riding along because the
      // server can't read a client-side workspace (Pattern C).
      //
      // Applies wherever a persona is pinned, not only in SPEC → Execution:
      // the user may pick one in ordinary chat, and `persona_active` pins the
      // one the agent adopted itself so it stays in character on the next
      // send. Never combined with a spec_mode GENERATION run — that turn is
      // building agents, not being one.
      const activeAgentEntry =
        !specModeArg && selectedCustomAgent
          ? customAgents.find((a) => a.agent.name === selectedCustomAgent)
          : undefined;
      let skillFilesArg: string | undefined;
      if (activeAgentEntry && activeAgentEntry.agent.skills.length > 0) {
        const map: Record<string, string> = {};
        for (const skillName of activeAgentEntry.agent.skills) {
          const skill = customSkills.find((s) => s.name === skillName);
          if (skill?.content) map[skillName] = skill.content;
        }
        if (Object.keys(map).length > 0) skillFilesArg = JSON.stringify(map);
      }

      // The catalog — everything this workspace defines, whatever framework
      // shipped it and whatever kind it declares. METADATA ONLY: the server
      // renders it into the prompt as name + description, and the agent pulls
      // one body at a time back through this client's read_file. Sent on
      // EVERY turn (not just spec runs), because an imported framework should
      // be usable in ordinary chat.
      let skillCatalogArg: string | undefined;
      if (customAgents.length > 0 || customSkills.length > 0) {
        const entries: CatalogEntry[] = [
          ...customAgents.map(({ agent, path }) => ({
            name: agent.name,
            kind: "agent",
            description: agent.description,
            path,
            persona: agent.persona,
            title: agent.title,
            icon: agent.icon,
            when_to_use: agent.when_to_use,
            links: agent.skills,
          })),
          ...customSkills.map((skill) => ({
            name: skill.name,
            kind: skill.kind || "skill",
            description: skill.description,
            path: skill.path,
            persona: skill.persona,
            title: skill.title,
            icon: skill.icon,
            when_to_use: skill.when_to_use,
          })),
        ];
        skillCatalogArg = JSON.stringify(entries);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      // MCP (Pattern C): start the workspace's local stdio MCP servers on the
      // daemon and collect their tool manifest for the backend. No-op without a
      // daemon or .mcp.json; cached after the first start so turns don't restart
      // the stdio processes.
      let mcpLocalToolsArg: string | undefined;
      if (workspaceId != null) {
        const _mcpAccess = resolveWorkspaceFileAccess(workspaceId);
        if (_mcpAccess) mcpLocalToolsArg = await startLocalMcpServers(_mcpAccess);
      }

      try {
        await streamAgent({
          message: text,
          threadId,
          workspacePath,
          permissionMode,
          model: effectiveModelKey ?? undefined,
          // allow_tools is deliberately NOT sent from the browser. It is a
          // WHITELIST, and a whitelist is only safe when the sender knows the
          // complete set of tools — which a client never does: the registry is
          // built server-side and MCP servers add more at runtime. ALL_TOOLS
          // below is a hand-maintained mirror, and sending it narrowed every
          // request to those ~23 names, so `skill`, `checkpoint`,
          // `restore_context`, `submit_plan` and every mcp__* tool were denied
          // with "not in allow list". Blocking is the drift-safe direction:
          // deny_tools can only ever block something it names.
          // allow_tools remains available to API/operator callers and to
          // custom-agent narrowing, where the real registry IS known.
          denyTools: deniedTools.size > 0 ? Array.from(deniedTools) : undefined,
          repoMap,
          runtimeReport,
          projectMemory,
          threadMemoryState,
          specMode: specModeArg,
          specFeature: specFeatureArg,
          agentName: activeAgentEntry?.agent.name,
          agentFile: activeAgentEntry?.fileContent || undefined,
          skillFiles: skillFilesArg,
          skillCatalog: skillCatalogArg,
          // Pattern C: advertise client tools whenever we have ANY local file
          // access — the local daemon (works over HTTP) OR a browser FS-API
          // handle (HTTPS/localhost). Only then does the server DELEGATE file
          // tools to the browser (client_tool_use) instead of running them on
          // the server. Without local access, the server runs tools itself
          // (original same-machine behaviour), so no-access sessions still work.
          clientTools: (workspaceId != null && resolveWorkspaceFileAccess(workspaceId))
            ? [
                ...CLIENT_TOOLS,
                // The daemon transport has a shell + git (POST /exec) —
                // advertise run_terminal/git so commands execute on the
                // USER's machine. FS-API-only access has no shell; the
                // server then swaps in stubs that guide the user to set up
                // the daemon.
                ...(hasRuntimeHost(workspaceId) ? RUNTIME_TOOLS : []),
              ]
            : undefined,
          // OS of THIS machine (daemon /health platform, browser fallback) —
          // delegated commands run here, so the model must compose them for
          // this shell, not the server's.
          clientOs: (workspaceId != null && hasRuntimeHost(workspaceId))
            ? detectClientOs()
            : undefined,
          mcpLocalTools: mcpLocalToolsArg,
          files: pendingAttachments.map((file): AgentAttachment => ({ filename: file.name, file })),
          clientInputPaths,
          signal: controller.signal,
          onEvent: (evt: AgentSSEEvent) => {
            switch (evt.type) {
              case "thread_id":
                // Keep the session's thread_id stable for its whole lifetime —
                // we already minted+persisted one before the request, so only
                // adopt the server's id if somehow none is set yet.
                setSessions((prev) =>
                  prev.map((s) => (s.id === currentActiveId ? { ...s, threadId: s.threadId ?? evt.thread_id } : s)),
                );
                break;
              case "workspace_resolved":
                if (evt.requested_path && !evt.matched_requested) {
                  updateRun((r) => ({
                    ...r,
                    workspaceWarning:
                      `Not using your bound folder — "${evt.requested_path}" doesn't exist on the machine ` +
                      `running DevSphere AI, so it fell back to its own default folder (${evt.resolved_path}). ` +
                      `Generated files won't show up in the Explorer.`,
                  }));
                }
                break;
              case "mcp_tools":
                updateRun((r) => ({ ...r, mcpServers: evt.servers }));
                break;
              case "skills_loaded":
                updateRun((r) => ({ ...r, skills: evt.skills }));
                break;
              case "skill_loaded":
                // The entry the agent actually opened — show it alongside the
                // keyword matches, which are only a guess at the topic.
                updateRun((r) => ({
                  ...r,
                  skills: r.skills?.includes(evt.name) ? r.skills : [...(r.skills ?? []), evt.name],
                }));
                break;
              case "persona_active":
                // Pin the persona so the next turn re-sends it as agent_name
                // and the agent stays in character across messages, instead of
                // reverting to the plain assistant on every send.
                setSelectedCustomAgent(evt.name);
                break;
              case "inputs_saved":
                updateRun((r) => ({
                  ...r,
                  savedInputs: evt.files.map((f) => ({
                    name: f.original_filename,
                    label: f.label ?? f.content_type,
                    kind: f.kind ?? "file",
                    chars: f.extracted_chars ?? 0,
                    images: f.images ?? 0,
                    notes: f.error ? [f.error, ...(f.notes ?? [])] : (f.notes ?? []),
                  })),
                  rejectedInputs: evt.rejected ?? [],
                }));
                break;
              case "resuming":
                updateRun((r) => ({ ...r, resumingMessage: evt.message }));
                break;
              case "content":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const last = tl[tl.length - 1];
                  if (last && last.kind === "text" && !last.done) {
                    tl[tl.length - 1] = { ...last, text: last.text + evt.delta };
                  } else {
                    tl.push({ kind: "text", text: evt.delta, done: false });
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "content_reset":
                // Server is retrying a dropped stream — drop the partial text
                // block; the retried call re-streams it from the beginning.
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const last = tl[tl.length - 1];
                  if (last && last.kind === "text" && !last.done) tl.pop();
                  return { ...r, timeline: tl };
                });
                break;
              case "narration_done":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const last = tl[tl.length - 1];
                  if (last && last.kind === "text") {
                    tl[tl.length - 1] = { ...last, done: true, text: evt.text || last.text };
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "thinking": {
                // Two kinds of thinking events: real reasoning (has `thought`)
                // and status pings like {step, status:"calling_llm"} (no text).
                // Only render the ones that actually carry reasoning text —
                // otherwise the block renders (or overwrites) as empty.
                const thought = typeof evt.thought === "string" ? evt.thought : "";
                if (!thought.trim()) break;
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const last = tl[tl.length - 1];
                  if (last && last.kind === "thinking") tl[tl.length - 1] = { ...last, text: thought };
                  else tl.push({ kind: "thinking", text: thought });
                  return { ...r, timeline: tl };
                });
                break;
              }
              case "tool_start":
                sawToolCalls = true;
                // Agent machinery (see isInternalTool) runs normally but gets no
                // row: it says nothing about the user's request. No placeholder
                // is created, so the matching tool_result/tool_error below finds
                // nothing to fill in and is dropped with it.
                if (isInternalTool(evt.tool)) break;
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  // From a sub-agent → nest it under that agent's card so the
                  // parent's timeline stays readable during a fan-out.
                  if (evt.agent_id) {
                    const i = findSubagent(tl, evt.agent_id);
                    if (i >= 0) {
                      const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                      tl[i] = {
                        ...card,
                        children: [...card.children, { tool: evt.tool, description: evt.description }],
                      };
                      return { ...r, timeline: tl };
                    }
                  }
                  tl.push({ kind: "tool", tool: evt.tool, input: evt.input, description: evt.description });
                  return { ...r, timeline: tl };
                });
                break;
              case "decomposition":
                // The parent judged the task complex enough to split. Advisory:
                // the real spawns arrive as subagent_start.
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  const roles = (evt.agents ?? [])
                    .map((a) => a.role)
                    .filter(Boolean)
                    .join(", ");
                  tl.push({
                    kind: "thinking",
                    text:
                      `[Splitting this into ${evt.agents?.length ?? 0} agent(s)` +
                      (roles ? `: ${roles}` : "") + "]",
                  });
                  return { ...r, timeline: tl };
                });
                break;
              case "subagent_start":
                sawToolCalls = true;
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  // A resume reuses the SAME agent_id. Pushing unconditionally
                  // would leave two cards sharing an id, and findSubagent would
                  // route the resumed run's tool calls to the stale first card.
                  if (evt.resumed) {
                    const existing = findSubagent(tl, evt.agent_id);
                    if (existing >= 0) {
                      const card = tl[existing] as Extract<TimelineItem, { kind: "subagent" }>;
                      tl[existing] = {
                        ...card,
                        status: "running",
                        task: evt.task,
                        resumed: true,
                        summary: undefined,
                        startedAt: Date.now(),
                        children: [],
                      };
                      return { ...r, timeline: tl };
                    }
                  }
                  tl.push({
                    kind: "subagent",
                    agentId: evt.agent_id,
                    role: evt.role,
                    task: evt.task,
                    tools: evt.tools ?? [],
                    ownsPaths: evt.owns_paths ?? [],
                    status: "running",
                    depth: evt.depth ?? 1,
                    parentAgentId: evt.parent_agent_id || undefined,
                    background: evt.background || undefined,
                    resumed: evt.resumed || undefined,
                    model: evt.model || undefined,
                    startedAt: Date.now(),
                    children: [],
                  });
                  return { ...r, timeline: tl };
                });
                break;
              case "subagent_notification":
                // The parent has now been told this background agent's result.
                // The card already shows the outcome; this just records that the
                // handoff happened, so a finished-but-unreported agent is
                // distinguishable from one the parent has acted on.
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const i = findSubagent(tl, evt.agent_id);
                  if (i >= 0) {
                    const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                    tl[i] = { ...card, notified: true };
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "subagent_retry":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const i = findSubagent(tl, evt.agent_id);
                  if (i >= 0) {
                    const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                    tl[i] = { ...card, retried: true, status: "running", startedAt: Date.now(), children: [] };
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "subagent_done":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const i = findSubagent(tl, evt.agent_id);
                  if (i >= 0) {
                    const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                    tl[i] = {
                      ...card,
                      status: evt.status,
                      steps: evt.steps,
                      filesChanged: evt.files_changed ?? [],
                      summary: evt.summary,
                    };
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "permission_request":
                // Manual mode: server paused before a change. Show the card;
                // the user's choice is POSTed back via answerPermission.
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({
                    kind: "permission",
                    id: evt.id,
                    tool: evt.tool,
                    input: evt.input,
                    description: evt.description,
                    category: evt.category,
                    reason: evt.reason,
                    preview: evt.preview,
                  });
                  return { ...r, timeline: tl };
                });
                break;
              case "memory_snapshot": {
                // End-of-run mirror of the thread's long-term memory — persist
                // the canonical copy on this machine (Claude Code keeps its
                // equivalent under ~/.claude/projects). Best-effort.
                const stateId =
                  workspaceId != null ? resolveWorkspaceFileAccess(workspaceId)?.stateId : undefined;
                if (stateId && evt.thread_id) {
                  void writeStateFile(
                    `projects/${stateId}/memory/${evt.thread_id}.json`,
                    JSON.stringify(evt.entries ?? []),
                  ).catch(() => {});
                }
                break;
              }
              case "client_tool_use": {
                // Pattern C: the server delegated a workspace tool to the browser.
                // Execute it against the local folder handle and post the bytes
                // back so the paused agent loop resumes. Rendering is handled by
                // the tool_start (above) / tool_result pair — except run_terminal,
                // which gets the same live terminal block server-executed
                // commands get via terminal_start/output/done SSE events.
                const { id, tool, input } = evt;
                void (async () => {
                  let output: Record<string, unknown>;
                  if (workspaceId == null) {
                    output = { error: "No workspace is bound in the browser to execute this tool." };
                  } else if (tool === "run_terminal") {
                    const command = String((input as { command?: string })?.command ?? "");
                    updateRun((r) => {
                      const tl = closeText([...r.timeline]);
                      // Same dedupe as the terminal_start SSE case: the terminal
                      // block replaces the generic tool row.
                      const lastItem = tl[tl.length - 1];
                      if (lastItem?.kind === "tool" && lastItem.tool === "run_terminal" && lastItem.observation == null) {
                        tl.pop();
                      }
                      tl.push({ kind: "terminal", command, lines: [] });
                      return { ...r, timeline: tl };
                    });
                    output = await executeClientTool(workspaceId, tool, input, {
                      onTerminalLine: (_stream, line) => {
                        updateRun((r) => {
                          const tl = [...r.timeline];
                          for (let i = tl.length - 1; i >= 0; i--) {
                            const it = tl[i];
                            if (it.kind === "terminal" && it.exitCode == null) {
                              tl[i] = { ...it, lines: [...it.lines, line] };
                              break;
                            }
                          }
                          return { ...r, timeline: tl };
                        });
                      },
                    });
                    const exit = typeof (output as { exit_code?: unknown }).exit_code === "number"
                      ? ((output as { exit_code: number }).exit_code)
                      : -1;
                    updateRun((r) => {
                      const tl = [...r.timeline];
                      for (let i = tl.length - 1; i >= 0; i--) {
                        const it = tl[i];
                        if (it.kind === "terminal" && it.exitCode == null) {
                          tl[i] = { ...it, exitCode: exit };
                          break;
                        }
                      }
                      return { ...r, timeline: tl };
                    });
                  } else {
                    output = await executeClientTool(workspaceId, tool, input);
                  }
                  await postToolResult(threadId, id, output);
                })();
                break;
              }
              case "tool_result":
                // file_write on a NEW file and create_output produce no
                // file_diff event, so the diff hook above would miss exactly
                // the case that changes the tree shape: a file appearing.
                if (["file_write", "create_output", "notebook_edit", "code_edit"]
                    .includes((evt as { tool?: string }).tool ?? "")) {
                  scheduleLiveRescan();
                }
              case "tool_error":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  // Sub-agent result → close the matching call inside that
                  // agent's card. Matching on the flat timeline instead would
                  // attach a child's result to an unrelated parent tool call
                  // of the same name.
                  if (evt.agent_id) {
                    const i = findSubagent(tl, evt.agent_id);
                    if (i >= 0) {
                      const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                      const children = [...card.children];
                      for (let j = children.length - 1; j >= 0; j--) {
                        if (children[j].tool === evt.tool && children[j].observation == null) {
                          children[j] = {
                            ...children[j],
                            observation: evt.observation,
                            isError: evt.type === "tool_error",
                          };
                          break;
                        }
                      }
                      tl[i] = { ...card, children };
                      return { ...r, timeline: tl };
                    }
                  }
                  for (let i = tl.length - 1; i >= 0; i--) {
                    const it = tl[i];
                    if (it.kind === "tool" && it.tool === evt.tool && it.observation == null) {
                      tl[i] = { ...it, observation: evt.observation, isError: evt.type === "tool_error" };
                      break;
                    }
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "terminal_start":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  // A sub-agent's command belongs INSIDE its card. Left on the
                  // main timeline it rendered as an orphaned terminal block —
                  // and with several agents running, out of order relative to
                  // the agent that actually ran it.
                  if (evt.agent_id) {
                    const i = findSubagent(tl, evt.agent_id);
                    if (i >= 0) {
                      const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                      tl[i] = {
                        ...card,
                        children: [
                          ...card.children,
                          { tool: "run_terminal", description: `$ ${evt.command}` },
                        ],
                      };
                      return { ...r, timeline: tl };
                    }
                  }
                  // The terminal window IS the display for this run_terminal
                  // call — drop the generic tool row pushed by tool_start so
                  // the command isn't shown twice (Claude Code shows one block).
                  const lastItem = tl[tl.length - 1];
                  if (lastItem?.kind === "tool" && lastItem.tool === "run_terminal" && lastItem.observation == null) {
                    tl.pop();
                  }
                  tl.push({ kind: "terminal", command: evt.command, lines: [] });
                  return { ...r, timeline: tl };
                });
                break;
              case "tasks":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  // Same dedupe: the checklist replaces task_manager's tool row.
                  const lastItem = tl[tl.length - 1];
                  if (lastItem?.kind === "tool" && lastItem.tool === "task_manager" && lastItem.observation == null) {
                    tl.pop();
                  }
                  // ONE live checklist per run — update the existing block in
                  // place; only push a new one the first time.
                  const next = { kind: "tasks" as const, tasks: evt.tasks, done: evt.done, total: evt.total };
                  const existing = tl.findIndex((it) => it.kind === "tasks");
                  if (existing >= 0) tl[existing] = next;
                  else tl.push(next);
                  return { ...r, timeline: tl };
                });
                break;
              case "workspace":
                updateRun((r) => ({
                  ...r,
                  serverWorkspace: { path: evt.path, source: evt.source },
                }));
                break;
              case "terminal_output":
                // A sub-agent's command output stays inside its card (the row
                // pushed by terminal_start). Streaming a child's build log into
                // the parent's timeline is what made a three-agent run
                // unreadable — and interleaved, three logs at once.
                if (evt.agent_id) break;
                updateRun((r) => {
                  const tl = [...r.timeline];
                  for (let i = tl.length - 1; i >= 0; i--) {
                    const it = tl[i];
                    if (it.kind === "terminal" && it.exitCode == null) {
                      tl[i] = { ...it, lines: [...it.lines, evt.line] };
                      break;
                    }
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "terminal_done":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  // Sub-agent command → close its row inside that agent's card
                  // with the exit code, so a failed build is visible on the
                  // agent that ran it rather than at the bottom of the page.
                  if (evt.agent_id) {
                    const i = findSubagent(tl, evt.agent_id);
                    if (i >= 0) {
                      const card = tl[i] as Extract<TimelineItem, { kind: "subagent" }>;
                      const children = [...card.children];
                      for (let j = children.length - 1; j >= 0; j--) {
                        if (children[j].tool === "run_terminal" && children[j].observation == null) {
                          children[j] = {
                            ...children[j],
                            observation: `exit ${evt.exit_code}`,
                            isError: evt.exit_code !== 0,
                          };
                          break;
                        }
                      }
                      tl[i] = { ...card, children };
                      return { ...r, timeline: tl };
                    }
                  }
                  for (let i = tl.length - 1; i >= 0; i--) {
                    const it = tl[i];
                    if (it.kind === "terminal" && it.exitCode == null) {
                      tl[i] = { ...it, exitCode: evt.exit_code };
                      break;
                    }
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "file_diff":
                // A write reached the disk — bring the Explorer up to date
                // without waiting for the run to end.
                scheduleLiveRescan();
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({ kind: "diff", path: evt.path, diff: evt.diff });
                  return { ...r, timeline: tl };
                });
                break;
              case "custom_agent":
                // The backend confirmed the selected persona is active.
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({ kind: "text", text: `🤖 Running as custom agent **${evt.name}**`, done: true });
                  return { ...r, timeline: tl };
                });
                break;
              case "ask_user":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  // Normalize the batched `questions` array (preferred) if present.
                  const rawQs = Array.isArray(evt.questions) ? evt.questions : undefined;
                  const questions = rawQs
                    ?.filter((q) => q && typeof q.question === "string")
                    .map((q) => ({
                      question: q.question,
                      options: Array.isArray(q.options) ? q.options : undefined,
                      allowMultiple: Boolean(q.allow_multiple),
                    }));
                  tl.push({
                    kind: "ask_user",
                    question: typeof evt.question === "string" ? evt.question : "The agent needs your input.",
                    options: Array.isArray(evt.options) ? (evt.options as string[]) : undefined,
                    context: typeof evt.context === "string" ? evt.context : undefined,
                    questions: questions && questions.length > 0 ? questions : undefined,
                  });
                  return { ...r, timeline: tl };
                });
                break;
              /* ── Spec-Driven Development events (spec_mode runs only) ── */
              case "spec_phase_start":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  const roundNote = evt.round && evt.round > 1 ? ` (revision round ${evt.round})` : "";
                  tl.push({ kind: "thinking", text: `Spec phase: ${evt.phase}${roundNote} — ${evt.feature}` });
                  return { ...r, timeline: tl };
                });
                break;
              case "spec_file_generated":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({ kind: "text", text: `📄 Generated \`${evt.path}\``, done: true });
                  return { ...r, timeline: tl };
                });
                break;
              case "gate_request":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({
                    kind: "gate",
                    gate: evt.gate,
                    phase: evt.phase,
                    feature: evt.feature,
                    files: Array.isArray(evt.files) ? evt.files : [],
                    summary: evt.summary,
                    decisions: Array.isArray(evt.decisions) ? evt.decisions : undefined,
                    labels: evt.labels,
                  });
                  return { ...r, timeline: tl };
                });
                break;
              case "gate_result":
                // Lock the matching card in place — covers decisions made in
                // another tab and server-side timeouts (workflow paused).
                updateRun((r) => {
                  const tl = [...r.timeline];
                  for (let i = tl.length - 1; i >= 0; i--) {
                    const it = tl[i];
                    if (it.kind === "gate" && it.gate === evt.gate && !it.result) {
                      tl[i] = { ...it, result: { decision: evt.decision, feedback: evt.feedback } };
                      break;
                    }
                  }
                  return { ...r, timeline: tl };
                });
                break;
              case "gate_waiting":
                // Keepalive while the user reviews — nothing to render.
                break;
              case "spec_task_start":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({ kind: "thinking", text: `Task ${evt.id}: ${evt.title}` });
                  return { ...r, timeline: tl };
                });
                break;
              case "spec_task_done":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  const ok = (evt.status ?? "done") === "done";
                  tl.push({
                    kind: "text",
                    text: ok ? `✅ ${evt.id} completed` : `⚠️ ${evt.id} ${evt.status}${evt.detail ? ` — ${evt.detail}` : ""}`,
                    done: true,
                  });
                  return { ...r, timeline: tl };
                });
                break;
              case "spec_workflow_done":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({
                    kind: "text",
                    text:
                      evt.mode === "generation"
                        ? evt.agents_dir
                          // Agent-builder pipeline: BMAD-aligned files landed.
                          ? `🎉 Agent & skills generated under \`${evt.agents_dir}\` and \`${evt.skills_dir ?? ".devaccel/skills"}\`. Switch the Spec dropdown to **Execution** and pick the agent to run it.`
                          : `🎉 Spec generation complete for **${evt.feature}** — review the files under \`${evt.spec_dir ?? ".devaccel/spec"}\`, then switch the Spec dropdown to **Execution** to build it.`
                        : `🎉 Execution complete for **${evt.feature}** — ${evt.tasks_completed ?? 0} task(s) done.`,
                    done: true,
                  });
                  return { ...r, timeline: tl };
                });
                break;
              case "final":
                updateRun((r) => {
                  const tl = [...r.timeline];
                  const last = tl[tl.length - 1];
                  if (last && last.kind === "text") tl[tl.length - 1] = { ...last, text: evt.answer, done: true };
                  else tl.push({ kind: "text", text: evt.answer, done: true });
                  return { ...r, answer: evt.answer, timeline: tl };
                });
                break;
              case "token_usage":
                updateRun((r) => ({ ...r, usage: evt.usage }));
                break;
              case "context_state":
                // Occupancy, not spend — replaces rather than accumulates, so
                // the meter falls back down when compaction frees room.
                updateRun((r) => ({
                  ...r,
                  contextState: {
                    used: evt.used,
                    window: evt.window,
                    pct: evt.pct,
                    cached: evt.cached,
                    breakdown: evt.breakdown,
                  },
                }));
                break;
              case "compaction":
                updateRun((r) => {
                  const tl = closeText([...r.timeline]);
                  tl.push({
                    kind: "thinking",
                    text: `Compressed ${evt.messages_before - evt.messages_after} earlier messages to free context`,
                  });
                  return { ...r, timeline: tl, compactions: (r.compactions ?? 0) + 1 };
                });
                break;
              case "model":
                updateRun((r) => ({
                  ...r,
                  runModel: { key: evt.key, name: evt.name, degraded: evt.degraded },
                }));
                break;
              case "quota_notice":
                updateRun((r) => ({
                  ...r,
                  quotaNotice: {
                    level: evt.level,
                    used: evt.used,
                    limit: evt.limit,
                    window: evt.window,
                    pct: evt.pct,
                    degraded: evt.degraded,
                    model: evt.model,
                    message: evt.message,
                  },
                }));
                break;
              case "run_summary":
                updateRun((r) => ({ ...r, runSummary: { status: evt.status, steps_taken: evt.steps_taken } }));
                break;
              case "stopped":
                if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
                updateRun((r) => ({ ...r, status: "stopped", stopRequested: false }));
                break;
              case "error":
                if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
                updateRun((r) => ({ ...r, status: "error", errorMessage: evt.message, stopRequested: false }));
                break;
              case "done":
                if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
                updateRun((r) => (r.status === "running" ? { ...r, status: "done", stopRequested: false } : r));
                syncAfterCompletion();
                break;
              default:
                break;
            }
          },
        });
        // Safety net: stream resolved without a terminal event. A run parked
        // at an UNDECIDED spec gate is NOT an error — the backend keeps the
        // workflow alive across stream loss; the gate card stays actionable
        // and the decision reaches it via POST. Close the run quietly.
        updateRun((r) => {
          if (r.status !== "running") return r;
          const gatePending = r.timeline.some((it) => it.kind === "gate" && !it.result);
          return gatePending
            ? { ...r, status: "done" }
            : { ...r, status: "error", errorMessage: "Connection closed before a response was received. Please try again." };
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // Reached via the force-abort fallback timeout. We KEEP the session's
          // thread_id — it stays constant for the whole session. The graceful
          // stop request was already sent, so the server halts at its next step
          // boundary and the same thread continues on the next message.
          updateRun((r) =>
            r.status === "running" ? { ...r, status: "stopped", stopRequested: false, forcedStop: true } : r,
          );
        } else {
          updateRun((r) => {
            if (r.status !== "running") {
              return r;
            }
            // Same undecided-gate exemption as the safety net above.
            const gatePending = r.timeline.some((it) => it.kind === "gate" && !it.result);
            return gatePending
              ? { ...r, status: "done" }
              : {
                  ...r,
                  status: "error",
                  errorMessage: err instanceof Error ? err.message : "Something went wrong",
                  stopRequested: false,
                };
          });
        }
      } finally {
        setSending(false);
        abortRef.current = null;
        if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
        // Refresh the Explorer after any run that used tools: the agent writes
        // files to the bound folder on disk (via the daemon OR the browser FS
        // handle), but the Explorer reads from IndexedDB, so it needs a rescan
        // of whatever access backs this workspace.
        if (sawToolCalls) {
          const access = workspaceId != null ? resolveWorkspaceFileAccess(workspaceId) : null;
          if (access) {
            void rescanAfterRun();
          } else if (workspaceId != null && isLocalWorkspaceId(workspaceId)) {
            updateRun((r) => ({
              ...r,
              workspaceWarning:
                (r.workspaceWarning ? r.workspaceWarning + " " : "") +
                "Files were written to your local folder — grant access to view them in the Explorer.",
            }));
          }
        }
      }
    },
    // `spec` dropped: the persona is now driven by selectedCustomAgent alone,
    // since an imported agent is usable outside SPEC → Execution too.
    [attachments, sessions, workspaceId, localPathLabel, fsHandle, rescanAfterRun, scheduleLiveRescan, permissionMode, effectiveModelKey, deniedTools, selectedCustomAgent, customAgents, customSkills],
  );

  /* AUTO mode only — stop the active agent run. Aborts the client stream
     immediately so the run visibly stops on click, and also fires a graceful
     stop so the server halts its own work. The thread_id stays constant. */
  const handleStop = useCallback(() => {
    const threadId = activeSession?.threadId;
    const currentActiveId = activeSession?.id;

    if (currentActiveId) {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== currentActiveId) return s;
          const next = [...s.messages];
          const last = next[next.length - 1];
          if (last?.kind === "agent-run" && last.status === "running") {
            next[next.length - 1] = { ...last, stopRequested: true };
          }
          return { ...s, messages: next };
        }),
      );
    }

    // Tell the backend to halt server-side work — best-effort, separate request
    // (its own fetch, so aborting the stream below doesn't cancel it).
    if (threadId) void stopAgent(threadId);

    // Abort the client stream right now. The backend only checks its stop flag
    // between agent steps (never mid-step/mid-token), so waiting for a graceful
    // "stopped" event can hang for the whole step — instead we cut the stream
    // immediately; the AbortError handler marks the run stopped. The graceful
    // stop above still halts the server at its next boundary.
    if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
    abortRef.current?.abort();
  }, [activeSession?.threadId, activeSession?.id]);

  /* Answer an ask_user prompt by sending the answer as a new message on the
     same thread (one-directional SSE has no mid-stream reply). Preserves the
     CURRENT mode: in Spec mode the reply re-enters the generation/execution
     workflow (a spec phase asked the clarification), mirroring send(). */
  const answerAsk = useCallback(
    (text: string) => {
      if (!activeSession || sending) return;
      const specModeArg: SpecMode | undefined = spec
        ? specSubMode === "gen"
          ? "generation"
          : selectedCustomAgent ? undefined : "execution"
        : undefined;
      const specFeatureArg = specModeArg === "execution" ? specFeature ?? undefined : undefined;
      void sendToAutoAgent(text, activeSession.id, specModeArg, specFeatureArg);
    },
    [activeSession, sending, sendToAutoAgent, spec, specSubMode, selectedCustomAgent, specFeature],
  );

  /* AUTO mode only — answer a permission_request (ask mode). Unlike ask_user,
     this doesn't send a new message: it POSTs the decision to the paused agent
     on the same thread, which then runs or skips the tool and keeps streaming. */
  const answerPermission = useCallback(
    (id: string, decision: PermissionDecision) => {
      const threadId = activeSession?.threadId;
      if (!threadId) return;
      void postPermissionResponse(threadId, id, decision);
    },
    [activeSession?.threadId],
  );

  /* SPEC mode — answer a gate_request. Same parked-turn pattern as
     answerPermission: POSTs the decision to the paused workflow, which then
     advances / re-runs the phase / aborts and keeps streaming. */
  const answerGate = useCallback(
    (gate: string, decision: GateDecision, feedback?: string) => {
      const threadId = activeSession?.threadId;
      if (!threadId) return;
      void postGateResponse(threadId, gate, decision, feedback);
    },
    [activeSession?.threadId],
  );

  /* ── Send message ──────────────────────────────────────────────────────── */
  /* True when the workspace is local but file access isn't live yet — the send
     would otherwise fail its client-side file tools or write to the server. */
  const needsLocalAccess =
    workspaceId != null && isLocalWorkspaceId(workspaceId) && !fileAccessReady;

  /* Append an inline access-request card (stashing the message to auto-resend). */
  const injectAccessRequest = useCallback((currentActiveId: string, text: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentActiveId
          ? { ...s, messages: [...s.messages, { kind: "access-request", role: "assistant", pendingText: text } as Msg] }
          : s,
      ),
    );
  }, []);

  /* Patch a specific access-request card (by index) in the active session. */
  const patchAccessMsg = useCallback(
    (currentActiveId: string, idx: number, patch: Partial<AccessRequestMsg>) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== currentActiveId) return s;
          const messages = s.messages.map((m, i) =>
            i === idx && m.kind === "access-request" ? { ...m, ...patch } : m,
          );
          return { ...s, messages };
        }),
      );
    },
    [],
  );

  const dismissAccessRequest = useCallback(
    (idx: number) => patchAccessMsg(activeId, idx, { resolved: "dismissed" }),
    [activeId, patchAccessMsg],
  );

  /* Grant access from the in-chat card, then auto-continue the stashed message. */
  const handleGrantFromChat = useCallback(
    async (idx: number, pendingText: string) => {
      const currentActiveId = activeId;
      setGrantingAccess(true);
      let ok = false;
      try {
        ok = await grantFsAccess();
      } catch {
        ok = false;
      }
      setGrantingAccess(false);
      if (!ok) {
        patchAccessMsg(currentActiveId, idx, {
          error: "Couldn't get folder access. Make sure the DevAccel daemon is running (or use HTTPS/localhost), then try again.",
        });
        return;
      }
      // Remove the card, then run the stashed message through the agent.
      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentActiveId
            ? { ...s, messages: s.messages.filter((m, i) => !(i === idx && m.kind === "access-request")) }
            : s,
        ),
      );
      if (pendingText) {
        const specModeArg: SpecMode | undefined = spec
          ? specSubMode === "gen"
            ? "generation"
            : selectedCustomAgent ? undefined : "execution"
          : undefined;
        const specFeatureArg = specModeArg === "execution" ? specFeature ?? undefined : undefined;
        await sendToAutoAgent(pendingText, currentActiveId, specModeArg, specFeatureArg);
      }
    },
    [activeId, grantFsAccess, patchAccessMsg, sendToAutoAgent, spec, specSubMode, specFeature, selectedCustomAgent],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeSession || sending) return;

    const currentActiveId = activeId;

    // Local workspace without live file access: the Send click/Enter is itself
    // a user gesture, so try to grant access right here — daemon reconnect
    // first (silent), then the browser permission prompt on the stored handle
    // (never the folder picker). On success the send proceeds normally with
    // client file tools bound; otherwise fall back to the inline access-request
    // card (stashing the message), whose Grant button auto-continues it.
    if (needsLocalAccess) {
      if (grantingAccess) return; // prompt already open (repeat Enter)
      setGrantingAccess(true);
      let granted = false;
      try {
        granted = await grantFsAccess({ skipPicker: true });
      } catch {
        granted = false;
      }
      setGrantingAccess(false);
      if (!granted) {
        setInput("");
        injectAccessRequest(currentActiveId, text);
        return;
      }
    }

    setInput("");

    // Both modes stream through the SAME DevSphere agent (one loop). SPEC
    // adds spec_mode so the backend runs the gated SpecWorkflow instead:
    // generation → agent-builder (roster gate → scaffold gate); execution
    // with a CUSTOM AGENT selected → a normal persona turn (agent_name, no
    // spec_mode — sendToAutoAgent attaches the agent); execution without
    // one → legacy tasks.md walk. Old sessions' spec-gen/spec-exec
    // messages still render via SpecMessage below.
    const specModeArg: SpecMode | undefined = spec
      ? specSubMode === "gen"
        ? "generation"
        : selectedCustomAgent ? undefined : "execution"
      : undefined;
    const specFeatureArg = specModeArg === "execution" ? specFeature ?? undefined : undefined;
    await sendToAutoAgent(text, currentActiveId, specModeArg, specFeatureArg);
  }, [input, activeSession, activeId, sending, spec, specSubMode, specFeature, selectedCustomAgent, sendToAutoAgent, needsLocalAccess, injectAccessRequest, grantFsAccess, grantingAccess]);

  /* ── Approve spec → switch to Spec Exec and run with agent ──────────── */
  const approveSpec = useCallback(async (specAnswer: string) => {
    if (sending) return;
    setMode("spec");
    setSpecSubMode("exec");
    setSending(true);

    const currentActiveId = activeId;
    const userMsg: Msg = { kind: "text", role: "user", text: "Approved spec — executing with agent…" };
    const loadingMsg: Msg = { kind: "loading", role: "assistant" };

    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentActiveId
          ? { ...s, messages: [...s.messages, userMsg, loadingMsg] }
          : s,
      ),
    );

    try {
      const contextFiles = workspaceId != null
        ? await gatherWorkspaceContext(workspaceId)
        : [];
      const projCtx: SpecProjectContext | null = projectSelection
        ? {
            projectId: projectSelection.projectId,
            projectName: projectSelection.projectName,
            selectedStoryIds: [...projectSelection.selectedStoryIds],
            selectedDocIds: [...projectSelection.selectedDocIds],
          }
        : null;
      const res = await specExecute(specAnswer, selectedAgentId, contextFiles, projCtx);

      let writtenToWorkspace = false;
      const allFiles: SpecFileInfo[] = [];
      let projectName = "";

      for (const result of res.subtask_results) {
        if (result.success && result.output) {
          projectName = projectName || result.output.project_name;
          for (const f of result.output.files) {
            allFiles.push({ path: f.path, language: f.language, purpose: f.purpose, hasContent: f.content.length > 0 });
          }
          if (workspaceId != null && result.output.files.some((f) => f.content)) {
            await writeSpecFilesToWorkspace(workspaceId, result.output);
            writtenToWorkspace = true;
          }
        }
      }

      if (writtenToWorkspace) bumpTreeRevision();

      const responseMsg: Msg = {
        kind: "spec-exec",
        role: "assistant",
        answer: res.answer,
        plan: res.plan,
        files: allFiles,
        projectName,
        writtenToWorkspace,
      };

      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentActiveId
            ? { ...s, messages: s.messages.map((m) => (m.kind === "loading" ? responseMsg : m)) }
            : s,
        ),
      );
    } catch (err) {
      const errorMsg: Msg = {
        kind: "error",
        role: "assistant",
        text: err instanceof Error ? err.message : "Execution failed",
      };
      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentActiveId
            ? { ...s, messages: s.messages.map((m) => (m.kind === "loading" ? errorMsg : m)) }
            : s,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [activeId, selectedAgentId, workspaceId, bumpTreeRevision, sending, projectSelection]);

  const clearHistory = () => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? { ...s, messages: [{ kind: "text" as const, role: "assistant" as const, text: DEFAULT_GREETING }] }
          : s,
      ),
    );
    setShowSettings(false);
  };

  /* ── AI orb (reused across message types) ─────────────────────────────── */
  const aiOrb = (
    <div className="ide-ai-orb h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
      <Bot className="h-3 w-3 text-white" />
    </div>
  );

  /* ── Render a single message ──────────────────────────────────────────── */
  const renderMessage = (msg: Msg, idx: number) => {
    switch (msg.kind) {
      case "text": {
        /* Welcome state — styled card with quick-action chips */
        if (msg.role === "assistant" && msg.text === DEFAULT_GREETING && idx === 0) {
          return (
            <div key={idx} className="flex flex-col items-center text-center py-6 ide-msg-in">
              <div className="ide-ai-orb h-11 w-11 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center mb-3">
                <Bot className="h-5 w-5 text-white" />
              </div>
              <p className="text-[14px] font-medium text-[var(--ide-text)] mb-1">How can I help you today?</p>
              <p className="text-[11px] text-[var(--ide-muted)] mb-4">Choose a quick action or type a message</p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {([
                  { label: "Generate a component", icon: Code2 },
                  { label: "Review code", icon: Eye },
                  { label: "Write tests", icon: Bug },
                  { label: "Explain code", icon: FileText },
                ] as const).map(({ label, icon: Icon }) => (
                  <button key={label} type="button" onClick={() => setInput(label)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--ide-glass-border)] bg-[var(--ide-hover)] text-[11px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:border-[var(--ide-muted)] hover:bg-[var(--ide-surface-2)] transition-all">
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          );
        }

        /* User bubble — right-aligned with gradient border */
        if (msg.role === "user") {
          return (
            <div key={idx} className="flex justify-end ide-msg-in">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-br from-violet-600/25 to-indigo-600/20 border border-violet-500/25 text-[var(--ide-text)] px-3.5 py-2.5 text-[13px] leading-relaxed">
                {msg.text}
              </div>
            </div>
          );
        }

        /* Assistant text — with AI orb */
        return (
          <div key={idx} className="flex items-start gap-2.5 ide-msg-in">
            {aiOrb}
            <div className="flex-1 min-w-0 text-[13px] leading-relaxed text-[var(--ide-text)] pt-0.5">
              {msg.text}
            </div>
          </div>
        );
      }

      case "spec-gen":
      case "spec-exec":
        return (
          <div key={idx} className="flex items-start gap-2.5 ide-msg-in">
            {aiOrb}
            <div className="flex-1 min-w-0">
              <SpecMessage
                msg={msg}
                onOpenFile={onOpenFile}
                onApproveSpec={msg.kind === "spec-gen" && !sending ? approveSpec : undefined}
              />
            </div>
          </div>
        );

      case "agent-run": /* AUTO mode only */
        return (
          <div key={idx} className="flex items-start gap-2.5 ide-msg-in">
            {aiOrb}
            <div className="flex-1 min-w-0">
              <AgentRunMessage msg={msg} onOpenFile={onOpenFile} onAnswer={answerAsk} onPermission={answerPermission} onGate={answerGate} sending={sending} fileAccessReady={fileAccessReady} onGrantAccess={grantAndRescan} />
            </div>
          </div>
        );

      case "loading":
        return (
          <div key={idx} className="flex items-start gap-2.5 ide-msg-in">
            {aiOrb}
            <div className="flex items-center gap-1.5 pt-1.5">
              <span className="ide-bounce-dot h-2 w-2 rounded-full bg-violet-400" />
              <span className="ide-bounce-dot h-2 w-2 rounded-full bg-violet-400" />
              <span className="ide-bounce-dot h-2 w-2 rounded-full bg-violet-400" />
            </div>
          </div>
        );

      case "error":
        return (
          <div key={idx} className="flex items-start gap-2.5 ide-msg-in">
            <div className="h-6 w-6 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center shrink-0">
              <AlertCircle className="h-3 w-3 text-red-400" />
            </div>
            <div className="flex-1 text-[13px] rounded-xl bg-red-950/20 border border-red-500/20 text-red-300 px-3.5 py-2.5">
              {msg.text}
            </div>
          </div>
        );

      case "access-request":
        return (
          <div key={idx} className="flex items-start gap-2.5 ide-msg-in">
            <div className="h-6 w-6 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
              <FolderOpen className="h-3 w-3 text-amber-400" />
            </div>
            <div className="flex-1 rounded-xl border border-amber-700/50 bg-amber-950/25 px-3.5 py-2.5">
              <p className="text-[13px] text-amber-200 font-medium mb-1">Local folder access needed</p>
              <p className="text-[12px] text-[var(--ide-muted)] leading-relaxed mb-2">
                To run this on your files, grant access to your local folder. This stays on your
                machine — nothing is uploaded to the server.
              </p>
              {msg.pendingText && (
                <p className="text-[11px] text-[var(--ide-muted)] italic mb-2.5 line-clamp-2">
                  “{msg.pendingText}”
                </p>
              )}
              {msg.resolved === "granted" ? (
                <p className="text-[12px] text-emerald-400 flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5" /> Access granted — continuing…
                </p>
              ) : msg.resolved === "dismissed" ? (
                <p className="text-[12px] text-[var(--ide-muted)]">Dismissed.</p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={grantingAccess}
                      onClick={() => void handleGrantFromChat(idx, msg.pendingText)}
                      className="h-7 px-3 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-[12px] font-medium text-white transition-colors"
                    >
                      {grantingAccess ? "Granting…" : "Grant access"}
                    </button>
                    <button
                      type="button"
                      disabled={grantingAccess}
                      onClick={() => dismissAccessRequest(idx)}
                      className="h-7 px-3 rounded border border-[var(--ide-glass-border)] text-[12px] text-[var(--ide-muted)] hover:text-[var(--ide-text)] transition-colors"
                    >
                      Not now
                    </button>
                  </div>
                  {msg.error && <p className="text-[11px] text-red-400 mt-2">{msg.error}</p>}
                </>
              )}
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  /* True once Stop has been clicked and we're waiting on the server. Applies
     to both modes now — SPEC runs stream through the same agent. */
  const lastMsg = activeSession?.messages[activeSession.messages.length - 1];
  const stopPending = lastMsg?.kind === "agent-run" && !!lastMsg.stopRequested;

  /* ── Render ────────────────────────────────────────────────────────────── */
  return (
    <div
      className={`flex flex-col bg-[var(--ide-glass)] backdrop-blur-md border border-[var(--ide-glass-border)] rounded-xl shadow-lg overflow-hidden ${
        maximized ? "fixed top-14 left-2 right-2 bottom-2 z-40" : "h-full"
      }`}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between h-9 shrink-0 px-2 border-b border-[var(--ide-border)]">

        {/* Left: icon + session selector + new + mode */}
        <div className="flex items-center gap-1 min-w-0">
          <MessageSquare className="h-4 w-4 text-violet-400 shrink-0" />

          {/* Session dropdown */}
          <div ref={menuRef} className="relative shrink min-w-0">
            <button
              type="button"
              title={activeSession?.name}
              onClick={() => setSessionMenu((s) => !s)}
              className="inline-flex items-center gap-1 h-7 px-1.5 rounded text-xs text-[var(--ide-text)] hover:bg-[var(--ide-hover)] max-w-full"
            >
              <span className="truncate max-w-[64px]">
                {activeSession?.name ?? "Session"}
              </span>
              <ChevronDown className="h-3 w-3 text-[var(--ide-muted)] shrink-0" />
            </button>

            {sessionMenu && (
              <div className="absolute left-0 top-full mt-1 w-64 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-2xl p-1">
                {/* Dropdown header */}
                <div className="flex items-center justify-between px-2 py-1 mb-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">
                    Chat Sessions
                  </span>
                  <button
                    type="button"
                    onClick={handleCreateSession}
                    title="New session"
                    className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Session list */}
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => editingId !== s.id && switchSession(s.id)}
                    className={`group flex items-center gap-1 w-full px-2 py-1.5 rounded cursor-pointer text-xs select-none ${
                      s.id === activeId
                        ? "bg-violet-600/20 text-[var(--ide-text)]"
                        : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                    }`}
                  >
                    {editingId === s.id ? (
                      <input
                        ref={editRef}
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 bg-[var(--ide-surface)] border border-violet-500 rounded px-1 h-5 text-xs text-[var(--ide-text)] focus:outline-none"
                      />
                    ) : (
                      <span className="flex-1 min-w-0 truncate">{s.name}</span>
                    )}

                    {s.id === activeId && editingId !== s.id && (
                      <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                    )}

                    {/* Per-row actions. Visible on hover AND on the SELECTED
                        row: hover-only controls are invisible to touch and
                        keyboard users entirely, and they force a mouse hunt to
                        rename or delete the session you are already in — the
                        one you are most likely to act on. Selecting a row is a
                        deliberate act, so its controls stay put. */}
                    {editingId !== s.id && (
                      <div
                        className={`flex items-center gap-0.5 transition-opacity shrink-0 ${
                          s.id === activeId
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                        }`}
                      >
                        <button
                          type="button"
                          title="Rename"
                          onClick={(e) => startRename(s.id, s.name, e)}
                          className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
                        >
                          <Pencil className="h-2.5 w-2.5" />
                        </button>
                        <button
                          type="button"
                          title="Duplicate"
                          onClick={(e) => duplicateSession(s.id, e)}
                          className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
                        >
                          <Copy className="h-2.5 w-2.5" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={(e) => deleteSession(s.id, e)}
                          className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-red-400"
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {/* Footer: new session */}
                <div className="border-t border-[var(--ide-border)] mt-1 pt-1">
                  <button
                    type="button"
                    onClick={handleCreateSession}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-[var(--ide-muted)] hover:text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New session
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Quick new session */}
          <button
            type="button"
            title="New session"
            onClick={handleCreateSession}
            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
          >
            <Plus className="h-4 w-4" />
          </button>

          {/* Auto / Spec segmented control */}
          <div className="flex h-6 rounded-lg bg-[var(--ide-bg)] border border-[var(--ide-glass-border)] p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setMode("auto")}
              className={`px-2.5 rounded-md text-[10px] font-semibold tracking-wide transition-all ${
                !spec ? "bg-gradient-to-r from-violet-600/40 to-indigo-600/30 text-violet-300 shadow-sm" : "text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
              }`}
            >AUTO</button>
            <button
              type="button"
              onClick={() => setMode("spec")}
              className={`px-2.5 rounded-md text-[10px] font-semibold tracking-wide transition-all ${
                spec ? "bg-gradient-to-r from-violet-600/40 to-indigo-600/30 text-violet-300 shadow-sm" : "text-[var(--ide-muted)] hover:text-[var(--ide-text)]"
              }`}
            >SPEC</button>
          </div>

        </div>

        {/* Right: window controls */}
        <div className="flex items-center gap-0.5 text-[var(--ide-muted)] shrink-0">
          <button
            type="button"
            title="Chat settings"
            onClick={() => { setShowSettings((s) => !s); setCollapsed(false); }}
            className={`h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] ${
              showSettings ? "text-violet-400" : ""
            }`}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={collapsed ? "Expand" : "Minimize"}
            onClick={() => { setCollapsed((c) => !c); setShowSettings(false); }}
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)]"
          >
            <ChevronUp
              className={`h-3.5 w-3.5 transition-transform duration-150 ${collapsed ? "rotate-180" : ""}`}
            />
          </button>
          <button
            type="button"
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => setMaximized((m) => !m)}
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)]"
          >
            {maximized
              ? <Minimize2 className="h-3.5 w-3.5" />
              : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          {onClose && (
            <button
              type="button"
              title="Close chat"
              onClick={onClose}
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Body (hidden when collapsed) ──────────────────────────────────── */}
      {!collapsed && (
        <>
          {/* Settings panel */}
          {showSettings && (
            <div className="shrink-0 border-b border-[var(--ide-border)] bg-[var(--ide-surface-2)] px-3 py-2.5 space-y-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ide-muted)]">
                Chat Settings
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--ide-muted)]">Mode</span>
                  <span className="text-[var(--ide-text)]">{!spec ? "Auto" : specSubMode === "gen" ? "Generation" : "Execution"}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--ide-muted)]">Active session</span>
                  <span className="text-[var(--ide-text)] truncate max-w-[140px]">{activeSession?.name}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--ide-muted)]">Messages</span>
                  <span className="text-[var(--ide-text)]">{activeSession?.messages.length ?? 0}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={clearHistory}
                className="w-full h-7 rounded border border-red-800/50 text-[11px] text-red-400 hover:bg-red-950/30 transition-colors"
              >
                Clear chat history
              </button>
            </div>
          )}

          {/* Messages */}
          <div ref={listRef} className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
            {activeSession?.messages.map((m, i) => renderMessage(m, i))}
          </div>

          {/* Composer */}
          <div className="shrink-0 p-2 border-t border-[var(--ide-border)]">
            <div className="relative rounded-xl border border-[var(--ide-glass-border)] bg-[var(--ide-glass)] backdrop-blur-md ide-composer-glow">

              {/* AUTO mode only — pending attachments for the DevSphere AI agent.
                  Each chip states what will actually happen to that file BEFORE
                  it is sent: a 40 MB screen recording used to upload in full and
                  only then get "I can't watch video" back from the model. The
                  cost of learning that was paid in upload time and a wasted
                  turn, for something knowable from the filename. */}
              {!spec && attachments.length > 0 && (
                <div className="flex flex-col gap-1 px-3 pt-2">
                  <div className="flex flex-wrap gap-1">
                    {attachments.map((f, i) => {
                      const s = describeAttachment(f);
                      const tone =
                        s.level === "none"
                          ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                          : s.level === "partial"
                            ? "bg-[var(--ide-surface-2)] border-sky-500/30 text-[var(--ide-text)]"
                            : "bg-[var(--ide-surface-2)] border-[var(--ide-border)] text-[var(--ide-text)]";
                      return (
                        <span
                          key={i}
                          title={`${s.label} · ${humanSize(f.size)}${s.note ? `\n${s.note}` : ""}`}
                          className={`inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full border text-[10px] ${tone}`}
                        >
                          {s.level === "none" && <AlertCircle className="h-2.5 w-2.5 shrink-0" />}
                          <span className="max-w-[14rem] truncate">{f.name}</span>
                          <span className="opacity-60">{s.label}</span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(i)}
                            aria-label={`Remove ${f.name}`}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-full hover:bg-[var(--ide-hover)]"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      );
                    })}
                  </div>

                  {/* The whole point: say it before the upload, not after. */}
                  {(() => {
                    const summary = summariseAttachments(attachments);
                    if (!summary) return null;
                    return (
                      <div className="flex flex-col gap-0.5 pb-1">
                        {summary.unreadable.map((name) => {
                          const f = attachments.find((a) => a.name === name)!;
                          return (
                            <p key={name} className="flex items-start gap-1 text-[10px] text-amber-400">
                              <AlertCircle className="h-3 w-3 shrink-0 mt-px" />
                              <span>
                                <span className="font-medium">{name}</span> —{" "}
                                {describeAttachment(f).note} It will still be saved to your
                                workspace.
                              </span>
                            </p>
                          );
                        })}
                        {summary.caveats.map((name) => {
                          const f = attachments.find((a) => a.name === name)!;
                          return (
                            <p key={name} className="text-[10px] text-[var(--ide-muted)]">
                              <span className="font-medium">{name}</span> — {describeAttachment(f).note}
                            </p>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}

              <textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={!spec ? "Ask anything…" : specSubMode === "gen" ? "Describe what you want to build — I'll propose the agent & skills for it…" : selectedCustomAgent ? `Tell ${selectedCustomAgent} what to do…` : "Paste a spec or describe what to execute…"}
                disabled={sending}
                className="w-full resize-none bg-transparent px-3 py-2 text-[13px] text-[var(--ide-text)] placeholder:text-[var(--ide-muted)] focus:outline-none disabled:opacity-50"
              />
              <div className="flex items-center justify-between gap-1 px-2 pb-2">
                {/* Left: attach + agent selector (agent only in Spec Exec mode).
                    Strictly ONE line (nowrap chips) — but NO overflow-hidden:
                    the Spec/agents/permission dropdown menus render absolutely
                    positioned above this container and would be clipped
                    invisible by it. */}
                <div className="flex items-center gap-0.5 min-w-0">
                  {/* Attach — AUTO mode only: SPEC never reads attachments, so
                      the button was a dead control (and wasted row width) there. */}
                  {!spec && (
                    <button
                      type="button"
                      title="Attach file"
                      onClick={handleAttachClick}
                      className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--ide-hover)] text-[var(--ide-muted)]"
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                  )}
                  {!spec && (
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => handleFilesPicked(e.target.files)}
                    />
                  )}

                  {/* Permission mode dropdown — AUTO mode only. Sent as
                      permission_mode on every /api/agent/stream request. */}
                  {!spec && (
                    <div className="relative" ref={permMenuRef}>
                      <button
                        type="button"
                        title="Tool access mode"
                        onClick={() => setPermissionMenu((v) => !v)}
                        className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] transition-colors ${
                          permissionMenu
                            ? "bg-violet-600/20 text-violet-300"
                            : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
                        }`}
                      >
                        <Shield className="h-3.5 w-3.5" />
                        <span>{PERMISSION_MODES.find((m) => m.id === permissionMode)?.label}</span>
                        <ChevronDown className="h-3 w-3" />
                      </button>

                      {permissionMenu && (
                        <div className="absolute bottom-full left-0 mb-1 w-56 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl py-1">
                          <div className="px-2.5 py-1 mb-0.5">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">Tool Access</span>
                          </div>
                          {PERMISSION_MODES.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => { setPermissionMode(m.id); setPermissionMenu(false); }}
                              className={`flex items-center gap-2.5 w-full px-2.5 py-2 text-xs text-left transition-colors ${
                                permissionMode === m.id ? "bg-violet-600/20 text-violet-300" : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                              }`}
                            >
                              <m.Icon className="h-3.5 w-3.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium leading-none mb-0.5">{m.label}</div>
                                <div className="text-[10px] text-[var(--ide-muted)]">{m.desc}</div>
                              </div>
                              {permissionMode === m.id && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Deny-tools picker — AUTO mode, always visible regardless of
                      permission mode (the backend applies deny_tools "in all
                      modes including auto"). Checked tools are always blocked. */}
                  {!spec && (
                    <div className="relative" ref={denyMenuRef}>
                      <button
                        type="button"
                        title="Tools to always block"
                        onClick={() => setDenyMenu((v) => !v)}
                        className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] transition-colors ${
                          deniedTools.size > 0
                            ? "bg-red-600/20 text-red-300"
                            : denyMenu
                              ? "bg-violet-600/20 text-violet-300"
                              : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
                        }`}
                      >
                        <Ban className="h-3.5 w-3.5" />
                        <span>{deniedTools.size > 0 ? `Blocked (${deniedTools.size})` : "Tools"}</span>
                      </button>

                      {denyMenu && (
                        <div className="absolute bottom-full left-0 mb-1 w-60 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl py-1">
                          <div className="px-2.5 py-1 mb-0.5">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">Always Block</span>
                            <p className="text-[10px] text-[var(--ide-muted)] mt-0.5">Blocked in every mode, including Auto.</p>
                          </div>
                          <div className="max-h-[240px] overflow-y-auto">
                            {ALL_TOOLS.map((t) => {
                              const checked = deniedTools.has(t.id);
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={() =>
                                    setDeniedTools((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(t.id)) next.delete(t.id);
                                      else next.add(t.id);
                                      return next;
                                    })
                                  }
                                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left text-[var(--ide-text)] hover:bg-[var(--ide-hover)] transition-colors"
                                >
                                  <span
                                    className={`h-3.5 w-3.5 shrink-0 rounded-sm border flex items-center justify-center ${
                                      checked ? "bg-red-600 border-red-600" : "border-[var(--ide-border)]"
                                    }`}
                                  >
                                    {checked && <Check className="h-2.5 w-2.5 text-white" />}
                                  </span>
                                  {t.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* NOTE: custom agents are no longer a dropdown of their
                      own — they are a section inside the model menu below,
                      the way Copilot and Claude Code present them. The
                      selection was never the mechanism anyway: every agent
                      is in the catalog the model reads, so it picks the
                      right one from the question itself. */}

                  {/* Spec dropdown — only enabled in Spec mode */}
                  {spec && (
                    <div className="relative" ref={specMenuRef}>
                      <button
                        type="button"
                        title="Spec sub-mode"
                        onClick={() =>
                          setSpecMenu((v) => {
                            // Re-check agents.md on open so a roster generated
                            // since the last load enables Execution right away.
                            if (!v) void refreshSpecRoster();
                            return !v;
                          })
                        }
                        className={`inline-flex items-center gap-1 h-7 px-1.5 rounded text-[11px] shrink-0 transition-colors ${
                          specMenu
                            ? "bg-violet-600/20 text-violet-300"
                            : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
                        }`}
                      >
                        <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        <span className="whitespace-nowrap">{specSubMode === "gen" ? "Generation" : "Execution"}</span>
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      </button>

                      {specMenu && (
                        <div className="absolute bottom-full left-0 mb-1 w-44 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl py-1">
                          <div className="px-2.5 py-1 mb-0.5">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">Spec Mode</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setSpecSubMode("gen"); setSpecMenu(false); setAgentMenu(false); }}
                            className={`flex items-center gap-2 w-full px-2.5 py-2 text-xs text-left transition-colors ${
                              specSubMode === "gen" ? "bg-violet-600/20 text-violet-300" : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                            }`}
                          >
                            <Sparkles className="h-3.5 w-3.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium leading-none mb-0.5">Generation</div>
                              <div className="text-[10px] text-[var(--ide-muted)]">Generate BMAD-style agents & skills (use /specify for a full spec)</div>
                            </div>
                            {specSubMode === "gen" && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                          </button>
                          <button
                            type="button"
                            disabled={specAgents.length === 0 && customAgents.length === 0}
                            onClick={() => { setSpecSubMode("exec"); setSpecMenu(false); }}
                            className={`flex items-center gap-2 w-full px-2.5 py-2 text-xs text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                              specSubMode === "exec" ? "bg-violet-600/20 text-violet-300" : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                            }`}
                          >
                            <Code2 className="h-3.5 w-3.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium leading-none mb-0.5">Execution</div>
                              <div className="text-[10px] text-[var(--ide-muted)]">
                                {customAgents.length > 0
                                  ? "Run with a generated custom agent"
                                  : specAgents.length > 0
                                    ? "Execute with agent"
                                    : rosterLoading
                                      ? "Checking for agents…"
                                      : "No agents available — run Generation first"}
                              </div>
                            </div>
                            {specSubMode === "exec" && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Custom agents — count comes from parsing .devaccel/agents/
                      agents.md (agents phase, gate 4); the menu links to that
                      file rather than listing each agent. Info only: the
                      execution engine matches personas to tasks by the ids
                      declared in agents.md, no manual pick needed. Agents only
                      apply to Execution, so the chip is disabled in Generation. */}
                  {spec && specAgents.length > 0 && (
                    <div className="relative" ref={agentMenuRef}>
                      <button
                        type="button"
                        disabled={specSubMode !== "exec"}
                        title={specSubMode === "exec"
                          ? "Custom agents generated for this project"
                          : "Agents apply in Execution mode — switch the Spec dropdown to Execution"}
                        onClick={() => setAgentMenu((v) => !v)}
                        className={`inline-flex items-center gap-1 h-7 px-1.5 rounded text-[11px] shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          agentMenu
                            ? "bg-violet-600/20 text-violet-300"
                            : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
                        }`}
                      >
                        <Bot className="h-3.5 w-3.5 shrink-0" />
                        <span className="whitespace-nowrap">{specAgents.length} agent{specAgents.length === 1 ? "" : "s"}</span>
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      </button>

                      {agentMenu && specSubMode === "exec" && (
                        <div className="absolute bottom-full left-0 mb-1 w-64 z-50 rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl py-1">
                          <div className="px-2.5 py-1 mb-0.5">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">Custom Agents</span>
                          </div>
                          {/* One row per feature folder's agents.md. Clicking
                              opens the file and (for per-feature rosters)
                              selects that feature for Execution. */}
                          {specRosters.map((r) => {
                            const isActive = r === activeRoster;
                            return (
                              <button
                                key={r.path}
                                type="button"
                                title={r.feature ?? r.path}
                                onClick={() => {
                                  if (r.feature) setSpecFeature(r.feature);
                                  onOpenFile?.(r.path);
                                  setAgentMenu(false);
                                }}
                                className={`flex items-start gap-2.5 w-full px-2.5 py-2 text-xs text-left transition-colors ${
                                  isActive ? "bg-violet-600/20 text-violet-300" : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                                }`}
                              >
                                <FileText className="h-3.5 w-3.5 shrink-0 mt-px text-violet-400" />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium leading-none mb-0.5 truncate">agents.md</div>
                                  <div className="text-[10px] text-[var(--ide-muted)]">
                                    {r.agents.length} agent{r.agents.length === 1 ? "" : "s"} defined — click to open
                                  </div>
                                </div>
                                {isActive && <Check className="h-3 w-3 shrink-0 mt-px text-emerald-400" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right: model dropdown + send — AUTO mode swaps Send to a Stop
                    control while a run is active. shrink-0 keeps this group on
                    one line; only the model NAME truncates. */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* How full the context window is, from the live run. Sits
                      beside the picker because the two answer the same
                      question from opposite ends: which model, and how much
                      room is left in it. */}
                  <ContextMeter state={liveContextState} />

                  {/* The models THIS user may run on. Selecting one sends it
                      with the next message; the server re-checks entitlement
                      and falls back silently rather than refusing. */}
                  {allowedModels.length > 0 && (
                    <div className="relative" ref={modelMenuRef}>
                      <button
                        type="button"
                        title={
                          customAgents.length > 0
                            ? "Model for this chat, and the workspace's custom agents.\n" +
                              "An agent is chosen automatically from your question — " +
                              "pick one here only to pin it for every message."
                            : "Model this chat runs on"
                        }
                        onClick={() =>
                          setModelMenu((v) => {
                            // Re-scan on open so an agent file just dropped
                            // into the workspace shows up without a reload.
                            if (!v) void refreshCustomAgents();
                            return !v;
                          })
                        }
                        className={`inline-flex items-center gap-1 h-7 px-1.5 rounded text-[11px] shrink-0 transition-colors ${
                          modelMenu
                            ? "bg-violet-600/20 text-violet-300"
                            : "text-[var(--ide-muted)] hover:bg-[var(--ide-hover)] hover:text-[var(--ide-text)]"
                        }`}
                      >
                        <Cpu className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                        {/* A pinned agent takes the label: it changes every
                            reply, so leaving it invisible behind a closed
                            menu is how someone forgets it is on. */}
                        <span className="truncate max-w-[110px]">
                          {pinnedAgent
                            ? (pinnedAgent.agent.persona || pinnedAgent.agent.name)
                            : (chatModelName ?? "Model")}
                        </span>
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      </button>

                      {modelMenu && (
                        // Capped and scrollable: a workspace with a full BMAD
                        // roster has eight or more agents, and without this
                        // the list simply ran off the top of the window with
                        // no way to reach the rest.
                        <div className="absolute bottom-full right-0 mb-1 w-72 z-50 max-h-[60vh] overflow-y-auto rounded-md border border-[var(--ide-border)] bg-[var(--ide-surface-2)] shadow-xl py-1">
                          <div className="px-2.5 py-1 mb-0.5">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">
                              Available to you
                            </span>
                          </div>
                          {allowedModels.map((m) => {
                            const isActive = m.key === effectiveModelKey;
                            return (
                              <button
                                key={m.key}
                                type="button"
                                onClick={() => chooseModel(m.key)}
                                title={`${m.model_name} · ${(m.context_window / 1000).toFixed(0)}k context`}
                                className={`flex items-start gap-2.5 w-full px-2.5 py-2 text-xs text-left transition-colors ${
                                  isActive
                                    ? "bg-violet-600/20 text-violet-300"
                                    : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                                }`}
                              >
                                <Cpu className="h-3.5 w-3.5 shrink-0 mt-px text-violet-400" />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium leading-none mb-0.5 truncate">
                                    {m.display_name}
                                  </div>
                                  <div className="text-[10px] text-[var(--ide-muted)]">
                                    {(m.context_window / 1000).toFixed(0)}k context · {m.tier}
                                    {m.key === defaultModelKey ? " · your default" : ""}
                                  </div>
                                </div>
                                {isActive && <Check className="h-3 w-3 shrink-0 mt-px text-emerald-400" />}
                              </button>
                            );
                          })}

                          {/* Custom agents live HERE, in the same menu as the
                              models — the way Copilot and Claude Code present
                              them — instead of in a dropdown of their own.
                              Selecting one is an OVERRIDE, not the mechanism:
                              every agent is already in the catalog the model
                              sees, so "talk to Priya" routes without anyone
                              touching this menu. It exists to pin one
                              deliberately. */}
                          {customAgents.length > 0 && (
                            <>
                              {/* Header only. The "picked automatically" note
                                  used to sit here as two wrapped lines and
                                  pushed the list itself off the bottom of the
                                  menu — the agents are the point, so the
                                  explanation moved to the button's tooltip. */}
                              <div className="mt-1 pt-1 border-t border-[var(--ide-border)]">
                                <div className="flex items-center justify-between px-2.5 py-1">
                                  <span className="text-[10px] uppercase tracking-wider text-[var(--ide-muted)]">
                                    Custom agents · {customAgents.length}
                                  </span>
                                  {selectedCustomAgent && (
                                    <button
                                      type="button"
                                      onClick={() => { setSelectedCustomAgent(null); setModelMenu(false); }}
                                      className="text-[10px] text-violet-400 hover:text-violet-300"
                                    >
                                      Unpin
                                    </button>
                                  )}
                                </div>
                              </div>
                              {customAgents.map(({ agent }) => {
                                const isActive = agent.name === selectedCustomAgent;
                                // Name on its own line, role beneath. Joining
                                // them with "·" truncated both at this width
                                // ("Priya · Principal Java-to-Python Migr…"),
                                // which hid the one word the user is actually
                                // scanning for.
                                return (
                                  <button
                                    key={agent.name}
                                    type="button"
                                    onClick={() => {
                                      setSelectedCustomAgent(isActive ? null : agent.name);
                                      setModelMenu(false);
                                    }}
                                    title={agent.description || agent.name}
                                    className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
                                      isActive
                                        ? "bg-violet-600/20 text-violet-300"
                                        : "text-[var(--ide-text)] hover:bg-[var(--ide-hover)]"
                                    }`}
                                  >
                                    <span className="w-4 shrink-0 text-center leading-none">
                                      {agent.icon || "🤖"}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <div className="font-medium leading-tight truncate">
                                        {agent.persona || agent.name}
                                      </div>
                                      <div className="text-[10px] text-[var(--ide-muted)] leading-tight truncate">
                                        {agent.title || agent.description || agent.name}
                                      </div>
                                    </div>
                                    {isActive && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                                  </button>
                                );
                              })}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={sending ? handleStop : send}
                    disabled={sending ? stopPending : !input.trim()}
                    title={stopPending ? "Stopping…" : sending ? "Stop" : "Send"}
                    className={`h-8 w-8 inline-flex items-center justify-center rounded-lg transition-all shrink-0 ${
                      sending
                        ? "bg-red-600/80 hover:bg-red-500 text-white"
                        : `bg-gradient-to-r from-[var(--ide-gradient-from)] to-[var(--ide-gradient-to)] hover:brightness-110 disabled:opacity-40 text-white ${
                            input.trim() && !sending ? "ide-send-glow shadow-md shadow-violet-500/20" : ""
                          }`
                    }`}
                  >
                    {sending
                      ? <Square className="h-3.5 w-3.5 fill-current" />
                      : <SendHorizonal className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ChatDock;
