"""
Agent Stream API

Endpoints:
    POST /api/agent/stream             - main entry point, SSE response
    POST /api/agent/stop               - cancel an in-flight run
    POST /api/agent/resume             - resume a stopped run
    GET  /api/agent/status/{thread_id} - check thread status
    GET  /api/agent/usage/{thread_id}  - per-thread token usage
    GET  /api/agent/usage              - global token usage
    GET  /api/agent/history/{thread_id}- full chat history
    GET  /api/agent/workspace/{thread_id} - workspace paths

SSE EVENT SEQUENCE:
    thread_id -> classification -> thinking -> tool_start ->
    tool_result -> token_usage -> ... -> final -> run_summary -> done
"""

import json
import os
import sys
import traceback
from pathlib import Path

DEVSPHERE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = DEVSPHERE_DIR.parent
for candidate in (REPO_ROOT, DEVSPHERE_DIR):
    text = str(candidate)
    if text not in sys.path:
        sys.path.insert(0, text)

from dotenv import load_dotenv
load_dotenv(DEVSPHERE_DIR / ".env", override=True)

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi import File as FastAPIFile
from pydantic import BaseModel, Field
from typing import Any, List, Optional


def _parse_csv(value: Optional[str]) -> list:
    """Split a comma-separated string into a stripped list. Empty → []."""
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def _normalize_permission_mode(value: Optional[str]) -> str:
    """Request param → server default → one of the two live modes.

    Kept as one helper because /stream and /resume must resolve the mode
    identically; when they drifted, a resumed run silently ran under
    different rules than the one the user started.
    """
    return _normalize_mode(value) if value else _default_permission_mode()

from agents.custom_agent_registry import (
    build_agent_context,
    scan_custom_agents,
)
from skills import (
    build_catalog,
    build_session_scope,
)
from agents.orchestrator import OrchestratorAgent
from agents.workspace_paths import ThreadWorkspace
from agents.input_ingestion import ingest_uploads
from agents.stop_registry import StopRegistry
from llm.factory import LLMFactory
from tools.registry import ToolRegistry
from tools.client_broker import broker as _client_broker
from tools.create_output_tool import set_output_name_hint
from tools.permission_broker import permission_broker as _permission_broker
from context.conversation_summarizer import ConversationSummarizer
from context.budget_manager import allocate_budget
from context.token_estimator import set_model as set_token_model
from context.project_scanner import scan_project
from context.permissions import (
    PermissionConfig,
    default_mode as _default_permission_mode,
    normalize_mode as _normalize_mode,
    set_config as set_permission_config,
)
from utils.logger import get_logger, setup_logging
from utils.agent_logger import AgentLogger
from persistence.postgres_agent import (
    PostgresConversationHistory,
    PostgresLongTermMemory,
    PostgresRunStateStore,
    PostgresTokenTrackerStore,
)
from coordination import create_signal_bus
from router.auth import get_current_user
from spec_driven import (
    SpecWorkflow,
    SpecWorkflowStore,
    gate_broker as _gate_broker,
    parse_agents,
    parse_bmad_agent,
    parse_frontmatter,
    resolve_start,
)

# Initialize logging at import time (before anything else runs)
setup_logging()
log = get_logger(__name__)

agent_router = APIRouter(prefix="/api/agent", tags=["agent"])

# ── Process-wide singletons ──────────────────────────────────────
# Resume state lives in PostgreSQL (survives restarts, resumable from any
# worker); only the ephemeral stop flags stay in-process, mirrored to the
# signal bus when Redis is enabled.
_stop_registry = StopRegistry(state_store=PostgresRunStateStore())
_llm = None
_summarizer = None

_conversation_history = PostgresConversationHistory()
_token_store = PostgresTokenTrackerStore()
_spec_store = SpecWorkflowStore()
log.info("Persistence: PostgreSQL")

# Cross-worker signal bus: no-op for a single process; Redis-backed when the
# REDIS_URL env var is set, so /stop, /tool_result and /permission_response
# reach the worker holding the SSE stream under `uvicorn --workers N`.
_signal_bus = create_signal_bus()


