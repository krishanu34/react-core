"""App DB — operational data (users, threads, messages, attachments,
credentials, artefacts, vector-chunk metadata).

Design principles
-----------------
1. **One DTO class**: every read/write goes through `AppDBProtocol`. Callers
   never touch a raw SQL cursor — they call `db.get_thread(tid)` or
   `db.upsert_attachment(...)`. Swapping to Postgres later is one new file.
2. **Singleton connection**: `get_app_db()` returns a process-wide singleton.
   Lazy-initialised, thread-safe.
3. **Provider swap by config**: `APP_DB_PROVIDER=sqlite|postgres` in `.env`.
   Today only SQLite exists.
"""
from .base import AppDBProtocol
from .factory import get_app_db, reset_app_db_for_tests
from .models import (
    Artefact,
    Attachment,
    Credential,
    IndexedSource,
    Message,
    Org,
    Project,
    Thread,
    User,
    VectorChunk,
)

__all__ = [
    "AppDBProtocol",
    "Artefact",
    "Attachment",
    "Credential",
    "IndexedSource",
    "Message",
    "Org",
    "Project",
    "Thread",
    "User",
    "VectorChunk",
    "get_app_db",
    "reset_app_db_for_tests",
]
