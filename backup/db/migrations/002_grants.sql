-- =============================================================================
-- 002 — Grant the application role DML access
-- =============================================================================
-- Run as the DATABASE OWNER, immediately after 001_init.sql:
--
--   psql "$ADMIN_DATABASE_URL" -f db/migrations/001_init.sql
--   psql "$ADMIN_DATABASE_URL" -f db/migrations/002_grants.sql
--
-- Why this is a separate step: the application role deliberately owns nothing and
-- has no CREATE on schema `public`, so it cannot create or alter tables. That is
-- the posture that stopped `spec_store.py` from silently self-healing a wrong
-- table name at runtime. The flip side is that a freshly created table grants the
-- app role NOTHING by default — without this file every query fails with
-- "permission denied for table ...".
--
-- Skip this on the docker-compose stack: there the app connects as POSTGRES_USER,
-- which already owns everything.
--
-- Idempotent — safe to re-run, and worth re-running after any schema change that
-- adds a table (ALTER DEFAULT PRIVILEGES only covers tables created afterwards).
-- =============================================================================

DO $$
DECLARE
    -- The role in backend/.env as DB_USER. Change if yours differs.
    app_role TEXT := 'devacceluser';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        RAISE EXCEPTION 'Role % does not exist — create it first, or edit app_role above', app_role;
    END IF;

    -- Run 001 first: the post-check below needs a table to verify against, and
    -- GRANT ON ALL TABLES over an empty schema is a silent no-op.
    IF to_regclass('public.workspaces') IS NULL THEN
        RAISE EXCEPTION 'Table public.workspaces not found — apply 001_init.sql before this file';
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);

    -- DML only: no CREATE, no ownership, no DDL.
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
        app_role);

    -- BIGSERIAL/SERIAL columns need the sequence too, or INSERTs fail.
    EXECUTE format(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

    -- Cover tables/sequences added by future migrations, so a new table doesn't
    -- silently 'permission denied' until someone remembers to re-grant.
    -- NOTE: this applies to objects created by the role running THIS script, so
    -- run migrations as that same owner role.
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role);
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role);

    -- Prove it actually worked. GRANT does NOT error when the executing role
    -- lacks authority — it emits a warning and grants nothing. Run as the wrong
    -- role this whole block would otherwise "succeed" and the app would still
    -- fail with "permission denied for table workspaces" at the first query.
    IF NOT has_table_privilege(app_role, 'public.workspaces', 'SELECT') THEN
        RAISE EXCEPTION
            'Grants did not take effect (% still cannot SELECT public.workspaces). '
            'Re-run this file as the table owner or a superuser — you are currently %.',
            app_role, current_user;
    END IF;

    RAISE NOTICE 'Granted DML on schema public to % (verified)', app_role;
END $$;

-- =============================================================================
-- Verify afterwards, connected AS THE APP ROLE:
--
--   SELECT has_schema_privilege(current_user, 'public', 'USAGE')   AS usage,    -- t
--          has_schema_privilege(current_user, 'public', 'CREATE')  AS create_,  -- f  (correct!)
--          has_table_privilege(current_user, 'workspaces', 'SELECT') AS can_read; -- t
-- =============================================================================
