# DevSphere AI

A standalone, client-server AI coding assistant (Claude-Code-style). The **server thinks**
(agent loop, LLM orchestration); the **client touches the disk** (file/terminal/MCP
execution via a local daemon). One workspace = one stable `tracking_id`, trackable
end-to-end in the database.

## Layout

```
backend/    FastAPI app (:8003) — auth, agent stream (SSE), workspace studio, MCP integration
  ingestion/  file type detection + content extraction for every user attachment
daemon/     Node local daemon (127.0.0.1) — native file/terminal I/O + local stdio MCP hosting
ui/         Next.js 16 web client — login, workspaces dashboard, full IDE
db/         PostgreSQL migrations + seed
```

## Architecture

- **Client-agnostic backend.** All capability is exposed over HTTP/SSE so any client
  (web today; VS Code / CLI / desktop later) can drive it. The backend never assumes
  access to the client's filesystem.
- **Pattern C wire protocol.** The agent runs on the server and emits `tool_use` events
  over SSE; the client executes them (through the daemon or browser File System Access
  API) and POSTs results back. See `backend/ARCHITECTURE_PLAN.md`.
- **Parallel tool calls.** A model turn's tool calls execute concurrently (capped by
  `MAX_PARALLEL_TOOLS`, default 8), which is what makes a *remote* workspace usable —
  N round trips to the client machine collapse into one. Every event carries the id of
  the call it belongs to (`call_id`, `run_id`) so a client can render interleaved
  streams, and same-file read-modify-write serialises so two edits in one batch can't
  silently overwrite each other. Invariants, known gaps and a test guide:
  [`backend/README.md`](backend/README.md#parallel-tool-calls).
- **One ingestion path for user content.** Every file that reaches the model —
  attached to a message, or read later by a tool — goes through
  `backend/ingestion/`, which decides what a file *is* from its bytes and turns it
  into text, into vision-ready images, or into an explicit statement of why
  neither is possible. Callers never branch on format. Details and limits:
  [`backend/README.md`](backend/README.md#15-file--image-input--any-attachment-actually-read).
- **One identity.** A single JWT authenticates both workspace APIs and the agent stream.
- **One tracking id.** Every workspace owns a stable `tracking_id`; all agent messages,
  token usage, memory, run-state and spec workflows join back to it by that
  `tracking_id`, while operational state (sessions, sync, audit) joins by the numeric
  `id`. Both keys live on the same workspace row.
- **The user is the tenancy boundary.** A workspace belongs to one `owner_user_id`, and
  every read *and* write path filters on it; admins are the only carve-out. Scope comes
  from the JWT, never from a request parameter. There is no project/tenant layer above
  the user.

### Data model at a glance

```
users
  └── workspaces (owner_user_id, tracking_id)      ← the tenancy boundary
        ├── by workspaces.id          sessions · connectors · chat_messages
        │                             session_state · sync_logs · workspace_audit_logs
        └── by workspaces.tracking_id agent_messages · agent_session_snapshots
                                      long_term_memory · token_usage · run_states
                                      spec_workflows
```

One user has many workspaces; one workspace has many sessions (exactly one active at a
time, enforced by a partial unique index). Full table-by-table reference, the request
flows, and the migration rules are in **[`db/README.md`](db/README.md)**.

## Attachments

Users attach anything — a requirements `.docx`, an architecture `.pdf`, a
screenshot, a screen recording. Each file is saved unchanged **and** parsed for
the model.

The canonical copy stays on the **user's machine**, at
`<workspace>/.devaccel/input/`. The server receives the bytes once so its
extractor can parse them, then deletes that copy when the run ends — it is
temporary storage, not a file store. This is not only policy: `read_file`
executes on the client, so a server path is one the reading tool cannot open.
A document already sitting in the user's repo is never uploaded at all; the
browser parses it in place.

| Attached | The model gets |
|---|---|
| Text, code, config, CSV, JSON/YAML | Decoded text (encoding detected), table shape for CSV |
| PDF | Per-page text; a scanned PDF's pages are rendered to images for vision |
| Word / Excel / PowerPoint / OpenDocument | Text, tables, sheets, slides, speaker notes |
| HTML, email, Jupyter notebooks | Visible text; headers + body; cells with outputs |
| Images | The image itself (converted and downscaled when needed) |
| Archives | An entry listing — never auto-extracted |
| Audio / video | Format and duration, plus an explicit *"I cannot watch or listen to this"* |

Three properties are load-bearing:

- **Type comes from the bytes**, not the browser's `Content-Type` — that header is
  attacker-controlled, and wrong across browsers even in good faith.
- **Every limit and failure is stated**, in the model's context and in the
  `inputs_saved` SSE event. Silence is how an agent confidently answers "the
  document doesn't mention that" about a page it never received.
- **No format is gated on a third-party library.** OOXML is ZIP+XML, so Office
  documents parse with nothing installed; the optional libraries in
  `backend/requirements.txt` raise quality. PDF text and scanned-page rendering
  are the only capabilities that need one (`pdfplumber` / `pymupdf`).
- **Extraction happens where the file is.** Uploaded attachments are parsed by
  the Python extractor; files in the user's own workspace are parsed in the
  browser (`ui/src/lib/agent/documentExtract.ts`, over the daemon's
  `/fs/read-bytes`) so they never have to be uploaded to be read.

Full behaviour, every environment variable, and how to add a format:
[`backend/README.md`](backend/README.md#15-file--image-input--any-attachment-actually-read).

## Quick start

```bash
# 1. Database — steps 1a/1b run as the OWNER; the app role has no DDL rights.
#    (On docker-compose the app IS the owner, so skip 1b.)
psql "$ADMIN_URL" -f db/migrations/001_init.sql     # 1a. 14 tables + indexes
psql "$ADMIN_URL" -f db/migrations/002_grants.sql   # 1b. DML for the app role
SEED_ADMIN_PASSWORD='...' python db/seed.py         # 1c. initial admin user

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate   # (Windows: .venv/Scripts/activate)
pip install -r requirements.txt        # includes the document-parsing extras
cp .env.example .env                   # fill in DB + SECRET_KEY (models come
                                       # from the model_configs table, managed
                                       # at /admin/models — the .env Azure
                                       # block is an optional fallback)
uvicorn app.main:app --host 0.0.0.0 --port 8003 --reload

# 3. UI
cd ui
npm install
cp .env.local.example .env.local       # point NEXT_PUBLIC_DEVSPHERE_API_URL at the backend
npm run dev                            # http://localhost:3002

# 4. Daemon (on the client machine)
cd daemon && npm install && node cli.js
```

Then sign in at `http://localhost:3002`. The Workspaces routes are gated on the daemon:
the sidebar's **Workspace** section walks you through Setup Guide → Daemon Setup →
Workspaces, and Workspaces unlocks the moment the daemon connects.

## Tests

```bash
# Backend — agent loop, ingestion, tools, spec workflow
cd backend && pytest tests -q --asyncio-mode=auto

# Daemon — sandboxed filesystem layer, auth, origins
cd daemon && node --test

# Workspace studio — run from workspace_studio/, which is those tests' import root
cd backend/workspace_studio && PYTHONPATH=.. pytest tests -q --asyncio-mode=auto

# UI
cd ui && npx vitest run && npx tsc --noEmit
```

## Security

- Secrets live only in `.env` (git-ignored). `*.example` files document keys with no values.
- The daemon binds `127.0.0.1` only and pairs with the browser over a token.
- The agent's file/terminal tools run on the **client**; server-side tool execution is the
  sandboxed browser-fallback path only.
- **Workspace isolation** is enforced in `WorkspaceService`, not just at the route's role
  check: a workspace is only reachable by its `owner_user_id` (or an admin), on reads and
  writes alike. Unauthorised access returns **404, not 403**, so the sequential
  `workspaces.id` can't be used to enumerate what exists.
- **The database role owns no DDL.** `DB_USER` holds DML rights only and no `CREATE` on
  schema `public`; migrations run as the database owner. Application code never creates
  or alters tables — see [`db/README.md`](db/README.md).
- **Uploads are treated as hostile input.** The client's `Content-Type` is recorded
  but never trusted — an executable declaring `image/png` is detected as a binary and
  never reaches a vision request. Filenames are reduced to a safe basename (path
  traversal, Windows reserved names, over-long components), so an upload cannot be
  written outside its thread's `input/` directory. Archives are **listed, never
  extracted** (zip bombs, Zip Slip), and per-file / per-request byte ceilings are
  checked before any parser touches the bytes.

See `docker-compose.yml` for a one-command local stack (postgres + backend + ui).
