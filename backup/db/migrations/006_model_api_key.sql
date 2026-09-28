-- =============================================================================
-- 006_model_api_key.sql — store the provider API key on the model row itself.
-- =============================================================================
-- Apply as the DATABASE OWNER, then re-run 002_grants.sql:
--
--   psql "$ADMIN_DATABASE_URL" -f db/migrations/006_model_api_key.sql
--   psql "$ADMIN_DATABASE_URL" -f db/migrations/002_grants.sql
--
-- WHAT CHANGED
--   005 created `api_key_env`, holding the NAME of an environment variable
--   (e.g. 'AZURE_OPENAI_API_KEY'); the backend resolved the value with
--   os.getenv() at call time. This migration renames the column to `api_key`
--   and it now holds the key ITSELF, so a model is fully self-contained: an
--   operator adds a deployment in the admin UI and it works, with no matching
--   .env edit and no backend restart. That is the point of the change — a
--   catalogue that needs a redeploy to add a model is only half a catalogue.
--
-- WHAT THIS COSTS, AND WHAT STILL PROTECTS THE KEY
--   The key is now at rest in the database, which means it is also in every
--   backup and every replica of it. Three things keep that from getting worse:
--
--     * The API never returns the key. GET /api/admin/models sends
--       `api_key_set` (a boolean) and `api_key_hint` (last 4 characters) —
--       never the value, so it does not reach an admin's browser, the browser
--       cache, or a screenshot.
--     * Logs never print it. llm/factory.py reports whether a key is present,
--       not what it is (an earlier version echoed the field and wrote a real
--       key into app.log).
--     * The column is nullable and the backend still falls back to the
--       provider's env var when it is empty, so a deployment that would rather
--       keep keys in .env can simply leave this blank.
--
--   Anyone applying this should treat DB backups as secret-bearing from here
--   on, and restrict who can read `model_configs`.
--
-- IDEMPOTENT: safe to re-run, and safe on a database where the rename was
-- already applied by hand.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    -- Rename in place when 005's column is still there: RENAME keeps the
    -- existing values, which a DROP + ADD would silently discard.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'model_configs' AND column_name = 'api_key_env'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'model_configs' AND column_name = 'api_key'
    ) THEN
        ALTER TABLE model_configs RENAME COLUMN api_key_env TO api_key;
        RAISE NOTICE 'Renamed model_configs.api_key_env to api_key';
    END IF;

    -- Fresh databases, or one where only 005 ran and the column was dropped.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'model_configs' AND column_name = 'api_key'
    ) THEN
        ALTER TABLE model_configs ADD COLUMN api_key VARCHAR(512);
        RAISE NOTICE 'Added model_configs.api_key';
    END IF;
END $$;

-- 005 sized this for a variable NAME (128). A real key is longer — Azure's are
-- 84 characters, and other providers' run past 200 — so a key pasted into the
-- old column would have been truncated or rejected outright.
ALTER TABLE model_configs ALTER COLUMN api_key TYPE VARCHAR(512);

COMMENT ON COLUMN model_configs.api_key IS
    'Provider API key. Stored in the clear — treat backups of this table as '
    'secret-bearing. NULL falls back to the provider env var '
    '(AZURE_OPENAI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY). Never '
    'returned by the API: see api_key_set / api_key_hint.';

ALTER TABLE model_configs
DROP CONSTRAINT chk_model_configs_output_tokens;

ALTER TABLE model_configs
ADD CONSTRAINT chk_model_configs_output_tokens
CHECK (
    (tier = 'embedding' AND max_output_tokens = 0)
    OR
    (tier <> 'embedding' AND max_output_tokens > 0)
);

COMMIT;
