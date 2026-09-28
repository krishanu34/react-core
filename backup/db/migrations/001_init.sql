-- =============================================================================
-- DevSphere AI — unified initial schema
-- =============================================================================
-- Design principle: the WORKSPACE is the unit of tracking. Each workspace owns a
-- stable `tracking_id` (the value formerly called `thread_id`). Every piece of
-- agent state (messages, token usage, memory, run-state, spec workflows) joins
-- back to the workspace by that `tracking_id`; operational workspace state
-- (sessions, sync, audit) joins by the numeric `id`. Both live on ONE workspace
-- row, so a workspace and its full agent history are trivially trackable.
--
-- Standalone identity: own `users` table. No shared platform tables and no
-- `projects` table — the old cross-module coupling is gone entirely.
--
-- Tenancy: the OWNER is the boundary. A workspace belongs to one user
-- (`owner_user_id`), and every read/write path in WorkspaceService filters on it;
-- admins are the only carve-out.
--
-- Apply on a fresh database:  psql "$DATABASE_URL" -f db/migrations/001_init.sql
-- =============================================================================

BEGIN;

-- ── Identity ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    username        VARCHAR(100) NOT NULL UNIQUE,
    full_name       VARCHAR(255),
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(50)  NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    last_login      TIMESTAMPTZ,
    login_count     INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

