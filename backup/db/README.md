# Database — the single source of schema truth

Everything DevSphere AI stores in PostgreSQL is defined under **`db/migrations/`**,
and nowhere else. No `.sql` lives anywhere else in the repo, and no code creates
or alters tables at runtime.
`backend/workspace_studio/tests/test_migration_contract.py` enforces both rules.

```
db/
  migrations/
    001_init.sql               full schema — 14 tables, indexes, constraints
    002_grants.sql             DML grants for the application role
    003_unnamed_workspaces.sql lets a user own >1 unnamed (agent-created) workspace
    004_agent_context.sql      per-agent checkpoints for crash/restart resume
    005_model_governance.sql   models, teams, access policies, token quotas
  seed.py                      creates the first admin user
  seed_models.py               imports the .env model into model_configs
  README.md                    this file
```

Migrations run **as the database owner**. Order matters: `002` grants on tables that
`001` creates. A **fresh** database needs `001`, `004`, `005`, then `002` — `003` is
already folded into `001`, and exists for databases provisioned before that fix.

**Re-run `002_grants.sql` after `005`.** It grants `ON ALL TABLES IN SCHEMA public`,
which covers tables that exist when it runs; new ones are otherwise unreachable to
the app role until someone re-grants.

---

## 1. The model

**The workspace is the unit of tracking. The owner is the unit of isolation.**

```
users
  │  owner_user_id
  ▼
workspaces ──────────────────────────────┐
  │  id (BIGSERIAL)                      │  tracking_id (TEXT, stable)
  │                                      │
  ▼  operational state                   ▼  agent state
sessions          (many per workspace,   agent_messages
connectors         one active at a time) agent_session_snapshots
chat_messages                            long_term_memory
session_state                            token_usage
sync_logs                                run_states
workspace_audit_logs                     spec_workflows
```

Every workspace row carries **two keys**, and which one a table joins on tells you
what kind of state it holds:

| Key           | Type        | Joined by                                                                                          |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `id`          | `BIGSERIAL` | Workspace Studio operational state — sessions, connectors, chat, sync, recovery, audit               |
| `tracking_id` | `TEXT`      | Agent state — messages, snapshots, memory, token usage, run-state, spec workflows                    |

`tracking_id` is the value the agent code calls `thread_id`. **Python keeps the
parameter name `thread_id`; the column is always `tracking_id`.** It defaults to
`gen_random_uuid()::text`, so a workspace always has one, whether it was created
by the UI or auto-created by the agent mid-run.

Both keys live on the same row, so a workspace and its complete agent history are
one unit and cascade together on delete.

### Isolation

A workspace belongs to exactly one user via `owner_user_id`. `WorkspaceService`
filters on it for **both reads and writes** — list, get, update, delete, archive,
restore and set-active all pass through `_get_record()`, and the sibling services
(sessions, sync, recovery, chat) gate on `ensure_access()`. Admins (`is_admin` in
the JWT) are the only carve-out.

Scope is always derived from the JWT, never from a request parameter — a
client-supplied scope would be a client-supplied authorisation decision.

Two details worth knowing:

- **Unauthorised access returns 404, not 403.** `workspaces.id` is a sequential
  `BIGSERIAL`; a 403 would confirm which ids exist and turn the primary key into
  an enumeration oracle. "Someone else's" and "doesn't exist" are indistinguishable.
- **`owner_user_id` is nullable.** The agent can create a workspace before anyone
  has signed in for it (`_ensure_thread`); the first authenticated user to use that
  thread claims it (`postgres_agent.claim_thread`, an atomic
  `INSERT … ON CONFLICT DO UPDATE … COALESCE(existing, new)` that returns the
  *effective* owner so the caller can reject a mismatch). Unclaimed rows belong to
  nobody and are excluded from every workspace list.

There is **no `projects` table and no `project_id`**. That was cross-module coupling
to the DevAccel monorepo, where a *project* was the tenancy unit — see §5.

### Synthetic rows

`001_init.sql` seeds two workspaces, `__global__` and `__chat__`, purely so global
token accounting has a `tracking_id` to FK against. They are agent bookkeeping and
are filtered out of user-facing listings.

---

## 2. The tables

### Identity

**`users`** — standalone identity; no shared platform tables.
`id`, `email` (unique), `username` (unique), `full_name`, `password_hash`, `role`
(`admin` | `user`), `is_active`, `last_login`, `login_count`, timestamps.

### The tracking unit

**`workspaces`** — `id`, `tracking_id` (unique, auto-UUID), `owner_user_id` →
`users(id)`, `name`, `description`, `local_fs_path`, `status`
(`active` | `archived` | `deleted`), `sync_version`, `version`,
`active_session_id` → `sessions(id)`, timestamps, `deleted_at`.

Key constraint: **`ux_workspaces_owner_name_active`** — one active workspace name
per owner, case-insensitive. The repository maps the resulting `IntegrityError` to
a `DuplicateError`, so two users may both have a workspace called "api".

### Workspace Studio (operational — keyed by `workspaces.id`)

