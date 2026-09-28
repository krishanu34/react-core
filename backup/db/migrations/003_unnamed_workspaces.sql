-- =============================================================================
-- 003 — Let a user own more than one UNNAMED workspace
-- =============================================================================
-- Fixes: POST /api/agent/stream -> 500
--   IntegrityError: duplicate key value violates unique constraint
--   "ux_workspaces_owner_name_active"
--   DETAIL: Key (owner_user_id, lower(name::text))=(6, ) already exists.
--
-- Cause: `workspaces.name` has DEFAULT ''. Agent-created workspaces
-- (persistence/postgres_agent.py :: _ensure_thread / claim_thread) insert only a
-- tracking_id and owner, so they take that default. The index treated '' as a
-- name, which capped every user at ONE unnamed workspace — the second agent run
-- on a fresh thread blew up before streaming a single token.
--
-- The constraint only ever meant "no two ACTIVE workspaces with the SAME NAME
-- for one owner". An empty name is the absence of a name, so it is excluded.
-- UI-created workspaces always send a non-empty name (WorkspaceCreateRequest
-- requires min_length=1), so duplicate-name detection is unchanged for them.
--
--   psql "$DATABASE_URL" -f db/migrations/003_unnamed_workspaces.sql
--
-- Idempotent and safe to re-run.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS ux_workspaces_owner_name_active;

CREATE UNIQUE INDEX IF NOT EXISTS ux_workspaces_owner_name_active
    ON workspaces(owner_user_id, LOWER(name))
    WHERE deleted_at IS NULL AND status = 'active' AND name <> '';

COMMIT;

-- Unnamed workspaces render as "Untitled workspace" in the UI. To give one a
-- real name:
--   UPDATE workspaces SET name = '<name>' WHERE tracking_id = '<tracking_id>';
