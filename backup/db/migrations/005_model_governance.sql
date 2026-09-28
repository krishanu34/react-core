-- =============================================================================
-- 005_model_governance.sql — admin-managed models, teams, quotas, and token
-- accounting that can answer "who used what, on which model, at what cost".
-- =============================================================================
-- Apply as the DATABASE OWNER, then re-run 002_grants.sql so the app role can
-- write to the new tables:
--
--   psql "$ADMIN_DATABASE_URL" -f db/migrations/005_model_governance.sql
--   psql "$ADMIN_DATABASE_URL" -f db/migrations/002_grants.sql
--
-- WHAT THIS REPLACES
--   Model selection lived entirely in backend/.env: AZURE_OPENAI_DEPLOYMENT,
--   MODEL_CONTEXT_WINDOW, LLM_MAX_OUTPUT_TOKENS and the LLM_MODEL_ALIASES
--   string parsed by llm/factory.py. Every user on a deployment therefore ran
--   the same model, and changing it meant editing a file and restarting.
--   `model_configs` is that same information as rows, so an admin can change it
--   live and assign different models to different roles, teams and users.
--
-- NOTHING BREAKS WHEN THESE TABLES ARE EMPTY. llm/model_registry.py falls back
-- to the .env path, which is exactly today's behaviour — the DB is an override,
-- not a new requirement.
--
-- WHERE THE SECRETS LIVE: `api_key_env` holds the NAME of the environment
-- variable that holds the key (e.g. 'AZURE_OPENAI_API_KEY'), never the key
-- itself. The repo's rule is that secrets live only in .env; a credential in a
-- table is a credential in every backup, log and admin screen.
-- =============================================================================

BEGIN;

-- ── Models an admin can hand out ─────────────────────────────────────────────
-- `model_key` is the stable slug agents and clients refer to ('fast', 'deep').
-- It is the DB form of an LLM_MODEL_ALIASES entry, so sub_agent_tool's existing
-- `model="fast"` argument keeps working with no change to the tool.
CREATE TABLE IF NOT EXISTS model_configs (
    id                       SERIAL PRIMARY KEY,
    model_key                VARCHAR(64)  NOT NULL UNIQUE,
    display_name             VARCHAR(255) NOT NULL,
    provider                 VARCHAR(50)  NOT NULL DEFAULT 'azure',
    -- Azure deployment name / OpenAI-Anthropic model id.
    model_name               VARCHAR(255) NOT NULL,
    endpoint_url             TEXT,
    api_version              VARCHAR(50),
    -- NAME of the env var holding the key. NULL → the provider's default var.
    api_key_env              VARCHAR(128),

    -- Capability facts. These override the name-guessing in
    -- llm/model_capabilities.py, which exists precisely because Azure
    -- deployment names don't reveal the underlying model.
    context_window           INTEGER NOT NULL DEFAULT 128000,
    max_output_tokens        INTEGER NOT NULL DEFAULT 16384,
    supports_temperature     BOOLEAN NOT NULL DEFAULT TRUE,
    tokens_param             VARCHAR(32) NOT NULL DEFAULT 'max_tokens',
    supports_vision          BOOLEAN NOT NULL DEFAULT FALSE,

    -- Cheapness ordering, used to pick a fallback when a quota is exhausted.
    tier                     VARCHAR(20) NOT NULL DEFAULT 'balanced',

    -- Pricing per 1,000,000 tokens, in USD. Cached input is billed at a small
    -- fraction of fresh input, which is why it is a separate rate rather than
    -- folded into input_cost — see the cached_tokens column on token_usage.
    input_cost_per_1m        NUMERIC(12,6) NOT NULL DEFAULT 0,
    cached_input_cost_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
    output_cost_per_1m       NUMERIC(12,6) NOT NULL DEFAULT 0,

    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    -- The model used when nothing more specific applies to the caller.
    is_default               BOOLEAN NOT NULL DEFAULT FALSE,
    created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_model_configs_tier
        CHECK (tier IN ('fast', 'balanced', 'deep')),
    CONSTRAINT chk_model_configs_tokens_param
        CHECK (tokens_param IN ('max_tokens', 'max_completion_tokens')),
    CONSTRAINT chk_model_configs_context_window CHECK (context_window > 0),
    CONSTRAINT chk_model_configs_output_tokens  CHECK (max_output_tokens > 0)
);