def _clear_spill(thread_id: str) -> None:
    """Drop a finished run's offloaded context AND its checkpoints.

    Only ever called when a run completed on its own — a stopped or failed run
    keeps both so it can resume. Best-effort: housekeeping must never turn a
    successful run into an error.
    """
    try:
        from context.checkpoint import clear_thread as clear_checkpoints
        clear_checkpoints(thread_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("Checkpoint cleanup skipped for %s: %s", thread_id, exc)
    try:
        # Removes the whole tmp dir, which also takes the checkpoint FILES.
        from context.context_spill import clear_thread
        clear_thread(thread_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("Spill cleanup skipped for %s: %s", thread_id, exc)


@agent_router.on_event("startup")
async def _start_signal_bus():
    if _signal_bus.enabled:
        await _signal_bus.start({
            "tool_result": lambda tid, p: _client_broker.resolve(
                tid, p.get("id", ""), p.get("output")
            ),
            "permission": lambda tid, p: _permission_broker.resolve(
                tid, p.get("id", ""), p.get("decision", "deny")
            ),
            "gate": lambda tid, p: _gate_broker.resolve(
                tid, p.get("gate", ""), p.get("decision", "abort"), p.get("feedback")
            ),
        })


@agent_router.on_event("shutdown")
async def _stop_signal_bus():
    await _signal_bus.close()


def _require_thread_access(thread_id: str, user_id: str) -> None:
    """
    Enforce thread ownership: 404 unless the thread exists AND belongs to
    user_id (or is a legacy thread created before ownership existed).
    404 — not 403 — so other users' thread ids are indistinguishable from
    nonexistent ones (no information leak).
    """
    owner = _conversation_history.get_thread_user(thread_id)
    if owner is None:
        if not _conversation_history.thread_exists(thread_id):
            raise HTTPException(status_code=404, detail="Thread not found.")
        return  # legacy thread without an owner — allowed
    if owner != user_id:
        raise HTTPException(status_code=404, detail="Thread not found.")

# Fallback context window, used only when no `model_configs` row applies.
# Common values: 8192 (GPT-4), 16384 (GPT-4-16k), 128000 (GPT-4o)
_env_context_window = int(os.getenv("MODEL_CONTEXT_WINDOW", "128000"))


def _get_llm():
    """A model for work that isn't tied to a specific caller — conversation
    summarisation, and the legacy /chat/stream endpoint.

    Prefers `.env`, then falls back to the catalogue's default row. That order
    is deliberate: `.env` is per-host, so it stays the way an operator pins
    this process to one deployment. But once models live in the database, the
    Azure block in `.env` is redundant, and a deployment that has removed it
    must not lose history summarisation — which is what happens if this raises.

    Raises only when BOTH are unavailable, which is a genuinely unconfigured
    install.
    """
    global _llm
    if _llm is None:
        try:
            _llm = LLMFactory.create()
        except ValueError as env_error:
            from llm.model_registry import default_for_user

            cfg = default_for_user(None)
            _llm = LLMFactory.from_config(cfg) if cfg else None
            if _llm is None:
                raise ValueError(
                    "No model available: .env has no Azure configuration and the "
                    "model_configs catalogue has no usable default row."
                ) from env_error
            log.info(
                f"No .env model configured — using the catalogue default "
                f"'{cfg.model_key}' ({cfg.model_name})."
            )
    return _llm


def resolve_run_model(user_id: str, requested_model: Optional[str] = None):
    """Pick the model this run executes on: `(llm, context_window, model_cfg)`.

    `model_cfg` is None when the answer came from `.env` — either no models are
    configured in the database, or the row that applied couldn't be built into
    a client. Callers use it for usage attribution and pricing; everything else
    works the same either way.

    Never raises. A model the caller may not use, one an admin just
    deactivated, or an unmigrated database all fall back to the .env model
    rather than costing the user their turn.
    """
    try:
        from llm.model_registry import resolve as resolve_model

        cfg = resolve_model(user_id, requested_model)
        if cfg is not None:
            llm = LLMFactory.from_config(cfg)
            if llm is not None:
                return llm, cfg.context_window, cfg
    except Exception as e:  # noqa: BLE001 — model choice must never fail a run
        log.warning(f"Model resolution failed for user {user_id} ({e}) — using the .env model")

    return _get_llm(), _env_context_window, None


def _check_quota(user_id: str, model_cfg=None):
    """The caller's budget standing. Never raises — a quota system that fails
    closed on a database hiccup takes the product down with it."""
    from quota import QuotaDecision, check as quota_check

    try:
        return quota_check(user_id, model_cfg)
    except Exception as e:  # noqa: BLE001
        log.warning(f"Quota check failed for user {user_id} ({e}) — allowing the run")
        return QuotaDecision(effective_model=model_cfg)


def _make_quota_probe(user_id: str, opening_level: str):
    """A callback the agent loop calls between steps to re-read the budget.

    Returns a `quota_notice` payload only when the user's standing has got
    WORSE than it was when the run started — a run that began at 'warn' should
    not repeat that banner at every step, but crossing into 'critical'
    mid-run is worth saying.

    The run is never stopped from here. Stopping is the per-run ceiling's job
    (an agent that won't terminate) and the next run's opening check's job (a
    budget genuinely spent).
    """
    from quota.service import LEVELS

    opening_rank = LEVELS.index(opening_level) if opening_level in LEVELS else 0

    def _probe(_tokens_so_far: int):
        decision = _check_quota(user_id)
        rank = LEVELS.index(decision.level) if decision.level in LEVELS else 0
        if rank <= opening_rank:
            return None
        return decision.to_event()

    return _probe


def _get_summarizer():
    global _summarizer
    if _summarizer is None:
        _summarizer = ConversationSummarizer(_get_llm())
    return _summarizer


def _sse_event(event_type: str, data: dict) -> str:
    """Format one SSE event line. Same wire format as router/apis.py."""
    payload = json.dumps({"type": event_type, **data})
    return f"data: {payload}\n\n"


def _new_thread_id() -> str:
    import uuid
    return str(uuid.uuid4())


def _build_postgres_thread_memory(thread_id: str):
    """Build a ThreadMemory-compatible object backed by PostgreSQL."""
    from memory.thread_memory import ThreadMemory

    tm = object.__new__(ThreadMemory)
    tm.thread_id = thread_id
    tm.conversation_history = _conversation_history
    tm.long_term = PostgresLongTermMemory(thread_id)
    return tm


# ── Request/Response models ──────────────────────────────────────

class StopRequest(BaseModel):
    thread_id: str

class ToolResultRequest(BaseModel):
    """Pattern C — the client POSTs this after executing a delegated tool."""
    thread_id: str
    id: str = Field(description="The call id from the matching `client_tool_use` event.")
    output: Any = Field(default=None, description="The tool's result (any JSON value).")

class PermissionResponseRequest(BaseModel):
    """Ask mode — the client POSTs this after the user approves/rejects a tool."""
    thread_id: str
    id: str = Field(description="The request id from the matching `permission_request` event.")
    decision: str = Field(
        description="'allow' (run once) · 'allow_session' (don't ask again this thread) · 'deny'.",
    )

class GateResponseRequest(BaseModel):
    """Spec-driven development — the client POSTs this after the user reviews
    the files a phase generated (the `gate_request` SSE event)."""
    thread_id: str
    gate: str = Field(description="The gate id from the matching `gate_request` event, e.g. 'gate1'.")
    decision: str = Field(description="'approve' (next phase) · 'revise' (re-run this phase with feedback) · 'abort'.")
    feedback: Optional[str] = Field(
        default=None,
        description="Required for 'revise': what to change in the generated file(s).",
    )


class ResumeRequest(BaseModel):
    thread_id: str
    permission_mode: Optional[str] = Field(
        default=None,
        description=(
            "'manual' (default — every change asks for approval) or 'auto' "
            "(no prompts). Retired values 'ask'/'standard'/'strict' are "
            "accepted and normalised to 'manual'. Defaults to the server's "
            "PERMISSION_MODE env var, else 'manual'."
        ),
    )
    allow_tools: Optional[str] = Field(
        default=None,
        description="Comma-separated tool names that are allowed to run. All others are blocked, in EVERY mode. Example: 'read_file,grep_search,workspace_tree'",
    )
    deny_tools: Optional[str] = Field(
        default=None,
        description="Comma-separated tool names that are always blocked, regardless of mode. Example: 'run_terminal,file_write,git'",
    )
    allow_paths: Optional[str] = Field(
        default=None,
        description="Comma-separated glob patterns. Only matching paths are readable/writable. Example: 'src/**,tests/**,README.md'",
    )
    deny_paths: Optional[str] = Field(
        default=None,
        description="Comma-separated glob patterns that are always blocked. Example: 'config/prod.json,*.bak,secrets/**'",
    )
    model: Optional[str] = Field(
        default=None,
        description="Model key to resume on (see GET /api/agent/models). Omit to use the caller's default.",
    )


# ── POST /api/agent/stream ───────────────────────────────────────

@agent_router.post("/stream")
async def agent_stream(
    message: str = Form(
        ...,
        description="User instruction — any length, any format (text, code, JSON, natural language).",
    ),
    thread_id: Optional[str] = Form(
        default=None,
        description="Reuse an existing conversation thread. Auto-generated UUID if omitted.",
    ),
    workspace_path: Optional[str] = Form(
        default=None,
        description=(
            "Absolute path to the directory the agent should operate on. "
            "MANDATORY on the FIRST request of a thread (422 otherwise) — saved to "
            "PostgreSQL and recalled automatically on all follow-up requests, so it "
            "may be omitted once the thread has one. If the path doesn't exist on "
            "the server machine (client-side workspace, Pattern C), server tools "
            "fall back to the thread's server workspace while client-delegated "
            "tools operate on the client's real folder."
        ),
    ),
    permission_mode: Optional[str] = Form(
        default=None,
        description=(
            "Tool access mode for this request — two modes:\n"
            "• 'manual' (DEFAULT) — reads and searches run freely; every change "
            "(file_write, code_edit, run_terminal, git, MCP tools, anything not "
            "on the read-only list) pauses for human approval. Calls whose "
            "ARGUMENTS are high-impact — writing .env, running a migration, "
            "`terraform apply` — are labelled with the reason on the approval "
            "card. The user answers allow / allow for this session / reject.\n"
            "• 'auto'             — nothing is gated; the agent edits and "
            "executes on its own.\n"
            "Retired values 'ask', 'standard' and 'strict' are accepted and "
            "normalised to 'manual' so older clients keep working; the tool "
            "narrowing that 'strict' provided is now allow_tools, which applies "
            "in every mode.\n"
            "Omit to use the server's PERMISSION_MODE env var (default: 'manual')."
        ),
    ),
    allow_tools: Optional[str] = Form(
        default=None,
        description=(
            "Comma-separated list of tool names that are allowed to run. "
            "All other tools are blocked — in EVERY mode, including 'auto', "
            "because this is operator policy (least privilege), not a prompt "
            "preference. Example: 'read_file,grep_search,workspace_tree'"
        ),
    ),
    deny_tools: Optional[str] = Form(
        default=None,
        description=(
            "Comma-separated list of tool names that are always blocked, regardless of mode. "
            "Takes effect in all modes including 'auto'. "
            "Example: 'run_terminal,file_write,git'"
        ),
    ),
    allow_paths: Optional[str] = Form(
        default=None,
        description=(
            "Comma-separated glob patterns. Only files matching these patterns "
            "can be read or written. Paths outside this list are blocked. "
            "Example: 'src/**,tests/**,README.md,package.json'"
        ),
    ),
    deny_paths: Optional[str] = Form(
        default=None,
        description=(
            "Comma-separated glob patterns that are always blocked for reading and writing. "
            "Example: 'config/prod.json,*.bak,secrets/**,.env.production'"
        ),
    ),
    client_tools: Optional[str] = Form(
        default=None,
        description=(
            "Pattern C — comma-separated names of tools the CLIENT will execute "
            "locally (against the browser/VS Code workspace) instead of the server. "
            "For each name, the server emits a `client_tool_use` SSE event and waits "
            "for the client to POST the result to /api/agent/tool_result. Omit to run "
            "all tools on the server (default). Example: "
            "'read_file,write_file,code_edit,grep_search,file_search,list_directory,workspace_tree,batch_read_files'"
        ),
    ),
    client_os: Optional[str] = Form(
        default=None,
        description=(
            "OS of the CLIENT machine that executes delegated commands "
            "(Pattern C + daemon): 'windows' | 'macos' | 'linux' (raw "
            "process.platform values like 'win32'/'darwin' also accepted). "
            "Used to describe run_terminal for the RIGHT shell (cmd.exe vs "
            "POSIX sh) and to tell the model which OS its commands target. "
            "Ignored when commands run on the server."
        ),
    ),
    mcp_local_tools: Optional[str] = Form(
        default=None,
        description=(
            "Pattern C (MCP) — JSON manifest of LOCAL stdio MCP servers the "
            "client already started on the user's machine via the daemon: "
            "{\"<server>\": {\"tools\": [{\"name\", \"description\", \"inputSchema\"}]}}. "
            "Each tool becomes an mcp__<server>__<tool> delegating tool whose "
            "calls are proxied browser→daemon. Omit when no local MCP servers "
            "are configured."
        ),
    ),
    repo_map: Optional[str] = Form(
        default=None,
        description=(
            "Phase 6 — a client-built repository map (file tree + top-level symbols) "
            "sent on the first message of a thread. Injected into the model's context "
            "so it orients without many list_directory/read_file calls."
        ),
    ),
    runtime_report: Optional[str] = Form(
        default=None,
        description=(
            "Runtime availability report from the USER's machine (daemon "
            "/runtimes/check): which language runtimes the workspace's manifests "
            "require and whether each is installed, with versions. Injected into "
            "the model's context so it suggests environment setup up front "
            "instead of failing commands."
        ),
    ),
    project_memory: Optional[str] = Form(
        default=None,
        description=(
            "Content of devaccel.md read from the CLIENT's workspace (Pattern C) "
            "— persistent project memory the agent maintains, like Claude Code's "
            "CLAUDE.md. Sent by clients whose workspace the server cannot read; "
            "takes precedence over any server-side devaccel.md."
        ),
    ),
    thread_memory_state: Optional[str] = Form(
        default=None,
        description=(
            "This thread's long-term memory entries (JSON array) from the "
            "CLIENT's canonical copy (~/.devaccel/projects/<root>/memory/). "
            "Used to re-seed the server store when it has nothing for the "
            "thread (fresh server / wiped DB) — the mirror of the "
            "memory_snapshot SSE event."
        ),
    ),
    spec_mode: Optional[str] = Form(
        default=None,
        description=(
            "Spec mode (see SPEC_DRIVEN_PLAN.md). Omit for a normal agent "
            "run (today's behaviour, unchanged).\n"
            "• 'generation' — AGENT BUILDER (default): roster → gate1 → "
            "scaffold → gate2, producing BMAD-style "
            ".devaccel/agents/<name>.agent.md + "
            ".devaccel/skills/<name>/SKILL.md which the agents dropdown "
            "(Spec → Execution) then discovers.\n"
            "• 'execution'  — walk an approved tasks.md task-by-task "
            "(legacy Spec-Kit pipeline).\n"
            "A leading keyword in `message` selects the LEGACY spec pipeline "
            "instead: /specify /clarify /plan /tasks /implement (GitHub Spec "
            "Kit) or @analyst @pm @architect @sm @po @dev @qa (BMAD "
            "personas); /agents explicitly selects the agent builder."
        ),
    ),
    spec_feature: Optional[str] = Form(
        default=None,
        description=(
            "Which feature the spec run targets, e.g. '001-user-auth'. "
            "Required semantics: execution uses it (falls back to the thread's "
            "latest workflow); generation derives a fresh number when omitted."
        ),
    ),
    agent_name: Optional[str] = Form(
        default=None,
        description=(
            "Run this turn AS a custom agent (BMAD / Claude Code file "
            "convention). The agent's definition is resolved from the "
            "workspace (.devaccel/agents/<name>.md, .claude/agents/, BMAD "
            "installs) or from `agent_file` when the workspace lives on the "
            "client. Its body becomes the persona system prompt and its "
            "`skills:` get injected; its `tools:` list is ADVISORY (persona "
            "guidance) — the full toolset stays available under the "
            "request's own permission_mode. Ignored when spec_mode is set."
        ),
    ),
    agent_file: Optional[str] = Form(
        default=None,
        description=(
            "Pattern C — raw content of the selected agent's .md definition "
            "file, sent by clients whose workspace the server cannot read. "
            "Must contain a frontmatter block whose name matches agent_name."
        ),
    ),
    skill_files: Optional[str] = Form(
        default=None,
        description=(
            "Pattern C — JSON object mapping skill name → SKILL.md content "
            "for the selected agent's `skills:` list, sent by clients whose "
            "workspace the server cannot read. Ignored without agent_name."
        ),
    ),
    skill_catalog: Optional[str] = Form(
        default=None,
        description=(
            "Pattern C — JSON array of the definitions the CLIENT discovered "
            "in the user's workspace: [{name, kind, description, path, "
            "persona, links}]. METADATA ONLY — bodies are not sent here; the "
            "agent pulls one at a time through the `skill` tool, which reads "
            "it back through the client. Merged with the server's own scan, "
            "with these entries winning: the client's workspace is canonical."
        ),
    ),
    model: Optional[str] = Form(
        default=None,
        description=(
            "Which model to run on — the `key` of a row in `model_configs` "
            "(see GET /api/agent/models for the ones this caller may use). "
            "Omit to run on the caller's default. A key that doesn't exist, or "
            "that the caller isn't entitled to, silently falls back to that "
            "default rather than failing the run."
        ),
    ),
    client_input_paths: Optional[str] = Form(
        default=None,
        description=(
            "JSON object mapping an attachment's original filename → the path "
            "the CLIENT saved its own copy to, inside the user's workspace "
            "(e.g. {\"spec.docx\": \".devaccel/input/spec.docx\"}). When given, "
            "the model is told THAT path rather than the server's temporary "
            "copy — read_file is client-executed, so a server path is one its "
            "tools cannot open. Omit when the client has no local folder "
            "access; the server path is then used as before."
        ),
    ),
    files: List[UploadFile] = FastAPIFile(
        default=[],
        description=(
            "Files attached to this message. ANY type is accepted. Each one is "
            "saved to the thread's input/ directory AND parsed for the model: "
            "PDFs, Word/Excel/PowerPoint, CSV, HTML, notebooks and email become "
            "text; images become vision input; a scanned PDF's pages are "
            "rendered to images. Audio and video are saved and described "
            "(duration, format) but cannot be watched or transcribed — the "
            "model is told so explicitly. The declared Content-Type is recorded "
            "but NOT trusted: type detection is from the file's own bytes."
        ),
    ),
    user_id: str = Depends(get_current_user),
):
    """
    Main agent entry point — returns a Server-Sent Events (SSE) stream.

    **Permission system** (all permission params are optional, combinable):

    | param | purpose |
    |---|---|
    | `permission_mode` | `manual` (default — every change asks) or `auto` (no prompts) |
    | `allow_tools` | Whitelist of tool names (comma-separated). Blocks all others, in every mode. |
    | `deny_tools` | Blacklist of tool names (comma-separated). Always blocked. |
    | `allow_paths` | Glob whitelist for file paths. Only matching paths are accessible. |
    | `deny_paths` | Glob blacklist for file paths. Matching paths are always blocked. |

    **Common combinations:**

    Read-only analysis:
    `permission_mode=manual&allow_tools=read_file,grep_search,file_search,workspace_tree`

    Block a specific tool only:
    `deny_tools=run_terminal`

    Restrict to specific folder:
    `allow_paths=src/**,tests/**`

    Unattended build (no approval prompts):
    `permission_mode=auto`
    """
    if spec_mode and spec_mode not in ("generation", "execution"):
        raise HTTPException(
            status_code=422,
            detail="spec_mode must be 'generation' or 'execution' (or omitted).",
        )

    resolved_thread_id = thread_id or _new_thread_id()

    # ── Validate BEFORE persisting anything ──────────────────────────────────
    # Ownership and workspace_path are both checked before claim_thread, because
    # claim_thread WRITES a workspace row. Rejecting afterwards left one orphan
    # row per invalid request — invisible while unnamed workspaces collided on
    # ux_workspaces_owner_name_active (they 500'd instead), and silently
    # accumulating as "Untitled workspace" entries once that was fixed.

    # A thread that already exists must belong to the caller. Read-only: an
    # unknown thread returns None here and is created further down.
    existing_owner = _conversation_history.get_thread_user(resolved_thread_id)
    if existing_owner is not None and existing_owner != user_id:
        # 404, not 403 — a foreign thread id must look nonexistent.
        raise HTTPException(status_code=404, detail="Thread not found.")

    # Determine the directory tools operate on — Claude Code style:
    # 1. If caller passed workspace_path, use and persist it (first request or explicit override)
    # 2. Otherwise load the previously saved path for this thread from PostgreSQL
    # 3. Fall back to server default only if neither is available
    import pathlib
    resolved_workspace = workspace_path
    workspace_source = "explicit" if workspace_path else "saved"

    if not resolved_workspace:
        resolved_workspace = _conversation_history.get_workspace_path(resolved_thread_id)

    # workspace_path is MANDATORY: every run must be anchored to a real user
    # workspace — either passed explicitly or already saved on the thread.
    # Silent fallback to the server's internal folder made generated files
    # "vanish" from the user's point of view (especially spec generation).
    if not resolved_workspace:
        raise HTTPException(
            status_code=422,
            detail="workspace_path is required on the first request of a thread. "
                   "Pass the absolute path of the project folder the agent should "
                   "work on (it is saved and reused for follow-up requests).",
        )

    # ── Request is valid — now take ownership of the thread ──────────────────
    # Still via claim_thread rather than a plain INSERT: it is atomic, so two
    # concurrent first-requests can't both think they own the thread.
    effective_owner = _conversation_history.claim_thread(resolved_thread_id, user_id)
    if effective_owner != user_id:
        raise HTTPException(status_code=404, detail="Thread not found.")

    # Which model this user runs on — their explicit choice if they're entitled
    # to it, else the default their role/team/user policy grants, else .env.
    llm, context_window, model_cfg = resolve_run_model(user_id, model)

    # Budget check BEFORE any work starts. Over the limit the run continues on
    # a cheaper model rather than stopping (see quota/service.py); only an
    # admin's explicit hard ceiling refuses it outright.
    _quota = _check_quota(user_id, model_cfg)
    if not _quota.allowed:
        raise HTTPException(status_code=429, detail=_quota.message)
    if _quota.degraded and _quota.effective_model is not None:
        _degraded_llm = LLMFactory.from_config(_quota.effective_model)
        if _degraded_llm is not None:
            llm, model_cfg = _degraded_llm, _quota.effective_model
            context_window = _quota.effective_model.context_window
            log.info(
                f"User {user_id} over budget — downgraded to "
                f"{model_cfg.model_key} ({model_cfg.model_name})"
            )
        else:
            # The nominated fallback can't be built. Continuing on the original
            # model is the lesser evil: the alternative is failing a run over a
            # misconfiguration the user can do nothing about.
            log.warning(
                f"Degrade model '{_quota.effective_model.model_key}' could not be "
                f"built — user {user_id} continues on {model_cfg.model_key if model_cfg else '.env'}"
            )
            _quota.degraded = False

    # Token counts must use the encoding of the model actually serving this
    # run: gpt-5-class deployments use o200k_base, the GPT-4 family cl100k_base,
    # and they differ by 10-20% on source code. Every budget below derives from
    # these counts, so getting it wrong mis-measures how full the window is.
    set_token_model(
        (model_cfg.model_name if model_cfg else None)
        or getattr(llm, "deployment", "")
    )

    _budget = allocate_budget(context_window)
    if model_cfg is not None:
        log.info(
            f"Run model: {model_cfg.model_key} → {model_cfg.model_name} "
            f"(window={context_window}, requested={model or 'default'})"
        )

    workspace = ThreadWorkspace.for_thread(resolved_thread_id)
    # One id for this whole turn, so the per-run ceiling and the UI's
    # per-message badge read the same rows.
    run_id = _new_thread_id()
    token_tracker = _token_store.get(
        resolved_thread_id,
        user_id=user_id,
        run_id=run_id,
        model_config=model_cfg,
    )

    thread_memory = _build_postgres_thread_memory(resolved_thread_id)

    if resolved_workspace and pathlib.Path(resolved_workspace).is_dir():
        tools_root = str(pathlib.Path(resolved_workspace).resolve())
        _conversation_history.save_workspace_path(resolved_thread_id, tools_root)
    else:
        tools_root = workspace.project_root
        workspace_source = "server_default"

    # Apply permissions for this request.
    # mode: param → env var → "auto"
    # allow/deny lists: parsed from comma-separated form values
    # normalize_mode() maps retired names (ask/standard/strict) onto the two
    # live modes and resolves anything unrecognised to `manual` — a typo in a
    # config value must never silently turn every approval prompt off.
    _effective_mode = _normalize_permission_mode(permission_mode)
    _perm_cfg = PermissionConfig(
        mode=_effective_mode,
        allow_tools=set(_parse_csv(allow_tools)),
        deny_tools=set(_parse_csv(deny_tools)),
        allow_paths=_parse_csv(allow_paths),
        deny_paths=_parse_csv(deny_paths),
    )
    # NOTE: the config is BOUND inside event_generator (per-request
    # ContextVar), right before the orchestrator task is created — never to
    # a global keyed by workspace, so concurrent users can't overwrite each
    # other's permissions.
    log.info(
        f"Permissions: mode={_effective_mode} "
        f"allow_tools={_perm_cfg.allow_tools or '*'} "
        f"deny_tools={_perm_cfg.deny_tools or 'none'} "
        f"allow_paths={_perm_cfg.allow_paths or '*'} "
        f"deny_paths={_perm_cfg.deny_paths or 'none'}"
    )

    # Pattern C: tools the client declared it will run locally (empty → all
    # tools run on the server, preserving the original same-machine behaviour).
    _client_tool_names = set(_parse_csv(client_tools))
    if _client_tool_names:
        log.info(f"Client-executed tools (Pattern C): {sorted(_client_tool_names)}")

    # ── Custom agent persona (BMAD / Claude Code file convention) ────
    # agent_name runs this turn AS a workspace-defined agent. The definition
    # file is UNTRUSTED input: its body/skills are injected as context, and
    # its tools list can only NARROW this request's permissions — never
    # widen them (least privilege).
    _agent_context = ""
    if agent_name and not spec_mode:
        _active_agent = None
        _server_scan = None
        if agent_file:
            # Pattern C — the client read the definition locally and sent it.
            _active_agent = next(
                (a for a in parse_agents(agent_file) if a["name"] == agent_name),
                None,
            )
            if _active_agent is None:
                # BMAD Core convention: no frontmatter at ALL. The definition
                # is a ```yaml block carrying an `agent:` mapping (id, name,
                # title, whenToUse) and the whole file is the operating prompt.
                #
                # scan_custom_agents() has always read these, so a workspace
                # the SERVER can see resolved them fine — but Pattern C did
                # not, so the identical file 404'd whenever the workspace sat
                # on the client's machine. That is every daemon-backed local
                # folder, i.e. the normal case: the agent was listed in the
                # dropdown (the client names it after the file) and then
                # refused the moment it was actually used.
                _active_agent = parse_bmad_agent(agent_file, fallback_name=agent_name)
            if _active_agent is None:
                # GitHub Copilot stub (BMAD v6): frontmatter carries only
                # description: — the name is the filename, which the client
                # sent as agent_name. Accept it as a thin persona.
                _stub = parse_frontmatter(agent_file)
                if _stub is not None:
                    _meta, _body = _stub
                    _active_agent = {
                        "name": agent_name,
                        "description": _meta.get("description", ""),
                        "tools": [], "skills": [], "tasks": [], "model": "",
                        "system_prompt": _body,
                    }
        else:
            _server_scan = scan_custom_agents(tools_root)
            _active_agent = next(
                (a for a in _server_scan["agents"] if a["name"] == agent_name),
                None,
            )
        if _active_agent is None:
            # Say which of the two failures happened. The old message named
            # directories in both cases, which sent people hunting for a file
            # that was present all along — and had even been uploaded.
            if agent_file:
                _detail = (
                    f"Custom agent '{agent_name}' was sent, but no definition could be "
                    f"read from its file. Recognised formats: YAML frontmatter with "
                    f"name/description, a BMAD Core ```yaml block containing an "
                    f"`agent:` mapping, or a description-only stub."
                )
            else:
                _known = sorted(
                    a.get("name", "") for a in ((_server_scan or {}).get("agents") or [])
                )
                _detail = (
                    f"Custom agent '{agent_name}' not found under {tools_root} "
                    f"(.devaccel/agents/, .claude/agents/, BMAD installs). "
                    f"Agents found there: {', '.join(_known) if _known else 'none'}. "
                    f"If the workspace is on the client machine, the client must send "
                    f"the definition as agent_file."
                )
            raise HTTPException(status_code=404, detail=_detail)

        # Skills the agent declares (BMAD agent↔skill association).
        # Client-sent contents win — the client's workspace is canonical;
        # otherwise use the server-visible skills/<name>/SKILL.md copies.
        _skill_contents: dict = {}
        if skill_files:
            try:
                _parsed_skills = json.loads(skill_files)
                if isinstance(_parsed_skills, dict):
                    _skill_contents = {str(k): str(v) for k, v in _parsed_skills.items()}
            except (ValueError, TypeError) as e:
                log.warning(f"skill_files ignored (bad JSON): {e}")
        if not _skill_contents and _server_scan and _active_agent.get("skills"):
            _skill_contents = {
                s["name"]: s["instructions"]
                for s in _server_scan["skills"]
                if s["name"] in _active_agent["skills"]
            }

        # The agent file's `tools:` list is ADVISORY, not enforced — the
        # persona runs with the FULL toolset (web_search, web_fetch,
        # create_output, sub_agent, …) and the model itself favors the
        # listed tools because they're in its persona context. Enforcement
        # was dropped deliberately: generated agent files can't anticipate
        # every tool a real task needs, and narrowing silently broke
        # research/output tools mid-execution. The REQUEST's own
        # permission_mode (user's chip: manual/auto) still
        # applies unchanged — personas never widen it.
        _agent_context = build_agent_context(_active_agent, _skill_contents)
        log.info(f"Custom agent active: '{agent_name}' "
                 f"(advisory tools={sorted(_active_agent.get('tools') or []) or 'none listed'}, "
                 f"skills={_active_agent.get('skills') or []})")

    # ── Skill catalog ────────────────────────────────────────────────
    # Everything this workspace can load: our built-in methodology pack, plus
    # whatever framework the user dropped in — discovered by filename, so an
    # unfamiliar layout registers as readily as a canonical one. Only name +
    # description reach the prompt; bodies come one at a time through the
    # `skill` tool. Rebuilt per request, so a file added mid-conversation
    # shows up on the next message with no restart.
    _client_catalog = None
    if skill_catalog:
        try:
            _parsed = json.loads(skill_catalog)
            if isinstance(_parsed, list):
                _client_catalog = _parsed
        except (ValueError, TypeError) as e:
            log.warning(f"skill_catalog ignored (bad JSON): {e}")

    # `user_name` is deliberately NOT user_id — that is an opaque identifier,
    # and a skill whose first instruction is "greet {user_name}" would open
    # with a UUID. It defaults to "the user" and is overridden by the
    # workspace's own config when one supplies a real name, which is exactly
    # where a framework expects to declare it.
    _session_scope = build_session_scope(
        workspace=tools_root,
        thread_id=resolved_thread_id,
        output_folder=os.path.join(".devaccel", resolved_thread_id, "output"),
    )
    try:
        _catalog = build_catalog(tools_root, client_entries=_client_catalog)
    except Exception as e:  # noqa: BLE001 — discovery never costs a turn
        log.warning(f"Skill catalog unavailable ({e}) — continuing without it")
        _catalog = []
    if _catalog:
        log.info(
            f"Skill catalog: {len(_catalog)} entries "
            f"({sum(1 for e in _catalog if e.kind == 'agent')} agents, "
            f"{sum(1 for e in _catalog if e.origin != 'builtin')} from the workspace)"
        )

    tool_registry = ToolRegistry.build_for_workspace(
        tools_root,
        long_term_memory=thread_memory.long_term,
        output_dir=tools_root,
        llm=llm,
        thread_id=resolved_thread_id,
        token_tracker=token_tracker,
        context_window=context_window,
        client_tools=_client_tool_names,
        client_os=client_os,
        skill_catalog=_catalog,
        session_scope=_session_scope,
    )

    # MCP client (Phase 1): remote HTTP/SSE servers declared in .mcp.json become
    # tools on THIS registry. Built sync here; connected + attached inside
    # event_generator (async) and closed in its finally. None when no remote MCP
    # servers are configured, so existing setups are unchanged.
    from mcp_integration.client.bootstrap import build_remote_manager
    _mcp_manager = build_remote_manager(tools_root)

    # MCP client (Phase 2): LOCAL stdio servers run on the user's machine via the
    # daemon. The client already started them and sent their tool manifest; wrap
    # each as a ClientDelegatingTool (mcp__server__tool) so calls are proxied
    # browser→daemon, reusing the client_broker path. No manifest → nothing added.
    if mcp_local_tools:
        from mcp_integration.client.local_tools import build_local_mcp_tools
        for _lt in build_local_mcp_tools(mcp_local_tools, resolved_thread_id, tools_root):
            if tool_registry.get(_lt.name) is None:
                tool_registry._tools.append(_lt)
                tool_registry._by_name[_lt.name] = _lt

    # Read uploads BEFORE entering the async generator - UploadFile's
    # SpooledTemporaryFile must be read while the request is still in
    # scope; the StreamingResponse generator runs after this function
    # returns control to FastAPI.
    #
    # Every file takes the SAME path from here. The split used to happen right
    # at this point, on `content_type.startswith("image/")` — the browser's
    # claim about the file — with images going to the model and everything else
    # becoming a filename in a list. What a file IS, and what the model can be
    # shown of it, are both decided by ingestion/ now, from the bytes.
    from ingestion import limits as _ingest_limits

    _max_upload = _ingest_limits.max_file_bytes()
    uploads_payload = []
    _oversized = []
    for f in files:
        # Check the declared size BEFORE read(). Starlette spools an upload to
        # a temp file past ~1 MB, so the bytes are not all in RAM — but
        # materialising them into a `bytes` object here would be, and a client
        # can send a file of any size. `.size` is absent on some ASGI servers,
        # in which case ingest_uploads still rejects it after the read; this
        # just avoids paying for the read when we already know the answer.
        declared_size = getattr(f, "size", None)
        if declared_size is not None and declared_size > _max_upload:
            _oversized.append(
                f"{f.filename or 'upload'} — {declared_size:,} bytes, over the "
                f"{_max_upload:,}-byte per-file limit. It was NOT saved or read."
            )
            continue
        uploads_payload.append({
            "filename": f.filename or "upload",
            "content": await f.read(),
            "content_type": f.content_type or "application/octet-stream",
        })

    async def event_generator():
        # Bind this request's permission config to the current async context.
        # asyncio.create_task(run_orchestrator()) below snapshots the context,
        # so every tool call in THIS run sees exactly these rules — isolated
        # from every other concurrent request, even on the same workspace.
        set_permission_config(tools_root, _perm_cfg)
        # Same ContextVar isolation for deliverable naming: create_output
        # renames generic filenames ('summary.md') after this request's domain.
        set_output_name_hint(message)

        # MCP: connect remote servers and expose their tools BEFORE the agent
        # builds its tool schemas. Failures are non-fatal — a bad server simply
        # contributes no tools; the run proceeds with the native toolset.
        if _mcp_manager is not None:
            try:
                await _mcp_manager.connect_all()
                from mcp_integration.client.tool_adapter import attach_mcp_tools
                _mcp_added = attach_mcp_tools(tool_registry, _mcp_manager, tools_root)
                if _mcp_manager.connections or _mcp_manager.errors:
                    yield _sse_event("mcp_tools", {
                        "servers": sorted(_mcp_manager.connections.keys()),
                        "tools": _mcp_added,
                        "errors": _mcp_manager.errors,
                    })
            except Exception as _mcp_err:  # noqa: BLE001
                log.warning("MCP setup failed (non-fatal): %s", _mcp_err)

        # Thread id always comes first so the client can start using
        # it immediately, even on a brand new thread.
        yield _sse_event("thread_id", {"thread_id": resolved_thread_id})

        # Tell the client which directory server-side tools operate on —
        # without this, files scaffolded into the server's thread workspace
        # look like they vanished (the browser lists its own local folder).
        # source: "explicit" (param) | "saved" (thread history) | "server_default"
        yield _sse_event("workspace", {
            "path": tools_root,
            "source": workspace_source,
        })

        # Which model this run is on, so the picker shows what's actually
        # serving the request rather than what was asked for. `degraded` is
        # what makes a budget downgrade visible instead of mysterious.
        yield _sse_event("model", {
            "key": model_cfg.model_key if model_cfg else None,
            "name": model_cfg.display_name if model_cfg else getattr(llm, "deployment", "default"),
            "context_window": context_window,
            "degraded": _quota.degraded,
        })

        # Budget warnings ride early, before any tokens are spent, so a user
        # near their limit knows before the run rather than after it.
        if _quota.should_notify:
            yield _sse_event("quota_notice", _quota.to_event())

        # Save every uploaded file to the thread's input/ directory AND parse
        # it. The parsed contents ride in the first user message: if someone
        # attaches a document, the document IS the question, and making the
        # agent spend a step deciding whether to read it (then fail to parse
        # it) is how attachments used to get ignored.
        image_payloads = []
        agent_input = message
        # Server-side upload copies that may be deleted once this run ends —
        # only the ones the CLIENT also holds. See the cleanup in `finally`.
        transient_inputs = []
        if uploads_payload or _oversized:
            _client_paths = {}
            if client_input_paths:
                try:
                    _parsed_paths = json.loads(client_input_paths)
                    if isinstance(_parsed_paths, dict):
                        _client_paths = {str(k): str(v) for k, v in _parsed_paths.items()}
                except (ValueError, TypeError) as e:
                    log.warning(f"client_input_paths ignored (bad JSON): {e}")

            ingested = ingest_uploads(
                workspace.input_dir, uploads_payload, client_paths=_client_paths,
            )
            # Files refused before they were read (above) are reported through
            # the same channel as ones refused after — from the user's side
            # there is no difference, and either way they must be told.
            ingested.rejected[:0] = _oversized
            image_payloads = ingested.images
            agent_input += ingested.digest()
            transient_inputs = [
                s.saved_path for s in ingested.files if s.client_path
            ]
            yield _sse_event("inputs_saved", {
                "files": [s.to_event() for s in ingested.files],
                "rejected": ingested.rejected,
                "images": len(ingested.images),
            })

        # Record the user's message and build memory context.
        # For threads with many messages, the summarizer compresses
        # older messages into a 2-3 sentence summary via one LLM call.
        thread_memory.add_user_message(message)

        all_messages = thread_memory.get_messages()
        # Client-canonical thread memory (Claude Code parity): when the client
        # holds this thread's long-term memory and the SERVER store is empty
        # (fresh deployment / wiped DB), re-seed from the client copy so the
        # agent keeps its history. Never merged into a non-empty store — the
        # server copy stays authoritative within its own lifetime.
        if thread_memory_state and not thread_memory.long_term.load():
            try:
                _client_entries = json.loads(thread_memory_state)
                if isinstance(_client_entries, list) and _client_entries:
                    thread_memory.long_term.save_all(_client_entries[-50:])
                    log.info(f"Thread {resolved_thread_id}: re-seeded "
                             f"{len(_client_entries[-50:])} memory entries from client")
            except (ValueError, TypeError) as e:
                log.warning(f"thread_memory_state ignored (bad JSON): {e}")

        if len(all_messages) > 15:
            # Long thread: use LLM-based summarization for old messages
            memory_context = await _get_summarizer().build_memory_context(
                thread_id=resolved_thread_id,
                messages=all_messages,
                long_term_entries=thread_memory.long_term.load(),
                token_budget=_budget.memory_context,
            )
        else:
            # Short thread: use simple context (no summarization needed)
            memory_context = thread_memory.build_memory_context(
                token_budget=_budget.memory_context,
            )

        # Gather Context phase: auto-scan the workspace for project
        # understanding (language, framework, commands, structure).
        # Cached per workspace path — only scans once, then instant.
        project_ctx = scan_project(tools_root)
        project_context_text = project_ctx.as_prompt_context()
        if project_context_text:
            memory_context = (
                "## Project Context (auto-detected)\n"
                + project_context_text
                + "\n\n"
                + memory_context
            )

        # Inject the client-built repo map (Phase 6), when the client sent one
        # (first message of a thread). Gives the model the file tree + symbols
        # up front so it orients without many list_directory/read_file calls.
        if repo_map:
            _repo_map_cap = max(4000, _budget.memory_context * 4)
            memory_context = repo_map[:_repo_map_cap] + "\n\n" + memory_context

        # Runtime availability from the USER's machine — small and high-value,
        # so it rides in front: the model knows before planning whether the
        # project's runtimes (node/python/…) exist, and suggests setup instead
        # of running commands doomed to fail.
        if runtime_report:
            memory_context = runtime_report[:2000] + "\n\n" + memory_context

        # Client execution environment: when terminal/git commands are
        # delegated to the user's machine (Pattern C + daemon), the model
        # must compose them for THAT OS — the server's platform is
        # irrelevant. Ride near the top so planning sees it first.
        if client_os and "run_terminal" in _client_tool_names:
            _os_l = client_os.strip().lower()
            if _os_l in ("windows", "win32", "win"):
                _os_note = ("Windows — shell is cmd.exe: no POSIX flags "
                            "(`mkdir dir` not `mkdir -p`, no `rm`/`cp`/`ls`), "
                            "chain with `&&`, backslash or plain relative paths")
            elif _os_l in ("darwin", "macos", "mac"):
                _os_note = "macOS — shell is POSIX sh (zsh-compatible)"
            elif _os_l in ("linux", "posix", "freebsd"):
                _os_note = "Linux — shell is POSIX sh"
            else:
                _os_note = client_os.strip()[:40]
            memory_context = (
                "## Client Execution Environment\n"
                f"Terminal/git commands execute on the USER'S machine: "
                f"{_os_note}.\n\n"
                + memory_context
            )

        # Inject devaccel.md — persistent project memory the agent maintains
        # (stack, architecture, commands, decisions), equivalent to Claude
        # Code reading CLAUDE.md. The file lives in the USER's workspace:
        # client-side workspaces SEND it (project_memory form field) because
        # the server cannot read their disk — and the server must never fall
        # back to its own disk for them (a fallback workspace's devaccel.md
        # is shared across threads, so it would leak one user's memory into
        # another's context). Cap scales with the memory_context budget.
        _devaccel_cap_chars = max(2000, _budget.memory_context * 4 // 4)
        _project_memory = (project_memory or "")[:_devaccel_cap_chars]
        if not _project_memory and not _client_tool_names:
            import pathlib
            _devaccel_md = pathlib.Path(tools_root) / "devaccel.md"
            if _devaccel_md.exists():
                _project_memory = _devaccel_md.read_text(
                    encoding="utf-8", errors="replace"
                )[:_devaccel_cap_chars]
        if _project_memory:
            memory_context = (
                "## Project Memory (devaccel.md)\n"
                + _project_memory
                + "\n\n"
                + memory_context
            )

        # Custom agent persona rides FIRST: identity + system prompt + its
        # skills' SKILL.md content (the BMAD agent↔skill association).
        if _agent_context:
            memory_context = _agent_context + "\n\n" + memory_context
            yield _sse_event("custom_agent", {"name": agent_name})

        orchestrator = OrchestratorAgent(
            llm=llm,
            tool_registry=tool_registry,
            memory=thread_memory.long_term,
            token_tracker=token_tracker,
            context_window=context_window,
            thread_id=resolved_thread_id,
            max_run_tokens=_quota.per_run_limit,
            quota_probe=_make_quota_probe(user_id, _quota.level),
        )

        # Create per-request agent logger for structured event tracking
        al = AgentLogger(thread_id=resolved_thread_id)
        al.log_user_question(message, workspace_path=workspace_path)

        _stop_registry.start(resolved_thread_id)
        _signal_bus.mark_active(resolved_thread_id)

        import asyncio

        # ── Run lifetime (Claude Code approach) ───────────────────────────
        # Claude Code has NO wall-clock timeout on the agent loop — timeouts
        # belong to individual operations (each LLM call, each command), and
        # the loop is bounded by step/token budgets and the user's stop. A
        # fixed cap kills exactly the complex runs this product exists for
        # (a scaffold with installs legitimately takes 15-30 min on GPT-4.1).
        #
        # AGENT_STALL_TIMEOUT_SECONDS — halt only when NO event has flowed
        #   for this long: a genuinely dead run. Must exceed the LLM read
        #   timeout (300 s) and the permission-approval wait (300 s), so it
        #   never fires while an operation is still legitimately in flight.
        # AGENT_TIMEOUT_SECONDS — optional absolute cap, 0 = unlimited
        #   (default). Set it only where infrastructure demands a ceiling.
        AGENT_STALL_TIMEOUT = int(os.getenv("AGENT_STALL_TIMEOUT_SECONDS", "420"))
        AGENT_TIMEOUT = int(os.getenv("AGENT_TIMEOUT_SECONDS", "0"))
        HEARTBEAT_INTERVAL = 15  # seconds between keepalive pings

        queue: asyncio.Queue = asyncio.Queue()
        SENTINEL = object()

        async def on_event(event_type: str, data: dict):
            await queue.put((event_type, data))

        def should_stop() -> bool:
            # Local flag OR a stop requested via another worker (Redis flag).
            return (
                _stop_registry.should_stop(resolved_thread_id)
                or _signal_bus.stop_requested(resolved_thread_id)
            )

        async def run_spec_workflow():
            """Spec-driven mode — SpecWorkflow drives the SAME agent loop
            phase-by-phase with gates; result shape matches orchestrator.run()."""
            workflow = SpecWorkflow(
                thread_id=resolved_thread_id,
                workspace=tools_root,
                llm=llm,
                tool_registry=tool_registry,
                memory=thread_memory.long_term,
                token_tracker=token_tracker,
                context_window=context_window,
                base_permission_config=_perm_cfg,
                store=_spec_store,
                client_tools=_client_tool_names,
            )
            # A leading /specify, /plan, @architect, ... keyword can refine
            # the dropdown choice (e.g. jump straight to the design phase).
            resolved_mode, start_phase = resolve_start(message, spec_mode)
            if resolved_mode == "execution":
                feature = spec_feature
                if not feature:  # fall back to this thread's latest workflow
                    wf = _spec_store.get(resolved_thread_id)
                    if wf:
                        feature = f"{wf['feature_number']}-{wf['feature_slug']}"
                if not feature:
                    await on_event("error", {"message":
                        "Execution needs a feature: pass spec_feature="
                        "'<NNN-slug>' or run a generation phase first."})
                    return {"status": "failed", "route": "spec_execution",
                            "steps_taken": 0, "answer": "", "usage": {},
                            "run_state": None}
                return await workflow.run_execution(
                    memory_context=memory_context,
                    on_event=on_event,
                    should_stop=should_stop,
                    feature=feature,
                    user_request=message,
                )
            # Generation with a framework ALREADY installed usually means the
            # user wants to use it, not to have a near-duplicate built beside
            # it. Say what exists and how to reach it, then generate anyway —
            # they asked for generation, and quietly refusing to do it would
            # be worse than a redundant agent they can delete.
            _existing = [e for e in _catalog
                         if e.kind == "agent" and e.origin != "builtin"]
            if _existing and not start_phase:
                await on_event("spec_existing_agents", {
                    "agents": [e.to_dict() for e in _existing[:20]],
                    "message": (
                        f"This workspace already defines "
                        f"{len(_existing)} agent(s): "
                        + ", ".join(e.display for e in _existing[:5])
                        + ". Pick one from the agent menu (or just ask for it "
                          "by name) to use it instead. Generating anyway, as "
                          "requested."
                    ),
                })
            return await workflow.run_generation(
                agent_input,
                memory_context=memory_context,
                on_event=on_event,
                should_stop=should_stop,
                start_phase=start_phase,
                feature=spec_feature,
            )

        async def run_orchestrator():
            try:
                if spec_mode:
                    result = await run_spec_workflow()
                else:
                    result = await orchestrator.run(
                        agent_input,
                        memory_context=memory_context,
                        on_event=on_event,
                        should_stop=should_stop,
                        agent_logger=al,
                        images=image_payloads,
                    )
                await queue.put(("__result__", result))
            except asyncio.CancelledError:
                # Watchdog halt — the stream loop already told the client why.
                raise
            except Exception as e:
                al.log_error(
                    error_type=type(e).__name__,
                    error_message=str(e),
                    error_context="run_orchestrator",
                    traceback=traceback.format_exc() if 'traceback' in dir() else None,
                )
                await queue.put(("error", {"message": str(e)}))
            finally:
                await queue.put((SENTINEL, None))

        task = asyncio.create_task(run_orchestrator())

        final_result = None
        import time as _time
        run_started = _time.monotonic()
        last_activity = run_started
        # Watchdog two-phase halt state: set when a graceful stop has been
        # requested; hard-cancel fires only if this deadline passes first.
        WATCHDOG_GRACE = int(os.getenv("AGENT_WATCHDOG_GRACE_SECONDS", "60"))
        halt_deadline = None
        halt_msg = ""
        try:
            while True:
                try:
                    event_type, data = await asyncio.wait_for(
                        queue.get(), timeout=HEARTBEAT_INTERVAL
                    )
                except asyncio.TimeoutError:
                    # No event arrived — send an SSE comment to keep the connection alive.
                    # SSE comments (lines starting with ':') are ignored by clients
                    # but prevent proxies/load-balancers from closing idle connections.
                    yield ": heartbeat\n\n"

                    # Watchdog: halt on genuine stall (no events at all for
                    # AGENT_STALL_TIMEOUT) or the optional absolute cap. A run
                    # that is streaming tokens / tool output NEVER trips this,
                    # no matter how long it takes — Claude Code behaviour.
                    now = _time.monotonic()

                    # Phase 2 — grace expired without a cooperative stop: the
                    # loop never reached a step boundary, so it really is dead.
                    if halt_deadline is not None:
                        if task.done():
                            continue  # stopped gracefully; SENTINEL is coming
                        if now > halt_deadline:
                            al.log_error(
                                error_type="WatchdogHalt",
                                error_message=halt_msg,
                                error_context="agent_stream_watchdog",
                            )
                            task.cancel()
                            yield _sse_event("error", {"message": halt_msg})
                            break
                        continue

                    idle = now - last_activity
                    total = now - run_started
                    stalled = AGENT_STALL_TIMEOUT > 0 and idle > AGENT_STALL_TIMEOUT
                    over_cap = AGENT_TIMEOUT > 0 and total > AGENT_TIMEOUT
                    if stalled or over_cap:
                        # Phase 1 — Claude Code interrupt semantics: request a
                        # COOPERATIVE stop first. The agent loop polls
                        # should_stop() at every step boundary and returns
                        # status "stopped" WITH resume state, so the thread
                        # stays resumable. Hard cancel is only the backstop.
                        reason = (
                            f"no activity for {int(idle)}s — the run appears stuck"
                            if stalled else
                            f"absolute time cap of {AGENT_TIMEOUT}s reached"
                        )
                        halt_msg = (
                            f"Agent run halted: {reason}. Work already done "
                            f"(files, tasks) is preserved — send a follow-up "
                            f"message on this thread to continue where it left off."
                        )
                        log.warning(f"Watchdog ({reason}) — requesting graceful stop")
                        _stop_registry.request_stop(resolved_thread_id)
                        halt_deadline = now + WATCHDOG_GRACE
                        yield _sse_event("thinking", {
                            "thought": f"[Watchdog: {reason} — stopping gracefully; progress stays resumable]",
                        })
                    continue
                if event_type is SENTINEL:
                    break
                if event_type == "__result__":
                    final_result = data
                    continue
                last_activity = _time.monotonic()
                yield _sse_event(event_type, data)
        finally:
            # If the run was stopped and has partial state, save it
            # for a potential /resume call later
            if final_result and final_result.get("run_state"):
                _stop_registry.save_state(
                    resolved_thread_id, final_result["run_state"]
                )
            else:
                _stop_registry.finish(resolved_thread_id)
                # Finished on its own → nothing left to resume, so drop the
                # offloaded context. A stopped/failed run KEEPS its spill dir
                # (the branch above) so it can continue where it left off.
                _clear_spill(resolved_thread_id)
            _signal_bus.clear_active(resolved_thread_id)

            # Drop this user's cached usage. A short run can spend its whole
            # budget inside one cache window, and without this the NEXT run's
            # opening check would still see the pre-run total and wave it
            # through at the old level.
            try:
                from quota.service import note_spend

                note_spend(token_tracker.user_id)
            except Exception as e:  # noqa: BLE001
                log.debug(f"Usage cache not invalidated: {e}")

            # Unblock any client tool call or permission request still
            # awaiting an answer so nothing hangs after the stream closes.
            _client_broker.cancel_thread(resolved_thread_id)
            _permission_broker.cancel_thread(resolved_thread_id)

            # The server's copy of an attachment is TEMPORARY storage: it
            # exists so the extractor can read the bytes, and nothing more.
            # Deleted here — but ONLY for files the client also saved to the
            # user's own workspace. Without a client copy this is the only
            # copy, and "the file I uploaded earlier" has to keep working on
            # the next message of the thread.
            for _path in transient_inputs:
                try:
                    os.remove(_path)
                except OSError as e:  # noqa: PERF203 — per-file, best effort
                    log.debug(f"Could not remove temporary upload {_path}: {e}")
            if transient_inputs:
                log.info(
                    f"Removed {len(transient_inputs)} temporary server upload(s) "
                    f"for thread {resolved_thread_id} — the user's own copies remain"
                )

            # Close MCP sessions opened for this run (connect + close happen in
            # this same generator task, which the SDK's async transports require).
            if _mcp_manager is not None:
                await _mcp_manager.aclose()

            # Spec gate parked? Then the stream closing must NOT kill the
            # workflow — the gate card promises "your decision is still
            # delivered", and POST /gate_response works without a live
            # stream. Keep the task alive; the user's decision resumes it
            # in the background (files land in the workspace; the next
            # message on the thread shows the result). GATE_TIMEOUT still
            # bounds the wait, and the task's own completion path cleans up.
            if _gate_broker.has_pending(resolved_thread_id) and not task.done():
                log.info(f"Stream closed while thread {resolved_thread_id} is "
                         f"parked at a spec gate — workflow kept alive in "
                         f"background awaiting the gate decision")
            else:
                _gate_broker.cancel_thread(resolved_thread_id)
                if not task.done():
                    task.cancel()

        # Emit run summary, save to memory, and log completion
        if final_result is not None:
            thread_memory.add_assistant_message(final_result.get("answer", ""))

            # ── Claude Code approach: save a TEXT SUMMARY of what was done ──
            # Claude Code never replays raw tool-call messages across sessions.
            # Instead it re-reads the workspace (files are still on disk) and
            # loads a human-readable summary of prior sessions from memory.
            # devaccel.md covers project-level facts; this covers per-session
            # "what happened last time" so the agent can continue smoothly.
            if final_result.get("status") in ("done", "stopped"):
                import datetime
                answer_preview = (final_result.get("answer") or "")[:300]
                steps = final_result.get("steps_taken", 0)
                session_summary = (
                    f"[Session {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}] "
                    f"User asked: \"{message[:120]}\". "
                    f"Agent completed in {steps} step(s). "
                    f"Result summary: {answer_preview}"
                )
                thread_memory.long_term.add(session_summary, tags=["session_summary"])

            usage = final_result.get("usage", {})
            al.log_agent_complete(
                status=final_result.get("status", "unknown"),
                route=final_result.get("route", "unknown"),
                steps_taken=final_result.get("steps_taken", 0),
                final_answer_length=len(final_result.get("answer", "")),
                total_prompt_tokens=usage.get("prompt_tokens", 0),
                total_completion_tokens=usage.get("completion_tokens", 0),
                total_tokens=usage.get("total_tokens", 0),
            )

            yield _sse_event("run_summary", {
                "status": final_result.get("status"),
                "route": final_result.get("route"),
                "steps_taken": final_result.get("steps_taken"),
                "usage": final_result.get("usage"),
                "resumable": final_result.get("run_state") is not None,
            })

            # Mirror this thread's long-term memory to the CLIENT
            # (~/.devaccel/projects/<root>/memory/<thread>.json) — Claude Code
            # parity: the user's machine holds the canonical copy, so history
            # survives a server DB wipe (re-imported via thread_memory_state).
            # Last 50 entries ≈ months of session summaries, well under the
            # daemon's state-file cap.
            try:
                yield _sse_event("memory_snapshot", {
                    "thread_id": resolved_thread_id,
                    "entries": thread_memory.long_term.load()[-50:],
                })
            except Exception:
                pass  # mirroring is best-effort; never break the stream

        yield _sse_event("done", {})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


# ── POST /api/agent/stop ─────────────────────────────────────────

@agent_router.post("/stop")
async def agent_stop(stop_request: StopRequest, user_id: str = Depends(get_current_user)):
    """
    Flags the active run for thread_id to stop at its next clean
    boundary (between agent steps, never mid-tool-call). Returns
    404 if there was no active run to stop.

    After stopping, the run's partial state is saved automatically.
    Use POST /api/agent/resume to continue from where it left off,
    or POST /api/agent/stream with the same thread_id to start fresh.
    """
    _require_thread_access(stop_request.thread_id, user_id)
    stopped = _stop_registry.request_stop(stop_request.thread_id)
    if not stopped:
        # The run may live on ANOTHER worker — set the shared stop flag
        # (Redis) that its should_stop() polls between steps.
        stopped = _signal_bus.request_stop(stop_request.thread_id)
    if not stopped:
        raise HTTPException(
            status_code=404,
            detail=f"No active run found for thread_id '{stop_request.thread_id}'.",
        )
    return {
        "thread_id": stop_request.thread_id,
        "stopping": True,
        "message": "Run will stop at the next clean boundary. "
                   "Use POST /api/agent/resume to continue later.",
    }


# ── POST /api/agent/tool_result ──────────────────────────────────

@agent_router.post("/tool_result")
async def agent_tool_result(req: ToolResultRequest, user_id: str = Depends(get_current_user)):
    """
    Pattern C — deliver the result of a client-executed tool back to the
    paused agent loop.

    When the server delegates a tool (via a `client_tool_use` SSE event), the
    agent turn parks until the client runs the tool locally and POSTs the result
    here. This resolves the pending call so the loop resumes with the output.

    Returns 404 if the call id is unknown — it already timed out, the run ended,
    or the result was already delivered.
    """
    _require_thread_access(req.thread_id, user_id)
    delivered = _client_broker.resolve(req.thread_id, req.id, req.output)
    if not delivered and _signal_bus.enabled and _signal_bus.is_active_anywhere(req.thread_id):
        # The stream (and its pending future) lives on another worker —
        # broadcast the result; the worker holding it resolves locally.
        receivers = await _signal_bus.publish(
            "tool_result", req.thread_id, {"id": req.id, "output": req.output}
        )
        delivered = receivers > 0
    if not delivered:
        raise HTTPException(
            status_code=404,
            detail=f"No pending client tool call '{req.id}' for thread "
                   f"'{req.thread_id}' (it may have timed out or already completed).",
        )
    return {"ok": True, "id": req.id}


# ── POST /api/agent/permission_response ──────────────────────────

@agent_router.post("/permission_response")
async def agent_permission_response(
    req: PermissionResponseRequest, user_id: str = Depends(get_current_user)
):
    """
    Ask mode — deliver the user's approve/reject decision for a tool that is
    waiting on a `permission_request` event.

    decision: 'allow' (run once) · 'allow_session' (don't ask again this thread)
    · 'deny' (skip the tool). Returns 404 if the request id is unknown (it timed
    out, the run ended, or it was already answered).
    """
    if req.decision not in ("allow", "allow_session", "deny"):
        raise HTTPException(
            status_code=422,
            detail="decision must be 'allow', 'allow_session', or 'deny'.",
        )
    _require_thread_access(req.thread_id, user_id)
    delivered = _permission_broker.resolve(req.thread_id, req.id, req.decision)
    if not delivered and _signal_bus.enabled and _signal_bus.is_active_anywhere(req.thread_id):
        receivers = await _signal_bus.publish(
            "permission", req.thread_id, {"id": req.id, "decision": req.decision}
        )
        delivered = receivers > 0
    if not delivered:
        raise HTTPException(
            status_code=404,
            detail=f"No pending permission request '{req.id}' for thread "
                   f"'{req.thread_id}' (it may have timed out or already been answered).",
        )
    return {"ok": True, "id": req.id, "decision": req.decision}


# ── POST /api/agent/gate_response ────────────────────────────────

@agent_router.post("/gate_response")
async def agent_gate_response(
    req: GateResponseRequest, user_id: str = Depends(get_current_user)
):
    """
    Spec-driven development — deliver the user's decision for a phase gate
    (the workflow is parked on a `gate_request` SSE event).

    decision: 'approve' (advance to the next phase) · 'revise' (re-run the
    same phase with `feedback`) · 'abort' (stop the workflow; files stay on
    disk). Returns 404 if the gate is unknown (timed out, workflow ended,
    or already answered).
    """
    if req.decision not in ("approve", "revise", "abort"):
        raise HTTPException(
            status_code=422,
            detail="decision must be 'approve', 'revise', or 'abort'.",
        )
    if req.decision == "revise" and not (req.feedback or "").strip():
        raise HTTPException(
            status_code=422,
            detail="'revise' requires non-empty feedback describing what to change.",
        )
    _require_thread_access(req.thread_id, user_id)
    delivered = _gate_broker.resolve(req.thread_id, req.gate, req.decision, req.feedback)
    if not delivered and _signal_bus.enabled and _signal_bus.is_active_anywhere(req.thread_id):
        # The workflow lives on another worker — relay over the bus.
        receivers = await _signal_bus.publish(
            "gate", req.thread_id,
            {"gate": req.gate, "decision": req.decision, "feedback": req.feedback},
        )
        delivered = receivers > 0
    if not delivered:
        raise HTTPException(
            status_code=404,
            detail=f"No pending gate '{req.gate}' for thread '{req.thread_id}' "
                   f"(it may have timed out or already been answered).",
        )
    return {"ok": True, "gate": req.gate, "decision": req.decision}


# ── GET /api/agent/spec/{thread_id}/status ───────────────────────

@agent_router.get("/spec/{thread_id}/status")
async def spec_status(thread_id: str, user_id: str = Depends(get_current_user)):
    """
    Progress of the thread's latest spec workflow — feature, current phase,
    status (running | awaiting_gate | paused | completed | aborted | failed)
    and every recorded gate decision. Drives the UI's progress bar and the
    'Resume spec' affordance.
    """
    _require_thread_access(thread_id, user_id)
    workflow = _spec_store.get(thread_id)
    if workflow is None:
        raise HTTPException(status_code=404, detail="No spec workflow for this thread.")
    return {"thread_id": thread_id, **workflow}


# ── GET /api/agent/spec/{thread_id}/agents ───────────────────────

@agent_router.get("/spec/{thread_id}/agents")
async def spec_agents(thread_id: str, user_id: str = Depends(get_current_user)):
    """
    The custom agent roster generated by the agents phase, parsed from the
    feature's .devaccel/agents/<NNN-slug>/agents.md into JSON for the UI's
    agent picker. Resolution order: the thread's latest workflow's feature
    → newest numbered folder on disk → legacy project-level agents.md.

    404 when no agents.md exists yet OR the workspace lives on the
    client machine (Pattern C) — in that case the CLIENT should read and
    parse its local agents.md itself (same frontmatter format).
    """
    _require_thread_access(thread_id, user_id)
    workspace = _conversation_history.get_workspace_path(thread_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Thread has no workspace path.")

    agents_root = Path(workspace) / ".devaccel" / "agents"
    candidates = []
    wf = _spec_store.get(thread_id)
    if wf:
        candidates.append(
            agents_root / f"{wf['feature_number']}-{wf['feature_slug']}" / "agents.md"
        )
    try:
        # Newest NNN-* feature folder — covers workflows the store missed
        # (e.g. migration 003 not applied).
        numbered = sorted(
            d for d in agents_root.iterdir()
            if d.is_dir() and d.name[:3].isdigit() and d.name[3:4] == "-"
        )
        if numbered:
            candidates.append(numbered[-1] / "agents.md")
    except OSError:
        pass
    candidates.append(agents_root / "agents.md")  # legacy project-level layout

    agents_file = next((p for p in candidates if p.is_file()), None)
    if agents_file is None:
        raise HTTPException(
            status_code=404,
            detail="agents.md not found server-side. Run the generation phase "
                   "first, or parse the client-local copy in the UI.",
        )
    content = agents_file.read_text(encoding="utf-8", errors="replace")
    return {"thread_id": thread_id, "agents": parse_agents(content)}


# ── GET /api/agent/custom-agents/{thread_id} ─────────────────────

@agent_router.get("/custom-agents/{thread_id}")
async def custom_agents(thread_id: str, user_id: str = Depends(get_current_user)):
    """
    File-convention agent discovery (BMAD / Claude Code model) for the UI's
    agent dropdown. Scans the thread's workspace for:

        .devaccel/agents/<name>.md · .claude/agents/<name>.md ·
        _bmad|bmad/<module>/agents/<name>.md · legacy agents.md rosters ·
        .devaccel/skills/<name>/SKILL.md · .claude/skills/<name>/SKILL.md

    Generated (agent-builder) and hand-copied BMAD files are treated
    identically — anything following the convention appears here.

    `server_visible: false` means the workspace lives on the CLIENT machine
    (Pattern C) — the client should scan the same conventions locally and
    send the selected agent's content as agent_file/skill_files.
    """
    _require_thread_access(thread_id, user_id)
    workspace = _conversation_history.get_workspace_path(thread_id)
    if not workspace or not Path(workspace).is_dir():
        return {"thread_id": thread_id, "agents": [], "skills": [],
                "server_visible": False}
    scan = scan_custom_agents(workspace)
    return {"thread_id": thread_id, **scan, "server_visible": True}


# ── POST /api/agent/resume ───────────────────────────────────────

@agent_router.post("/resume")
async def agent_resume(resume_request: ResumeRequest, user_id: str = Depends(get_current_user)):
    """
    Resume a previously stopped run from where it left off.

    For simple_task: re-runs the same input (agent has long-term
    memory of what it already did).
    For complex_task: skips already-completed plan steps and
    continues from the next one, reusing the existing plan.

    Returns 404 if there's no saved state to resume (either the run
    finished normally, was never stopped, or was already resumed).
    """
    thread_id = resume_request.thread_id
    _require_thread_access(thread_id, user_id)

    # Check if there's something to resume before consuming the state
    saved_state = _stop_registry.get_saved_state(thread_id)
    if saved_state is None:
        raise HTTPException(
            status_code=404,
            detail=f"No resumable run found for thread_id '{thread_id}'. "
                   f"Either the run finished normally, was never stopped, "
                   f"or was already resumed.",
        )

    # Consume the state (so it can't be resumed twice)
    saved_state = _stop_registry.consume_saved_state(thread_id)

    workspace = ThreadWorkspace.for_thread(thread_id)
    # A resume continues the same work, so it resolves the model the same way a
    # fresh run would. It deliberately re-resolves rather than replaying what
    # the stopped run used: if an admin has since changed the user's entitlement
    # or a quota has kicked in, the resumed half must respect that too.
    llm, context_window, model_cfg = resolve_run_model(user_id, resume_request.model)
    token_tracker = _token_store.get(
        thread_id, user_id=user_id, run_id=_new_thread_id(), model_config=model_cfg
    )

    thread_memory = _build_postgres_thread_memory(thread_id)

    # Load the saved workspace path for this thread (same logic as /stream)
    import pathlib as _pathlib
    _saved_ws = _conversation_history.get_workspace_path(thread_id)
    if _saved_ws and _pathlib.Path(_saved_ws).is_dir():
        resume_tools_root = str(_pathlib.Path(_saved_ws).resolve())
    else:
        resume_tools_root = workspace.project_root

    # Apply permissions for this resume (same logic as /stream)
    _resume_mode = _normalize_permission_mode(resume_request.permission_mode)
    _resume_perm_cfg = PermissionConfig(
        mode=_resume_mode,
        allow_tools=set(_parse_csv(resume_request.allow_tools)),
        deny_tools=set(_parse_csv(resume_request.deny_tools)),
        allow_paths=_parse_csv(resume_request.allow_paths),
        deny_paths=_parse_csv(resume_request.deny_paths),
    )
    # Bound inside event_generator (per-request ContextVar) — see /stream.
    log.info(f"Permissions (resume): mode={_resume_mode} workspace={resume_tools_root}")

    tool_registry = ToolRegistry.build_for_workspace(
        resume_tools_root,
        long_term_memory=thread_memory.long_term,
        output_dir=resume_tools_root,
        llm=llm,
        thread_id=thread_id,
        token_tracker=token_tracker,
        context_window=context_window,
    )

    async def event_generator():
        set_permission_config(resume_tools_root, _resume_perm_cfg)

        yield _sse_event("thread_id", {"thread_id": thread_id})
        yield _sse_event("resuming", {
            "route": saved_state.route,
            "completed_steps": [s["id"] for s in saved_state.completed_steps],
            "message": f"Resuming {saved_state.route} run from where it was stopped",
        })

        orchestrator = OrchestratorAgent(
            llm=llm,
            tool_registry=tool_registry,
            memory=thread_memory.long_term,
            token_tracker=token_tracker,
            # Was omitted here, so a resumed run silently fell back to
            # OrchestratorAgent's 8192 default and budgeted its context as if
            # it were on a tiny model — compacting away history the original
            # run had room for. Resume must size itself like /stream does.
            context_window=context_window,
            thread_id=thread_id,
        )

        _stop_registry.start(thread_id)
        _signal_bus.mark_active(thread_id)

        import asyncio

        queue: asyncio.Queue = asyncio.Queue()
        SENTINEL = object()

        async def on_event(event_type: str, data: dict):
            await queue.put((event_type, data))

        def should_stop() -> bool:
            return (
                _stop_registry.should_stop(thread_id)
                or _signal_bus.stop_requested(thread_id)
            )

        async def run_resume():
            try:
                result = await orchestrator.resume(
                    saved_state,
                    on_event=on_event,
                    should_stop=should_stop,
                )
                await queue.put(("__result__", result))
            except Exception as e:
                await queue.put(("error", {"message": str(e)}))
            finally:
                await queue.put((SENTINEL, None))

        task = asyncio.create_task(run_resume())

        final_result = None
        try:
            while True:
                event_type, data = await queue.get()
                if event_type is SENTINEL:
                    break
                if event_type == "__result__":
                    final_result = data
                    continue
                yield _sse_event(event_type, data)
        finally:
            # If stopped AGAIN during resume, save the updated state
            if final_result and final_result.get("run_state"):
                _stop_registry.save_state(thread_id, final_result["run_state"])
            else:
                _stop_registry.finish(thread_id)
                _clear_spill(thread_id)
            _signal_bus.clear_active(thread_id)

            _client_broker.cancel_thread(thread_id)
            _permission_broker.cancel_thread(thread_id)

            if not task.done():
                task.cancel()

        if final_result is not None:
            thread_memory.add_assistant_message(final_result.get("answer", ""))
            yield _sse_event("run_summary", {
                "status": final_result.get("status"),
                "route": final_result.get("route"),
                "steps_taken": final_result.get("steps_taken"),
                "usage": final_result.get("usage"),
                "resumed": True,
                "resumable": final_result.get("run_state") is not None,
            })

        yield _sse_event("done", {})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


# ── GET /api/agent/status/{thread_id} ────────────────────────────

@agent_router.get("/status/{thread_id}")
async def agent_status(thread_id: str, user_id: str = Depends(get_current_user)):
    """
    Check the current status of a thread: is it running, resumable,
    or idle? Useful for the UI to decide whether to show a "Resume"
    button vs a "New message" input.
    """
    _require_thread_access(thread_id, user_id)
    is_running = (
        _stop_registry.is_active(thread_id)
        or _signal_bus.is_active_anywhere(thread_id)
    )
    is_resumable = _stop_registry.has_resumable_state(thread_id)

    status = "running" if is_running else ("resumable" if is_resumable else "idle")

    result = {
        "thread_id": thread_id,
        "status": status,
        "is_running": is_running,
        "is_resumable": is_resumable,
    }

    # Include resume details if there's saved state
    if is_resumable:
        saved = _stop_registry.get_saved_state(thread_id)
        if saved:
            result["resume_info"] = {
                "route": saved.route,
                "completed_steps": len(saved.completed_steps),
                "total_steps": len(saved.plan.get("steps", [])) if saved.plan else 0,
            }

    return result


# ── GET /api/agent/models ────────────────────────────────────────

@agent_router.get("/models")
async def agent_models(user_id: str = Depends(get_current_user)):
    """The models THIS caller may run on, and which one they get by default.

    Drives the model picker. Deliberately returns only what the caller is
    entitled to: a picker that lists models the server would refuse is a
    picker that lies.

    An empty `models` list means no catalogue is configured and every run uses
    the deployment from `.env` — the picker hides itself rather than offering a
    choice that doesn't exist.
    """
    try:
        from llm.model_registry import allowed_for_user, default_for_user, resolve_subject

        subject = resolve_subject(user_id)
        allowed = allowed_for_user(user_id, subject=subject)
        default = default_for_user(user_id, subject=subject)
    except Exception as e:  # noqa: BLE001
        log.warning(f"Could not list models for user {user_id}: {e}")
        return {"models": [], "default_key": None, "source": "env"}

    return {
        "models": [c.to_dict() for c in allowed],
        "default_key": default.model_key if default else None,
        "source": "database" if allowed else "env",
    }


# ── GET /api/agent/usage ─────────────────────────────────────────

@agent_router.get("/usage/{thread_id}")
async def agent_usage_for_thread(thread_id: str, user_id: str = Depends(get_current_user)):
    """Token usage totals for one thread only."""
    _require_thread_access(thread_id, user_id)
    return _token_store.get_thread_total(thread_id)


@agent_router.get("/usage")
async def agent_usage_global(user_id: str = Depends(get_current_user)):
    """Token usage totals across every thread this process has handled."""
    return {
        "total": _token_store.get_global_total(),
        "history": _token_store.get_global_history(),
    }


@agent_router.get("/usage/me/summary")
async def agent_usage_me(days: int = 30, user_id: str = Depends(get_current_user)):
    """This caller's own spend, and where it sits against their budget.

    Routed under `/usage/me/...` rather than `/usage/me` because
    `/usage/{thread_id}` above would otherwise swallow it — 'me' is a valid
    thread id as far as that route is concerned.
    """
    from quota.service import status_for_user
    from token_tracking.usage_queries import daily_series, usage_by_model

    numeric_id = None
    try:
        numeric_id = int(user_id)
    except (TypeError, ValueError):
        pass

    return {
        "quota": status_for_user(user_id),
        "by_model": usage_by_model(numeric_id, "month") if numeric_id else [],
        "daily": daily_series(numeric_id, days) if numeric_id else [],
    }


# ── GET /api/agent/history ───────────────────────────────────────

@agent_router.get("/history/{thread_id}")
async def agent_history(thread_id: str, user_id: str = Depends(get_current_user)):
    """Full chat history for one thread, oldest first."""
    _require_thread_access(thread_id, user_id)
    thread_memory = _build_postgres_thread_memory(thread_id)
    messages = thread_memory.get_messages()
    if not messages:
        raise HTTPException(status_code=404, detail="Thread not found or empty")
    return {"thread_id": thread_id, "messages": messages}


# ── GET /api/agent/workspace ─────────────────────────────────────

@agent_router.get("/workspace/{thread_id}")
async def agent_workspace_paths(thread_id: str, user_id: str = Depends(get_current_user)):
    """
    Resolves (and creates if missing) the input/workspace/output
    folders for thread_id. Useful for debugging or a UI that wants
    to show "where are my files".
    """
    _require_thread_access(thread_id, user_id)
    workspace = ThreadWorkspace.for_thread(thread_id)
    return workspace.to_dict()