| Table                  | Holds                                     | Notable constraint                                                 |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `sessions`             | Named working sessions, one live per WS   | `ux_sessions_one_active_per_workspace` (partial: `is_active AND active`) |
| `connectors`           | Source bindings (`local_fs`, `git`, …)    | `chk_connectors_type`                                              |
| `chat_messages`        | UI chat transcript                        | `chk_chat_role` (`system`/`user`/`assistant`/`tool`)                |
| `session_state`        | Recovery snapshot, one row per workspace  | `uq_session_state_workspace`                                       |
| `sync_logs`            | Client sync batches                       | `uq_sync_logs_batch (workspace_id, client_id, batch_id)` — idempotency |
| `workspace_audit_logs` | Who did what, with `correlation_id`       | —                                                                  |

A user may create **many sessions per workspace**; the partial unique index allows
any number of `completed`/`archived` sessions while permitting only one `active`.

### Agent (keyed by `workspaces.tracking_id`)

| Table                     | Holds                                                    |
| ------------------------- | -------------------------------------------------------- |
| `agent_messages`          | Full conversation incl. `tool_calls` / `tool_call_id`     |
| `agent_session_snapshots` | Point-in-time message-array snapshots                     |
| `long_term_memory`        | Durable facts with JSONB `tags`                           |
| `token_usage`             | Per-call prompt/completion/total by model                 |
| `run_states`              | Resumable run state (one row per workspace)               |
| `spec_workflows`          | Spec-driven progress; `UNIQUE (tracking_id, feature_number)` |

All six FK into `workspaces(tracking_id) ON DELETE CASCADE` — agent history can
never orphan from its workspace.

`token_usage` also carries `user_id`, `run_id`, `agent_id`, `model_config_id`,
`cached_tokens`, `reasoning_tokens` and `cost_usd` (005). Keyed only by
`tracking_id` it could say what a *workspace* consumed but never what a *person*
did — the one question a quota has to answer.

### Model governance (005_model_governance.sql)

Admin-managed replacements for what used to live in `backend/.env`:
`AZURE_OPENAI_DEPLOYMENT`, `MODEL_CONTEXT_WINDOW` and the `LLM_MODEL_ALIASES`
string parsed by `llm/factory.py`.

| Table                   | Holds                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `model_configs`         | One model an admin can hand out: deployment, window, capabilities, pricing |
| `teams` / `team_members`| Grouping for access and budgets — **not** a tenancy or sharing boundary |
| `model_access_policies` | "This subject may use this model", + which is their default            |
| `token_quotas`          | Daily / monthly / per-run limits, warn thresholds, degrade model       |
| `token_usage_daily`     | Per-user per-day rollup, upserted with every detail row                |

Three things about these tables are load-bearing:

- **`api_key` holds the provider key itself** (`006_model_api_key.sql`, which
  renamed `api_key_env`). A model is therefore self-contained: adding a
  deployment in the admin UI works with no `.env` edit and no restart. The cost
  is that the key is at rest in the database, so **treat DB backups as
  secret-bearing and restrict who can read `model_configs`**. Two things keep
  the blast radius from growing: the API never returns the value — `GET
  /api/admin/models` sends `api_key_set` and a 4-character `api_key_hint` — and
  `llm/factory.py` logs only whether a key resolved, never any part of it. The
  column is nullable, and a row that leaves it blank falls back to the
  provider's env var, so keeping keys in `.env` is still supported.
- **Subject precedence is `user > team > role > global`, and the most specific
  match wins OUTRIGHT.** Policies and quotas are not merged or intersected — a
  user-level row is an override, not an extra constraint. `subject_ref` is TEXT
  (a role name, or an id rendered as text) with `'*'` for global; not NULL,
  because NULLs are distinct in a unique index and the global row could then be
  inserted many times over.
- **`token_usage_daily` exists for speed, not convenience.** Quotas are
  re-checked at every agent step; against `token_usage` that is a `SUM` over a
  growing table on every LLM call, against this it is one primary-key lookup. It
  is written in the same transaction as the detail row, so the two can never
  disagree.

**Applying it is a no-op until an admin acts.** `model_configs` ships empty and
`llm/model_registry.py` falls back to the `.env` model; the seeded `token_quotas`
row has no limits. `python db/seed_models.py` imports the current `.env` model
(and every `LLM_MODEL_ALIASES` entry) as the first rows.

---

## 3. Flows

### First run

Steps 1 and 2 run **as the database owner** (the app role has no DDL rights):

```bash
psql "$ADMIN_URL" -f db/migrations/001_init.sql   # 14 tables + indexes + synthetic rows
psql "$ADMIN_URL" -f db/migrations/002_grants.sql # DML for the app role
SEED_ADMIN_PASSWORD='…' python db/seed.py         # first admin (runs as the app role)
```

Skip `002_grants.sql` on docker-compose, where the app connects as `POSTGRES_USER`
and already owns everything.

Then confirm, connected as the **app** role:

