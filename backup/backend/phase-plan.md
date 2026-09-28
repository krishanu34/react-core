# Workspace Buddy — Phased Implementation Plan

> Each phase delivers a **demoable, deployable product**. You can stop after any phase and have a working app.

---

## Phase 1 — MVP: Chat That Works

**Goal**: User types a message → LLM responds via streaming → appears in the chat UI. Proves end-to-end plumbing.

### Delivers
- Single LLM provider (OpenAI) via `httpx`
- SSE streaming from backend → frontend
- `POST /api/agent/run` returns `text_delta` + `done` events
- `processMessage()` in `chat.js` consumes SSE stream
- Markdown rendering with `marked.js` + `DOMPurify` + `highlight.js`
- Conversation history in-memory (multi-turn chat works within a session)
- Token usage tracking (existing `/api/tokens/track` integration)
- Settings page already works (user configures API key, model)

### Files Created/Modified
| File | Action |
|---|---|
| `agent/__init__.py` | Create |
| `agent/models.py` | Create (AgentRequest, AgentEvent, LLMMessage, Conversation, TokenUsage) |
| `agent/llm/__init__.py` | Create (factory) |
| `agent/llm/base.py` | Create (abstract class) |
| `agent/llm/openai.py` | Create (streaming chat completion) |
| `agent/prompts.py` | Create (system prompt) |
| `agent/router.py` | Create (POST /run endpoint only) |
| `backend/main.py` | Modify (mount agent router) |
| `backend/requirements.txt` | Modify (add httpx, tiktoken) |
| `ui/public/index.html` | Modify (add CDN scripts) |
| `ui/public/js/chat.js` | Modify (SSE consumer + markdown rendering) |
| `ui/public/css/style.css` | Modify (message bubble styles) |

### Demo
> "I type 'What is a closure in JavaScript?' and get a streamed, markdown-rendered response with syntax-highlighted code blocks. Multi-turn chat works — I can ask follow-ups."

---

## Phase 2 — Agent with Core Tools

**Goal**: The agent can read, write, and search the workspace. It uses a tool loop — not just a single LLM call.

### Delivers
- ReAct agent loop (`loop.py`) with tool execution
- Tool registry with schema generation
- 7 core tools: `read_file`, `file_write`, `code_edit`, `grep_search`, `file_search`, `list_directory`, `run_terminal`
- `tool_start` / `tool_result` / `tool_error` SSE events streamed to UI
- Narrative UI rendering (spinner → checkmark for tool calls, collapsible results)
- `thinking` events displayed
- Stop button (`POST /api/agent/stop`)
- Max iteration cap (25)
- Token telemetry SSE events (`token_usage`)
- WebSocket file-change broadcasts when agent edits files

### Files Created/Modified
| File | Action |
|---|---|
| `agent/loop.py` | Create |
| `agent/context.py` | Create (basic — prompt assembly, no summarization yet) |
| `agent/tools/__init__.py` | Create |
| `agent/tools/registry.py` | Create |
| `agent/tools/file_read.py` | Create |
| `agent/tools/file_write.py` | Create |
| `agent/tools/code_edit.py` | Create |
| `agent/tools/grep_search.py` | Create |
| `agent/tools/file_search.py` | Create |
| `agent/tools/list_directory.py` | Create |
| `agent/tools/run_terminal.py` | Create |
| `agent/router.py` | Modify (add /stop endpoint) |
| `ui/public/js/chat.js` | Modify (tool event rendering, stop button) |
| `ui/public/css/style.css` | Modify (tool block styles, spinner) |

### Demo
> "I type 'Add input validation to the login form' and watch the agent read the file, reason about what to add, edit the code, then verify its change — all streamed step-by-step in the chat."

---

## Phase 3 — Smart Agent (Classify, Plan, Elaborate)

**Goal**: The agent is intelligent about routing — simple questions skip the tool loop, complex tasks get planned first.

