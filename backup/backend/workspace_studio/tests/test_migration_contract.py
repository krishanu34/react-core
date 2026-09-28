"""Schema contract for the ONE migration file.

This test used to assert against `workspace_studio/migrations/001_workspace_studio.sql`,
a schema that no longer matched the deployed database (it required
`project_id NOT NULL REFERENCES public.projects(id)`, but there is no `projects`
table and `project_id` is a nullable tag column). Three competing schema
definitions lived in the repo, and code drifted onto a dead one — that is how
`spec_store.py` ended up querying `devsphere_spec_workflows`, a table that had
been renamed to `spec_workflows` and never existed in the deployed database.

So the contract is now:
  1. `db/migrations/001_init.sql` is the ONLY schema file in the repo, and
  2. it contains the tables, keys and constraints the code actually relies on.

Rule 1 is the important one — it is what stops the drift from recurring.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
INIT_SQL = MIGRATIONS_DIR / "001_init.sql"


def _sql() -> str:
    return INIT_SQL.read_text(encoding="utf-8")


def _statements() -> str:
    """The SQL with `--` comments stripped.

    Comments legitimately mention the old names when explaining the rename, so
    checks for banned identifiers must look at executable SQL only.
    """
    return "\n".join(line.split("--")[0] for line in _sql().splitlines())


def test_all_schema_files_live_in_db_migrations():
    """No second source of truth. Schema lives in db/migrations/ and nowhere else
    — not under backend/, not next to the module that happens to use a table."""
    stray = [
        p.relative_to(REPO_ROOT).as_posix()
        for p in REPO_ROOT.rglob("*.sql")
        if "node_modules" not in p.parts
        and ".git" not in p.parts
        and ".venv" not in p.parts
        and p.parent != MIGRATIONS_DIR
    ]
    assert stray == [], f"schema files outside db/migrations/: {stray}"


def test_init_migration_is_present_and_named_first():
    assert INIT_SQL.exists()
    assert sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))[0] == "001_init.sql"


def test_migration_defines_every_table_the_backend_queries():
    sql = _sql()
    for table in (
        # identity + the workspace tracking unit
        "users",
        "workspaces",
        # Workspace Studio operational state (keyed by workspaces.id)
        "sessions",
        "connectors",
        "chat_messages",
        "session_state",
        "sync_logs",
        "workspace_audit_logs",
        # agent state (keyed by workspaces.tracking_id)
        "agent_messages",
        "agent_session_snapshots",
        "long_term_memory",
        "token_usage",
        "run_states",
        "spec_workflows",
    ):
        assert f"CREATE TABLE IF NOT EXISTS {table} (" in sql, f"missing table: {table}"


def test_agent_tables_are_keyed_on_workspaces_tracking_id():
    """The agent's `thread_id` IS `workspaces.tracking_id` — see persistence/postgres_agent.py.
    Without the FK, agent history can orphan from its workspace."""
    sql = _sql()
    assert "tracking_id         TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text" in sql
    for table in (
        "agent_messages",
        "agent_session_snapshots",
        "long_term_memory",
        "token_usage",
        "run_states",
        "spec_workflows",
    ):
        block = sql.split(f"CREATE TABLE IF NOT EXISTS {table} (", 1)[1].split(");", 1)[0]
        assert "REFERENCES workspaces(tracking_id) ON DELETE CASCADE" in block, (
            f"{table} must FK into workspaces(tracking_id)"
        )


def test_constraints_the_repositories_depend_on_are_present():
    sql = _sql()
    # SyncService relies on this for batch idempotency.
    assert "uq_sync_logs_batch UNIQUE (workspace_id, client_id, batch_id)" in sql
    # SessionService relies on this to enforce a single live session.
    assert "ux_sessions_one_active_per_workspace" in sql
    # RecoveryService upserts one state row per workspace.
    assert "uq_session_state_workspace UNIQUE (workspace_id)" in sql
    # SpecWorkflowStore's ON CONFLICT target.
    assert "UNIQUE (tracking_id, feature_number)" in sql
    # WorkspaceRepository.create_workspace maps IntegrityError -> DuplicateError.
    assert "ux_workspaces_owner_name_active" in sql


def test_indexes_for_hot_queries_are_present():
    """WorkspaceRepository.list_workspaces filters on (owner_user_id, status)."""
    sql = _sql()
    assert "idx_workspaces_owner_status  ON workspaces(owner_user_id, status)" in sql
    assert "idx_spec_workflows_tracking" in sql
    assert "idx_agent_messages_tracking" in sql


def test_removed_cross_module_coupling_stays_removed():
    """`projects`, `project_id` and `workspace_files` belonged to the DevAccel
    monorepo. Tenancy here is owner_user_id; project scoping is gone for good."""
    sql = _statements()
    assert "REFERENCES public.projects" not in sql
    assert "REFERENCES projects(" not in sql
    assert "workspace_files" not in sql
    assert "project_id" not in sql, "project_id must not come back — tenancy is owner_user_id"


def test_workspaces_are_owned_by_a_user():
    """The tenancy boundary, in the schema."""
    sql = _sql()
    assert "owner_user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE" in sql
    assert "ux_workspaces_owner_name_active" in sql


def test_name_uniqueness_ignores_unnamed_workspaces():
    """`name <> ''` in the partial index is load-bearing, not decoration.

    `workspaces.name` defaults to '' and agent-created workspaces
    (postgres_agent._ensure_thread / claim_thread) never set one. Without this
    predicate '' counts as a name, every user is capped at ONE unnamed
    workspace, and the second agent run on a fresh thread dies with:

        IntegrityError: duplicate key value violates unique constraint
        "ux_workspaces_owner_name_active"
        DETAIL: Key (owner_user_id, lower(name::text))=(6, ) already exists.

    It only ever fired once tenancy moved from project_id (NULL on agent rows,
    and NULLs are distinct) to owner_user_id (always set).
    """
    index = _sql().split("CREATE UNIQUE INDEX IF NOT EXISTS ux_workspaces_owner_name_active", 1)[1]
    predicate = index.split(";", 1)[0]
    assert "name <> ''" in predicate, (
        "the unique index must exclude unnamed workspaces, or agent threads 500"
    )
    # Still scoped to active, non-deleted rows.
    assert "deleted_at IS NULL" in predicate
    assert "status = 'active'" in predicate


def test_legacy_devsphere_prefixed_tables_are_gone():
    """The old names (`devsphere_threads`, `devsphere_spec_workflows`, ...) must
    not reappear — code following them is what caused the original outage."""
    assert "devsphere_" not in _statements()
