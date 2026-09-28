# Workspace Studio Backend

Workspace Studio stores workspace metadata, recovery state, chat/session state,
and sync audit logs. Workspace file trees and file content are client-local:
the browser-linked folder is the source of truth and IndexedDB is only a UI
cache.

## Run Locally

From the repository root as a standalone migrated app:

```powershell
.venv\Scripts\python.exe -m uvicorn devsphere_ai.workspace_studio.main:app --host 0.0.0.0 --port 8003 --reload
```

For the integrated DevSphere AI app used by the workspace frontend:

```powershell
.venv\Scripts\python.exe -m uvicorn devsphere_ai.router.apis:app --host 0.0.0.0 --port 8003 --reload
```

## Database

Workspace Studio has no migrations of its own. The whole product shares ONE
schema file, `db/migrations/001_init.sql` — see `db/README.md`.

The tables owned by this module (`workspaces`, `sessions`, `connectors`,
`chat_messages`, `session_state`, `sync_logs`, `workspace_audit_logs`) are all
defined there and keyed by `workspaces.id`. The app performs no DDL at startup;
apply the schema with `psql "$DATABASE_URL" -f db/migrations/001_init.sql`.

## API

Swagger is generated automatically at `/docs`; ReDoc is available at `/redoc`.
The canonical workspace API root is `/api/workspaces`. File CRUD endpoints are
not mounted; file operations must go through the browser local folder handle.