CREATE INDEX IF NOT EXISTS idx_model_configs_active ON model_configs(is_active);

-- Exactly one global default. Without this, "the default model" is whichever
-- row the planner happens to return first, and it silently changes over time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_model_configs_one_default
    ON model_configs(is_default)
    WHERE is_default;

-- ── Teams ────────────────────────────────────────────────────────────────────
-- A grouping layer for model access and quotas ONLY. It is deliberately not a
-- tenancy boundary: workspaces stay owned by one user (see db/README.md), and
-- adding a second ownership axis here would quietly break that invariant.
CREATE TABLE IF NOT EXISTS teams (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(150) NOT NULL UNIQUE,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_team VARCHAR(30) NOT NULL DEFAULT 'member',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id),
    CONSTRAINT chk_team_members_role CHECK (role_in_team IN ('lead', 'member'))
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- ── Who may use which model ──────────────────────────────────────────────────
-- One row = "this subject may use this model". `subject_type` + `subject_ref`
-- is a soft polymorphic key rather than four nullable FK columns, because the
-- resolver treats all four kinds identically and only the PRECEDENCE differs:
--
--     user  >  team  >  role  >  global
--
-- `subject_ref` is TEXT for the same reason: a role subject is a name
-- ('admin'), a team/user subject is an id rendered as text. '*' for global —
-- not NULL, because NULLs are distinct in a unique index and would let the
-- global row be inserted many times over.
CREATE TABLE IF NOT EXISTS model_access_policies (
    id                   SERIAL PRIMARY KEY,
    subject_type         VARCHAR(20) NOT NULL,
    subject_ref          TEXT        NOT NULL DEFAULT '*',
    model_config_id      INTEGER NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE,
    -- The subject's preferred model when the caller doesn't name one.
    is_default_for_subject BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_model_access_subject_type
        CHECK (subject_type IN ('global', 'role', 'team', 'user')),
    CONSTRAINT uq_model_access_subject_model
        UNIQUE (subject_type, subject_ref, model_config_id)
);

CREATE INDEX IF NOT EXISTS idx_model_access_subject
    ON model_access_policies(subject_type, subject_ref);

-- At most one default per subject, for the same reason as the global default.
CREATE UNIQUE INDEX IF NOT EXISTS ux_model_access_one_default_per_subject
    ON model_access_policies(subject_type, subject_ref)
    WHERE is_default_for_subject;

-- ── Token budgets ────────────────────────────────────────────────────────────
-- Same subject model and the same precedence as model_access_policies: the
-- most specific ACTIVE row wins outright (they are not summed or intersected —
-- a user-level quota is an override, not an additional constraint).
--
-- NULL limit = unlimited on that axis. All three axes can be NULL, which is a
-- quota row that only carries warning thresholds.
CREATE TABLE IF NOT EXISTS token_quotas (
    id                      SERIAL PRIMARY KEY,
    subject_type            VARCHAR(20) NOT NULL,
    subject_ref             TEXT        NOT NULL DEFAULT '*',

    daily_token_limit       BIGINT,
    monthly_token_limit     BIGINT,
    -- Generalises MAX_AGENT_TOKENS (agents/tool_use_agent.py) from one process
    -- -wide env var to a per-subject setting: one runaway agent loop can't burn
    -- a whole month's budget.
    per_run_token_limit     BIGINT,

    -- Percentages of the binding limit at which the UI warns.
    warn_pct                SMALLINT NOT NULL DEFAULT 75,
    critical_pct            SMALLINT NOT NULL DEFAULT 90,

    -- What happens at 100%. Claude Code's own behaviour is to DEGRADE, not to
    -- stop: work continues on a cheaper model. When this is NULL there is
    -- nothing to degrade to and the run is refused instead.
    degrade_model_config_id INTEGER REFERENCES model_configs(id) ON DELETE SET NULL,
    -- An absolute ceiling that even the degrade model may not cross. NULL =
    -- degrade forever.
    hard_block_tokens       BIGINT,

    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_token_quotas_subject_type
        CHECK (subject_type IN ('global', 'role', 'team', 'user')),
    CONSTRAINT chk_token_quotas_pcts
        CHECK (warn_pct BETWEEN 1 AND 100
               AND critical_pct BETWEEN 1 AND 100
               AND warn_pct <= critical_pct),
    CONSTRAINT chk_token_quotas_limits
        CHECK (COALESCE(daily_token_limit, 1) > 0
               AND COALESCE(monthly_token_limit, 1) > 0
               AND COALESCE(per_run_token_limit, 1) > 0
               AND COALESCE(hard_block_tokens, 1) > 0)
);