### Delivers
- Request classifier (simple / contextual / complex)
- Query elaborator for vague requests
- Task planner with numbered steps
- Plan displayed in UI with checkboxes (user can skip steps)
- `classification`, `elaboration`, `plan` SSE events
- `workspace_info` tool
- `regex_search` tool (advanced + fuzzy)
- `batch_file_read` tool
- Editor context sent with each request (`EditorContext` model)
- Token cost savings: simple questions use ~150 tokens instead of ~5000

### Files Created/Modified
| File | Action |
|---|---|
| `agent/classifier.py` | Create |
| `agent/elaborator.py` | Create |
| `agent/planner.py` | Create |
| `agent/tools/workspace_info.py` | Create |
| `agent/tools/regex_search.py` | Create |
| `agent/tools/batch_file_read.py` | Create |
| `agent/models.py` | Modify (add EditorContext) |
| `agent/loop.py` | Modify (integrate classifier/elaborator/planner) |
| `agent/router.py` | Modify (pass editor_context) |
| `ui/public/js/chat.js` | Modify (send editor context, render plan/classification/elaboration) |

### Demo
> "I ask 'What does useEffect do?' — instant response, no tools. Then I ask 'Refactor db.js to use async/await' — the agent shows its plan (5 steps with checkboxes), elaborates the request, then executes step by step."

---

## Phase 4 — Persistence & Session Recovery

**Goal**: Sessions survive server restarts. User sees a sidebar of past conversations and can resume any of them.

### Delivers
- SQLite persistence for all session data (see `db-design.md`)
- 7 new tables: `sessions`, `messages`, `tool_calls`, `plan_steps`, `file_changes`, `scratchpad_entries`, `thinking_blocks`
- `SessionStore` class (`agent/db.py`)
- Session list endpoint (`GET /api/agent/sessions`)
- Session detail/recovery endpoint (`GET /api/agent/sessions/{id}`)
- Session delete + rename endpoints
- Session sidebar in UI (list, click to recover, delete, rename)
- File change tracking (every edit recorded with old/new content)
- Undo/revert endpoint (`POST /api/agent/undo`)
- "Revert all changes" button in UI
- Changed files list in `done` event (clickable file names)
- Auto-title sessions from first user message

### Files Created/Modified
| File | Action |
|---|---|
| `agent/db.py` | Create |
| `backend/main.py` | Modify (add CREATE TABLE statements to init_db) |
| `agent/router.py` | Modify (add session endpoints, undo endpoint) |
| `agent/loop.py` | Modify (persist messages/tool_calls/thinking at each step) |
| `agent/tools/file_write.py` | Modify (record FileChange) |
| `agent/tools/code_edit.py` | Modify (record FileChange) |
| `agent/models.py` | Modify (add title, status, classification to Conversation) |
| `ui/public/js/chat.js` | Modify (session sidebar, recovery, undo button, changed files) |
| `ui/public/css/style.css` | Modify (sidebar styles, undo button, changed files list) |

### Demo
> "I have a conversation where the agent edits 3 files. I restart the server. I reload the page — the sidebar shows my session. I click it and the full conversation replays (messages, tool calls, plan). I click 'Revert all changes' and the files go back to their original state."

---

## Phase 5 — Advanced Agent Features

**Goal**: Sub-agents, context summarization, remaining tools, ask-user interaction, scratchpad memory.

### Delivers
- Sub-agent spawning (`spawn_sub_agent` tool)
- `sub_agent_start` / `sub_agent_done` SSE events
- Context summarization when history grows too large
- `context_summary` SSE event
- `ask_user` tool (pause agent, show question in UI, resume on response)
- `POST /api/agent/respond` endpoint
- `batch_code_edit` tool (atomic multi-file edits)
- `git_operations` tool (status, diff, log, blame, branch)
- `web_fetch` tool (with SSRF prevention)
- `generate_diff` tool (preview changes)
- `scratchpad` tool (short-term memory)
- Scratchpad persisted to DB