```sql
SELECT has_schema_privilege(current_user, 'public', 'USAGE')     AS usage,     -- t
       has_schema_privilege(current_user, 'public', 'CREATE')    AS create_,   -- f (correct)
       has_table_privilege(current_user, 'workspaces', 'SELECT') AS can_read;  -- t
```

### Creating a workspace (UI)

```
POST /api/workspaces  { name, description, local_fs_path }
  → owner_user_id taken from the JWT (never from the body)
  → tracking_id auto-generated
  → ux_workspaces_owner_name_active rejects a duplicate active name for that user
```

### Listing workspaces

```
GET /api/workspaces          ← no scoping parameter by design
  → WHERE owner_user_id = <jwt user>        (admins: all owners)
    AND tracking_id NOT IN ('__global__', '__chat__')
```

### Working in a workspace

```
POST /api/workspaces/{id}/sessions   → sessions row; only one may be active
   ↳ ensure_access(id, user) gates every sibling service
agent stream (SSE) keyed by tracking_id
   ↳ agent_messages / token_usage / run_states / long_term_memory / spec_workflows
```

### Agent-initiated workspace

```
agent run with an unknown thread_id
  → _ensure_thread() inserts workspaces(tracking_id), owner_user_id NULL
  → not listed anywhere (belongs to nobody)
  → first authenticated use calls claim_thread(thread_id, user_id)
      · unowned → claimed, returns that user
      · already owned → returns the real owner, caller must reject
```

---

## 4. Changing the schema

1. Edit `db/migrations/001_init.sql` so a **fresh** database gets the final shape.
   Keep every statement `IF NOT EXISTS` / idempotent.
2. If existing databases need migrating, add `00N_<name>.sql` **in this folder**.
3. Run the contract test:
   ```bash
   cd backend/workspace_studio && PYTHONPATH=.. pytest tests/test_migration_contract.py -q
   ```
4. Apply to each environment with `psql`.

Never add schema under `backend/`, and never create tables from application code —
see §5 for why.

### Permissions

Two roles, on purpose:

| Role                       | Holds                                                        |
| -------------------------- | ------------------------------------------------------------ |
| **owner** (e.g. Azure admin) | Owns the tables. Runs migrations. The only role with DDL.    |
| **app** (`DB_USER` in `.env`) | `USAGE` on `public` + `SELECT/INSERT/UPDATE/DELETE`. **No `CREATE`.** |

`002_grants.sql` is what bridges them — a table created by the owner grants the app
role nothing by default, so without it every query fails with *permission denied for
table …*. It also sets `ALTER DEFAULT PRIVILEGES`, so tables added by later migrations
are covered automatically — provided those migrations run as the same owner role.

Re-run `002_grants.sql` after any migration that adds a table if you're unsure.

Expected state for the app role: `USAGE` **true**, `CREATE` **false**. A `true` there
means the app could create tables at runtime, which is exactly the failure mode §5
describes.

---

## 5. Why it is built this way

The repo used to carry **three** schema definitions — `db/migrations/`,
`backend/persistence/migrations/` and `backend/workspace_studio/migrations/` —
that disagreed with each other and with the deployed database. Two failures came
directly out of that:

- **`spec_store.py` queried `devsphere_spec_workflows`**, a table renamed to
  `spec_workflows` here and never present in the deployed database. It tried to
  `CREATE TABLE` it at runtime to self-heal; the app role has no `CREATE` on
  `public`, so every request logged an `InsufficientPrivilege` *and* an
  `UndefinedTable` error. Self-healing DDL was working around the correct
  production posture instead of fixing the name.
- **Workspaces silently disappeared.** The list query filtered on
  `workspaces.project_id`, scoped by a `/api/v1/projects` call that this product
  never served (it belonged to the DevAccel USG service). With no project the list
  was empty; with a stale `localStorage` project id it showed a subset. Every
  agent-created workspace — `project_id` NULL — was invisible. Meanwhile
  `owner_user_id` was written on create and read by nothing, so any account with
  the `workspace_studio` role could read or delete any workspace by id.

Hence the three rules this folder exists to keep: **one schema location**,
**no runtime DDL**, and **tenancy enforced in code and asserted by tests**.

---

## 6. Verifying a database

```bash
# Every table/column/index in 001_init.sql present in the live DB?
cd backend/workspace_studio && PYTHONPATH=.. pytest tests/test_migration_contract.py -q

# Ad-hoc: what does the live DB actually have?
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "\d workspaces"
```

Expected: **14 tables** — `users`, `workspaces`, `sessions`, `connectors`,
`chat_messages`, `session_state`, `sync_logs`, `workspace_audit_logs`,
`agent_messages`, `agent_session_snapshots`, `long_term_memory`, `token_usage`,
`run_states`, `spec_workflows`.

Unclaimed agent workspaces (excluded from listings by design):

```sql
SELECT id, name, tracking_id, created_at
FROM workspaces
WHERE owner_user_id IS NULL
  AND tracking_id NOT IN ('__global__', '__chat__');
```

Hand one to a user:

```sql
UPDATE workspaces SET owner_user_id = <user_id>, name = '<name>'
WHERE tracking_id = '<tracking_id>';
```