-- ── Workspace = the tracking unit ────────────────────────────────────────────
-- `tracking_id` is the single stable handle (was devsphere_threads.id / thread_id).
-- `owner_user_id` is NULLABLE so an agent-auto-created workspace can be claimed by
-- the first authenticated user who uses it (postgres_agent.claim_thread); UI-created
-- workspaces always set it. Unclaimed rows belong to nobody and are not listed.
CREATE TABLE IF NOT EXISTS workspaces (
    id                  BIGSERIAL PRIMARY KEY,
    -- Every workspace ALWAYS has a stable tracking id. Workspace Studio inserts
    -- that don't supply one get a generated UUID; the agent uses this value as
    -- its thread handle. (gen_random_uuid() is core in PostgreSQL 13+.)
    tracking_id         TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    owner_user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL DEFAULT '',
    description         TEXT,
    local_fs_path       TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    sync_version        INTEGER NOT NULL DEFAULT 1,
    version             INTEGER NOT NULL DEFAULT 1,
    active_session_id   BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at    TIMESTAMPTZ,
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT chk_workspaces_status CHECK (status IN ('active', 'archived', 'deleted')),
    CONSTRAINT chk_workspaces_version CHECK (version > 0),
    CONSTRAINT chk_workspaces_sync_version CHECK (sync_version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_status  ON workspaces(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_workspaces_last_accessed ON workspaces(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_sync_version  ON workspaces(sync_version);
-- One active workspace NAME per owner — the rule the repository's
-- IntegrityError -> DuplicateError mapping depends on.
--
-- `name <> ''` is load-bearing. Agent-created workspaces (_ensure_thread /
-- claim_thread) insert no name, so they take the DEFAULT ''. Without this
-- predicate an empty string counts as a name, a user is capped at ONE unnamed
-- workspace, and every agent run on a new thread after the first fails with a
-- unique violation. An empty name is the absence of a name, not a name.
CREATE UNIQUE INDEX IF NOT EXISTS ux_workspaces_owner_name_active
    ON workspaces(owner_user_id, LOWER(name))
    WHERE deleted_at IS NULL AND status = 'active' AND name <> '';

-- Synthetic workspaces used by the agent for global token accounting.
INSERT INTO workspaces (tracking_id, name) VALUES ('__global__', 'Global')
    ON CONFLICT (tracking_id) DO NOTHING;
INSERT INTO workspaces (tracking_id, name) VALUES ('__chat__', 'Chat')
    ON CONFLICT (tracking_id) DO NOTHING;

-- ── Sessions (operational, keyed by workspace.id) ────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    id                  BIGSERIAL PRIMARY KEY,
    workspace_id        BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_name        VARCHAR(255) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    is_active           BOOLEAN NOT NULL DEFAULT FALSE,
    context_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at    TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    CONSTRAINT chk_sessions_status CHECK (status IN ('active', 'completed', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated   ON sessions(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_one_active_per_workspace
    ON sessions(workspace_id)
    WHERE is_active = TRUE AND status = 'active';

ALTER TABLE workspaces
    DROP CONSTRAINT IF EXISTS workspaces_active_session_id_fkey;
ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_active_session_id_fkey
    FOREIGN KEY (active_session_id) REFERENCES sessions(id) ON DELETE SET NULL;

-- ── Connectors (operational) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connectors (
    id                  BIGSERIAL PRIMARY KEY,
    workspace_id        BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connector_type      VARCHAR(50) NOT NULL,
    display_name        VARCHAR(255),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT chk_connectors_type CHECK (connector_type IN ('indexeddb', 'local_fs', 'upload', 'git', 'other')),
    CONSTRAINT chk_connectors_status CHECK (status IN ('active', 'disabled', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_connectors_workspace ON connectors(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connectors_type      ON connectors(connector_type);

-- ── Workspace Studio chat / sync / recovery (keyed by workspace.id) ──────────
CREATE TABLE IF NOT EXISTS chat_messages (
    id                  BIGSERIAL PRIMARY KEY,
    workspace_id        BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id          BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
    role                VARCHAR(50) NOT NULL,
    content             TEXT NOT NULL,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_chat_role CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_workspace ON chat_messages(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session   ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created   ON chat_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS session_state (
    id                  BIGSERIAL PRIMARY KEY,
    workspace_id        BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id          BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
    state_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_session_state_workspace UNIQUE (workspace_id),
    CONSTRAINT chk_session_state_version CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_session_state_session ON session_state(session_id);
CREATE INDEX IF NOT EXISTS idx_session_state_updated ON session_state(updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_logs (
    id                  BIGSERIAL PRIMARY KEY,
    workspace_id        BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    client_id           VARCHAR(128) NOT NULL,
    batch_id            VARCHAR(128) NOT NULL,
    idempotency_key     VARCHAR(300) NOT NULL,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL,
    conflict_count      INTEGER NOT NULL DEFAULT 0,
    request_hash        VARCHAR(64),
    details             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_sync_logs_status CHECK (status IN ('synced', 'conflict', 'failed', 'noop')),
    CONSTRAINT uq_sync_logs_batch UNIQUE (workspace_id, client_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_workspace ON sync_logs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_client    ON sync_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created   ON sync_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_audit_logs (
    id                  BIGSERIAL PRIMARY KEY,
    workspace_id        BIGINT REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_type          VARCHAR(100) NOT NULL,
    entity_type         VARCHAR(50),
    entity_path         TEXT,
    details             JSONB NOT NULL DEFAULT '{}'::jsonb,
    correlation_id      VARCHAR(128),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_audit_workspace ON workspace_audit_logs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_user      ON workspace_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_event     ON workspace_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_created   ON workspace_audit_logs(created_at DESC);

-- ── Agent persistence (keyed by workspaces.tracking_id) ──────────────────────
-- All formerly `devsphere_*` tables, re-keyed from the free TEXT thread_id to a
-- FK on workspaces(tracking_id), so agent history can never orphan from a
-- workspace and cascades when the workspace is deleted.
CREATE TABLE IF NOT EXISTS agent_messages (
    id              BIGSERIAL PRIMARY KEY,
    tracking_id     TEXT NOT NULL REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    role            VARCHAR(50) NOT NULL,
    content         TEXT,
    tool_calls      JSONB,
    tool_call_id    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_tracking ON agent_messages(tracking_id, id);

CREATE TABLE IF NOT EXISTS agent_session_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    tracking_id     TEXT NOT NULL REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    messages_json   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_session_snapshots_tracking
    ON agent_session_snapshots(tracking_id, id DESC);

CREATE TABLE IF NOT EXISTS long_term_memory (
    id              BIGSERIAL PRIMARY KEY,
    tracking_id     TEXT NOT NULL REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_long_term_memory_tracking ON long_term_memory(tracking_id, id);

CREATE TABLE IF NOT EXISTS token_usage (
    id                  BIGSERIAL PRIMARY KEY,
    tracking_id         TEXT NOT NULL REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    model               TEXT,
    prompt_tokens       INTEGER NOT NULL DEFAULT 0,
    completion_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_tracking ON token_usage(tracking_id, id);

CREATE TABLE IF NOT EXISTS run_states (
    tracking_id     TEXT PRIMARY KEY REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    state           JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spec_workflows (
    id              BIGSERIAL PRIMARY KEY,
    tracking_id     TEXT NOT NULL REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    feature_slug    TEXT NOT NULL,
    feature_number  TEXT NOT NULL,
    current_phase   TEXT NOT NULL,
    status          TEXT NOT NULL,
    gates           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tracking_id, feature_number)
);

CREATE INDEX IF NOT EXISTS idx_spec_workflows_tracking ON spec_workflows(tracking_id, id DESC);

COMMIT;