### Files Created/Modified
| File | Action |
|---|---|
| `agent/sub_agents.py` | Create |
| `agent/summarizer.py` | Create |
| `agent/tools/ask_user.py` | Create |
| `agent/tools/batch_code_edit.py` | Create |
| `agent/tools/git_operations.py` | Create |
| `agent/tools/web_fetch.py` | Create |
| `agent/tools/generate_diff.py` | Create |
| `agent/tools/scratchpad.py` | Create |
| `agent/context.py` | Modify (add summarization logic) |
| `agent/loop.py` | Modify (sub-agent support, ask_user suspend/resume) |
| `agent/router.py` | Modify (add /respond endpoint) |
| `agent/db.py` | Modify (persist scratchpad) |
| `ui/public/js/chat.js` | Modify (user_question UI, sub-agent rendering) |

### Demo
> "I ask 'Migrate all API calls from axios to fetch'. The agent spawns a sub-agent to find all usages, gets a summary back, then edits each file. Mid-way, it asks me 'Should I also update the error handling pattern?' with Yes/No buttons. I click Yes. It continues and finishes the migration."

---

## Phase 6 — Multi-Provider & Polish

**Goal**: Full LLM provider support, edge case handling, production hardening.

### Delivers
- Anthropic Claude client (`agent/llm/anthropic.py`)
- Google Gemini client (`agent/llm/google.py`)
- Provider switching works seamlessly via settings
- Plan mode (generate plan without executing)
- Token quota exhaustion: graceful mid-run stop with partial summary
- Retry with backoff on transient LLM errors
- Terminal command denylist enforcement
- Full token telemetry UI (live counter bar, quota remaining)
- Error/cancelled events show partial progress + consumed tokens
- Session auto-title refinement
- Edge cases: binary file detection, very large files, concurrent stop requests

### Files Created/Modified
| File | Action |
|---|---|
| `agent/llm/anthropic.py` | Create |
| `agent/llm/google.py` | Create |
| `agent/llm/__init__.py` | Modify (add anthropic/google to factory) |
| `agent/loop.py` | Modify (plan mode, quota enforcement, retry logic) |
| `agent/tools/run_terminal.py` | Modify (denylist) |
| `ui/public/js/chat.js` | Modify (token bar, plan mode, error states) |
| `ui/public/css/style.css` | Modify (token bar, error banners) |

### Demo
> "I switch to Claude in settings. I ask for a plan-only review of my codebase (Plan mode). The agent produces a structured plan without executing. I switch to Agent mode and run it. The token counter shows live usage. Near the quota limit, it gracefully stops and reports what it accomplished."

---

## Summary

| Phase | Name | Key Deliverable | Cumulative Tools |
|---|---|---|---|
| 1 | MVP: Chat That Works | Streaming LLM chat with markdown | 0 |
| 2 | Agent with Core Tools | ReAct loop + workspace read/write | 7 |
| 3 | Smart Agent | Classification + planning + editor context | 10 |
| 4 | Persistence & Recovery | SQLite sessions + undo + sidebar | 10 |
| 5 | Advanced Features | Sub-agents + ask_user + all tools | 16 + spawn |
| 6 | Multi-Provider & Polish | Anthropic + Google + plan mode + hardening | 16 + spawn |

### Estimated Effort (rough)

| Phase | Files | Complexity |
|---|---|---|
| 1 | 12 | Low — plumbing + streaming |
| 2 | 14 | Medium — agent loop is the hard part |
| 3 | 10 | Medium — 3 LLM calls before loop |
| 4 | 9 | Medium — SQL + UI sidebar |
| 5 | 13 | High — sub-agents + async ask_user |
| 6 | 7 | Medium — adapters + error handling |

---

## Dependencies Between Phases

```
Phase 1 ──→ Phase 2 ──→ Phase 3
                │              │
                ▼              ▼
           Phase 4 ──────→ Phase 5 ──→ Phase 6
```

- Phases 1→2→3 are sequential (each builds on the previous)
- Phase 4 can start after Phase 2 (needs tool calls to persist)
- Phase 5 requires both Phase 3 (classifier) and Phase 4 (DB for scratchpad)
- Phase 6 can start after Phase 3 (plan mode) but benefits from Phase 5 (full feature set)
