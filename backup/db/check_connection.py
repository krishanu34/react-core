"""
Diagnose a database problem in one command.

    python db/check_connection.py          # from devsphere_ai/

Written for the failure that looks like a schema bug and is not:

    OperationalError: server closed the connection unexpectedly

That message means the socket died, NOT that a table or column is missing — a
missing table raises UndefinedTable, a missing column UndefinedColumn, and a
NOT NULL violation IntegrityError. Before editing any schema, run this: it walks
the connection from DNS outward and stops at the first layer that is actually
broken, so you fix that layer instead of guessing.

    [1] DNS    — name resolves?          fails → wrong DB_HOST, or no DNS
    [2] TCP    — port 5432 reachable?    fails → server stopped, or firewall
    [3] LOGIN  — credentials + SSL?      fails → password, or sslmode
    [4] SCHEMA — the 14 tables present?  fails → migrations never ran

Prints no credentials. Read-only — it writes nothing.
Exit code 0 = healthy, 1 = the printed layer failed.
"""

from __future__ import annotations

import os
import socket
import sys
import time
from pathlib import Path

# The connection settings live with the backend that uses them.
_ENV = Path(__file__).resolve().parent.parent / "backend" / ".env"

# Exactly what 001_init.sql creates. A live database may hold MORE than this —
# tables left behind by removed features are harmless — but never fewer.
EXPECTED_TABLES = {
    "users", "workspaces", "sessions", "connectors", "chat_messages",
    "session_state", "sync_logs", "workspace_audit_logs", "agent_messages",
    "agent_session_snapshots", "long_term_memory", "token_usage",
    "run_states", "spec_workflows",
}


def fail(step: str, err: Exception | str, hint: str) -> None:
    print(f"[{step}] FAIL  {type(err).__name__}: {err}" if isinstance(err, Exception)
          else f"[{step}] FAIL  {err}")
    print(f"      -> {hint}")
    sys.exit(1)


def main() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        print("python-dotenv not installed — run from the backend venv.")
        sys.exit(1)

    if not _ENV.exists():
        fail("ENV", f"{_ENV} not found", "cp backend/.env.example backend/.env and fill in DB_*")
    load_dotenv(_ENV)

    host = os.getenv("DB_HOST", "localhost")
    port = int(os.getenv("DB_PORT", "5432"))
    name = os.getenv("DB_NAME", "devsphere")
    user = os.getenv("DB_USER", "postgres")
    password = os.getenv("DB_PASSWORD", "")
    is_local = host in ("localhost", "127.0.0.1")
    sslmode = os.getenv("DB_SSL_MODE") or ("disable" if is_local else "require")

    print(f"target: {user}@{host}:{port}/{name}  sslmode={sslmode}\n")

    # [1] DNS
    try:
        ip = socket.gethostbyname(host)
        print(f"[1] DNS    OK    {host} -> {ip}")
    except Exception as e:
        fail("1] DNS", e, "DB_HOST is wrong, or this machine has no DNS route to it")

    # [2] TCP
    t0 = time.time()
    try:
        socket.create_connection((host, port), timeout=10).close()
        print(f"[2] TCP    OK    port {port} reachable ({round((time.time() - t0) * 1000)} ms)")
    except Exception as e:
        fail("2] TCP", e,
             "the server is stopped (Azure Flexible Server auto-stops), or its "
             "firewall does not allow this client's IP")

    # [3] LOGIN
    try:
        import psycopg2
    except ImportError:
        fail("3] LOGIN", "psycopg2 not installed", "pip install -r backend/requirements.txt")

    try:
        conn = psycopg2.connect(
            host=host, port=port, dbname=name, user=user, password=password,
            sslmode=sslmode, connect_timeout=10,
        )
    except Exception as e:
        fail("3] LOGIN", e,
             "wrong DB_USER/DB_PASSWORD/DB_NAME, or SSL is required and DB_SSL_MODE says otherwise")

    cur = conn.cursor()
    cur.execute("SELECT version(), current_database(), current_user")
    version, db, who = cur.fetchone()
    print(f"[3] LOGIN  OK    {who}@{db} — {version.split(',')[0]}")

    # [4] SCHEMA
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' ORDER BY table_name"
    )
    live = {r[0] for r in cur.fetchall()}
    missing = EXPECTED_TABLES - live
    extra = live - EXPECTED_TABLES

    if missing:
        print(f"[4] SCHEMA FAIL  missing {len(missing)}: {', '.join(sorted(missing))}")
        print("      -> migrations were never applied:")
        print("         psql \"$ADMIN_URL\" -f db/migrations/001_init.sql")
        print("         psql \"$ADMIN_URL\" -f db/migrations/002_grants.sql")
        conn.close()
        sys.exit(1)

    print(f"[4] SCHEMA OK    all {len(EXPECTED_TABLES)} tables present")
    if extra:
        print(f"      note: {len(extra)} table(s) not in 001_init.sql "
              f"({', '.join(sorted(extra))}) — leftovers from removed features, harmless")

    # 003 changed this index's predicate. Without it, a user's SECOND unnamed
    # (agent-created) workspace fails with a duplicate-key error mid-run.
    cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_workspaces_owner_name_active'")
    row = cur.fetchone()
    if row and "name)::text <> ''" in row[0]:
        print("[5] 003    OK    unnamed-workspace index predicate applied")
    elif row:
        print("[5] 003    STALE unnamed-workspace fix NOT applied")
        print("      -> psql \"$ADMIN_URL\" -f db/migrations/003_unnamed_workspaces.sql")
    else:
        print("[5] 003    WARN  ux_workspaces_owner_name_active index not found")

    # The app role must not be able to create tables — see README §5.
    cur.execute("SELECT has_schema_privilege(current_user, 'public', 'CREATE')")
    if cur.fetchone()[0]:
        print("[6] GRANTS WARN  app role HAS CREATE on public — it should not (README §4)")
    else:
        print("[6] GRANTS OK    app role has no CREATE on public")

    cur.execute("SELECT count(*) FROM workspaces")
    print(f"\nhealthy — workspaces rows: {cur.fetchone()[0]}")
    conn.close()


if __name__ == "__main__":
    main()
