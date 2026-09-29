# react-core

Standalone, server-side ReAct agent. No dependency on the legacy `backend/` or
`daemon/` folders — every tool executes in this process, on the machine that
runs the API. Output streams to the user over SSE.

## Layout

```
react-core/
  run.py                       # dev entrypoint (uvicorn)
  requirements.txt
  .env
  react_core/
    app/                       # FastAPI app + SSE endpoint + config
    agent/                     # ReAct loop, prompts, event helpers
    llm/                       # Azure OpenAI / OpenAI clients + JSON extraction
    memory/                    # per-thread conversation history
    permissions/               # workspace path sandbox + scan policy
    tools/                     # every tool the agent can call
    utils/                     # logging
  tests/
```

## Quickstart

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# edit .env with your provider and Langfuse credentials
python run.py
```

Then POST to `http://127.0.0.1:8080/api/agent/stream` (multipart form) with:

- `message` — the user instruction
- `workspace_path` — absolute path the tools operate on (required on the first
  turn of a thread; remembered afterwards)
- `thread_id` — optional; omit to start a new conversation

The response is a `text/event-stream` (SSE) with events:

| Event | Payload |
|---|---|
| `thread_id` | `{ thread_id }` |
| `thinking` | `{ step }` |
| `tool_start` | `{ tool, input }` |
| `terminal_output` | `{ run_id, stream, line }` (live shell output) |
| `tool_result` | `{ tool, result }` |
| `final` | `{ answer }` |
| `error` | `{ error }` |
| `done` | `{}` |

Cancel an in-flight run: `POST /api/agent/stop` with `{ "thread_id": "..." }`.

## Tools

Every tool runs server-side, sandboxed to `workspace_path`:

| Name | Purpose |
|---|---|
| `read_file` | Read a text file with line numbers, offset/limit windowing |
| `write_file` | Create or overwrite a text file (parent dirs created) |
| `code_edit` | Exact-string replacement in a file (old must match once) |
| `batch_read_files` | Read several files in one call |
| `grep_search` | Regex/text search (pure-Python, cross-platform, no external binary) |
| `file_search` | Glob-based file finder, newest-modified first |
| `list_directory` | List one directory |
| `workspace_tree` | Recursive tree (gitignore-aware pruning) |
| `run_terminal` | Streamed shell command with runtime detection + timeout |
| `create_entry` | Create an empty file or folder |
| `delete_entry` | Delete a file or folder |
| `rename_entry` | Rename / move within the workspace |
| `ask_user` | Ask the user a question mid-run (via SSE `user_question` event) |
| `manage_plan` | Post/update a non-blocking task checklist (via SSE `plan_update` event) for multi-part requests |
| `analyze_requirements` | Structured breakdown of the requirement corpus (ACs, risks, gaps) — QA profile |
| `write_artefact` | Write any JSON + Markdown artefact pair (analysis, test_strategy, model artefacts) — QA profile |
| `generate_gherkin` | Render Gherkin scenarios with traceability tags + AC-coverage enforcement — QA profile |
| `generate_test_cases` | Functional/manual test-case suite with numbered steps + AC-coverage enforcement — QA profile |
| `generate_automation` | Scaffold a runnable automation bundle for a framework from scenarios/features — QA profile |
| `generate_nfr_tests` | Scaffold performance (k6/JMeter/Gatling/Locust) or security (OWASP/ZAP) test assets — QA profile |
| `execute_tests` | Run a suite and parse JUnit XML / stdout into a TestReport artefact (execution→report loop) — QA profile |
| `build_traceability_matrix` | Requirement→test→result matrix (RTM) as JSON + Markdown + CSV — QA profile |
| `export_test_cases` | Export a test-case suite to CSV (generic / TestRail / Xray) — QA profile |

Register a new tool by subclassing `react_core.tools.base.BaseTool` and adding
its class to `_DEFAULT_TOOL_CLASSES` in `react_core/tools/registry.py`.

## Design notes

- **Path sandbox** — `permissions/path_guard.py` rejects any path that
  escapes the workspace root (`..`, absolute paths, symlink traversal).
- **Scan policy** — `permissions/scan_policy.py` reads the project's own
  `.gitignore`, `.rgignore`, `.ignore` to prune dependency and build
  directories from tree/grep. Overridable per call.
- **Runtime probe** — `tools/runtime_probe.py` merges the machine's fresh
  PATH (Windows registry + POSIX login shell) so `run_terminal` sees
  runtimes installed mid-session and returns a structured
  `runtime_missing` result instead of an opaque "not recognized" error.
- **No secrets in subprocesses** — `run_terminal` strips env vars whose
  names contain `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`
  before spawning the shell.
- **Parallel tools** — the LLM can return an `actions` array; every tool
  executes concurrently via `asyncio.gather`, results reassembled in order.
- **Stop control** — an in-flight run is cancellable via `/api/agent/stop`;
  the loop checks a per-thread flag between steps and after every tool.

## Env vars

See `.env`. Minimum for the default (Google Gemini):

```
LLM_PROVIDER=gemini
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001

REACT_CORE_STATE_DIR=./.react-core
REACT_CORE_HOST=127.0.0.1
REACT_CORE_PORT=8080
REACT_CORE_MAX_STEPS=50
```

The runtime now routes LLM and embedding calls through LangChain adapters.
If `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, Langfuse tracing
is enabled for both LLM and embedding traffic.

OpenAI:

```
LLM_PROVIDER=openai
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Azure OpenAI:

```
LLM_PROVIDER=azure
EMBEDDING_PROVIDER=azure
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com

AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_MODEL=gpt-4o
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AZURE_OPENAI_API_VERSION=2024-08-01-preview
AZURE_OPENAI_EMBEDDING_API_VERSION=2024-08-01-preview
```