-- One ACTIVE quota per subject — two would make "the limit" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS ux_token_quotas_one_active_per_subject
    ON token_quotas(subject_type, subject_ref)
    WHERE is_active;

-- ── Token accounting ─────────────────────────────────────────────────────────
-- token_usage was keyed only by tracking_id, so it could say how much a
-- WORKSPACE consumed but never how much a PERSON did — the one question a
-- quota needs answered. Every column here is nullable or defaulted so existing
-- rows, and the synthetic '__global__' / '__chat__' workspaces, stay valid.
ALTER TABLE token_usage
    ADD COLUMN IF NOT EXISTS user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- One agent run (one POST /api/agent/stream). Lets the per-run ceiling and
    -- the UI's per-message badge read the same source.
    ADD COLUMN IF NOT EXISTS run_id           TEXT,
    -- '__root__' or a SubAgentTool child id, matching agent_checkpoints.agent_id.
    ADD COLUMN IF NOT EXISTS agent_id         TEXT,
    ADD COLUMN IF NOT EXISTS model_config_id  INTEGER REFERENCES model_configs(id) ON DELETE SET NULL,
    -- Azure reports prompt-cache hits in prompt_tokens_details.cached_tokens.
    -- llm/azure_openai.py already parses this and logged it; it is billed at a
    -- fraction of the fresh-input rate, so cost is wrong without it. Cached
    -- tokens are a SUBSET of prompt_tokens, not an addition to them.
    ADD COLUMN IF NOT EXISTS cached_tokens    INTEGER NOT NULL DEFAULT 0,
    -- Reasoning-class models bill hidden reasoning as output tokens.
    ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_subagent      BOOLEAN NOT NULL DEFAULT FALSE;

-- "What has this user spent recently" — the usage page and the admin dashboard.
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created
    ON token_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_run ON token_usage(run_id);

-- ── Rollup: quota checks must be O(1) ────────────────────────────────────────
-- A quota is re-checked at every agent step. Against token_usage that is a
-- SUM over a growing table on every LLM call; here it is one primary-key
-- lookup. Upserted in the same transaction as the detail row, so the two can
-- never disagree.
CREATE TABLE IF NOT EXISTS token_usage_daily (
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date        DATE    NOT NULL,
    prompt_tokens     BIGINT  NOT NULL DEFAULT 0,
    completion_tokens BIGINT  NOT NULL DEFAULT 0,
    cached_tokens     BIGINT  NOT NULL DEFAULT 0,
    total_tokens      BIGINT  NOT NULL DEFAULT 0,
    cost_usd          NUMERIC(14,6) NOT NULL DEFAULT 0,
    request_count     INTEGER NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, usage_date)
);

-- The monthly window sums ~31 of these rows per user.
CREATE INDEX IF NOT EXISTS idx_token_usage_daily_date
    ON token_usage_daily(usage_date DESC);

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- A global quota with no limits: warnings are wired up, nothing is enforced,
-- and an admin narrows it later. Enforcing a limit nobody chose would be a
-- migration that changes behaviour on apply.
INSERT INTO token_quotas (subject_type, subject_ref, warn_pct, critical_pct)
VALUES ('global', '*', 75, 90)
ON CONFLICT DO NOTHING;

-- model_configs is intentionally left EMPTY: the resolver falls back to .env,
-- so applying this migration changes nothing until an admin adds a model.
-- `python db/seed_models.py` imports the current .env as the first row, or:
--
--   INSERT INTO model_configs (
--       model_key, display_name, provider, model_name, endpoint_url,
--       api_version, api_key_env, context_window, max_output_tokens,
--       tier, input_cost_per_1m, cached_input_cost_per_1m, output_cost_per_1m,
--       is_default
--   ) VALUES (
--       'default', 'GPT-4.1', 'azure', 'gpt-4.1', 'https://<you>.openai.azure.com',
--       '2024-12-01-preview', 'AZURE_OPENAI_API_KEY', 128000, 16000,
--       'balanced', 2.00, 0.50, 8.00, TRUE
--   );

COMMIT;
