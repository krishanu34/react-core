"""SQLite implementation of AppDBProtocol.

Notes for future maintainers
----------------------------
* One connection per process, guarded by an `RLock`. SQLite handles a single
  writer at a time; the lock keeps writes serialised inside the process.
  For multiple worker processes on the same file, WAL mode gives us
  concurrent readers + one writer per process safely.
* We store timestamps as ISO-8601 UTC strings (portable, human-readable).
* JSON columns are just TEXT with json.dumps/loads bookends.
* Credentials are stored as plaintext for MVP. Wire encryption in the same
  method (`upsert_credential`) once `DATABASE_ENCRYPTION_KEY` is available.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .base import AppDBProtocol
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

_DEFAULT_ORG_ID = "org-default"
_DEFAULT_USER_ID = "admin"
_DEFAULT_PROJECT_ID = "1"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  auth_type TEXT NOT NULL DEFAULT 'bearer',
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider, base_url)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_projects_org ON projects(org_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT,
  workspace_path TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_threads_user ON threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  thread_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  pages INTEGER,
  indexed INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_attachments_org ON attachments(org_id);
CREATE INDEX IF NOT EXISTS ix_attachments_thread ON attachments(thread_id);

CREATE TABLE IF NOT EXISTS artefacts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_artefacts_thread ON artefacts(thread_id);

CREATE TABLE IF NOT EXISTS vector_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT,
  collection_id TEXT,
  page INTEGER,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_vc_source ON vector_chunks(source);
CREATE INDEX IF NOT EXISTS ix_vc_org ON vector_chunks(org_id, project_id);

CREATE TABLE IF NOT EXISTS indexed_sources (
  source TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT,
  collection_id TEXT,
  fingerprint TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (source, org_id)
);
"""


class SqliteAppDB(AppDBProtocol):
    def __init__(self, db_path: str | Path):
        self._path = str(db_path)
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # `check_same_thread=False` — we serialise via our own lock so we can
        # share one connection across the FastAPI event loop threads.
        self._conn = sqlite3.connect(
            self._path,
            check_same_thread=False,
            isolation_level=None,  # autocommit; we manage transactions explicitly.
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._conn.execute("PRAGMA busy_timeout=5000;")
        self._bootstrap_schema()
        self._seed_defaults()

    # ---- lifecycle -------------------------------------------------------
    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def ping(self) -> bool:
        try:
            with self._lock:
                self._conn.execute("SELECT 1;")
            return True
        except Exception:  # noqa: BLE001
            return False

    def _bootstrap_schema(self) -> None:
        with self._lock:
            self._conn.executescript(_SCHEMA)

    def _seed_defaults(self) -> None:
        # MVP: no auth. Ensure a default org + admin user exist so every write
        # can be scoped without the UI needing to send identities.
        with self._lock:
            now = _utcnow()
            org = self._conn.execute("SELECT id FROM orgs WHERE id = ?", (_DEFAULT_ORG_ID,)).fetchone()
            if org is None:
                self._conn.execute(
                    "INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)",
                    (_DEFAULT_ORG_ID, "Default Org", now),
                )
            user = self._conn.execute("SELECT id FROM users WHERE id = ?", (_DEFAULT_USER_ID,)).fetchone()
            if user is None:
                self._conn.execute(
                    "INSERT INTO users (id, org_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
                    (_DEFAULT_USER_ID, _DEFAULT_ORG_ID, "Admin", None, now),
                )
            # Pilot: seed a default project so runs are scoped without the user
            # having to create or pick one.
            proj = self._conn.execute("SELECT id FROM projects WHERE id = ?", (_DEFAULT_PROJECT_ID,)).fetchone()
            if proj is None:
                self._conn.execute(
                    "INSERT INTO projects (id, org_id, name, description, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (_DEFAULT_PROJECT_ID, _DEFAULT_ORG_ID, "Default Project", None, now, now),
                )

    # ---- orgs / users ----------------------------------------------------
    def get_default_org(self) -> Org:
        row = self._one("SELECT * FROM orgs WHERE id = ?", (_DEFAULT_ORG_ID,))
        assert row is not None, "default org missing — seed failed"
        return _row_to_org(row)

    def get_default_user(self) -> User:
        row = self._one("SELECT * FROM users WHERE id = ?", (_DEFAULT_USER_ID,))
        assert row is not None, "default user missing — seed failed"
        return _row_to_user(row)

    def get_org(self, org_id: str) -> Optional[Org]:
        row = self._one("SELECT * FROM orgs WHERE id = ?", (org_id,))
        return _row_to_org(row) if row else None

    def get_user(self, user_id: str) -> Optional[User]:
        row = self._one("SELECT * FROM users WHERE id = ?", (user_id,))
        return _row_to_user(row) if row else None

    # ---- credentials -----------------------------------------------------
    def upsert_credential(self, cred: Credential) -> Credential:
        now = _utcnow()
        cred_id = cred.id or _uid("cred")
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO user_credentials (
                  id, user_id, team_id, provider, base_url, token, refresh_token,
                  expires_at, auth_type, email, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, provider, base_url) DO UPDATE SET
                  token=excluded.token,
                  refresh_token=excluded.refresh_token,
                  expires_at=excluded.expires_at,
                  auth_type=excluded.auth_type,
                  email=excluded.email,
                  updated_at=excluded.updated_at
                """,
                (
                    cred_id, cred.user_id, cred.team_id, cred.provider, cred.base_url,
                    cred.token, cred.refresh_token, cred.expires_at, cred.auth_type,
                    cred.email, cred.created_at or now, now,
                ),
            )
        row = self._one(
            "SELECT * FROM user_credentials WHERE user_id = ? AND provider = ? AND base_url = ?",
            (cred.user_id, cred.provider, cred.base_url),
        )
        assert row is not None
        return _row_to_credential(row)

    def get_credential(
        self, user_id: str, provider: str, base_url: Optional[str] = None
    ) -> Optional[Credential]:
        if base_url:
            row = self._one(
                "SELECT * FROM user_credentials WHERE user_id = ? AND provider = ? AND base_url = ?",
                (user_id, provider, base_url),
            )
        else:
            row = self._one(
                "SELECT * FROM user_credentials WHERE user_id = ? AND provider = ? ORDER BY updated_at DESC LIMIT 1",
                (user_id, provider),
            )
        return _row_to_credential(row) if row else None

    def list_credentials(self, user_id: str) -> list[Credential]:
        rows = self._all(
            "SELECT * FROM user_credentials WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        )
        return [_row_to_credential(r) for r in rows]

    def delete_credential(self, credential_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM user_credentials WHERE id = ?", (credential_id,))
        return cur.rowcount > 0

    # ---- projects --------------------------------------------------------
    def get_default_project(self) -> Project:
        row = self._one("SELECT * FROM projects WHERE id = ?", (_DEFAULT_PROJECT_ID,))
        assert row is not None, "default project missing — seed failed"
        return _row_to_project(row)

    def create_project(self, project: Project) -> Project:
        now = _utcnow()
        pid = project.id or _uid("proj")
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO projects (id, org_id, name, description, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name,
                  description=excluded.description,
                  updated_at=excluded.updated_at
                """,
                (pid, project.org_id, project.name, project.description,
                 project.created_at or now, now),
            )
        row = self._one("SELECT * FROM projects WHERE id = ?", (pid,))
        assert row is not None
        return _row_to_project(row)

    def get_project(self, project_id: str) -> Optional[Project]:
        row = self._one("SELECT * FROM projects WHERE id = ?", (project_id,))
        return _row_to_project(row) if row else None

    def list_projects(self, org_id: str) -> list[Project]:
        rows = self._all(
            "SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC",
            (org_id,),
        )
        return [_row_to_project(r) for r in rows]

    def delete_project(self, project_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return cur.rowcount > 0

    # ---- threads / messages ----------------------------------------------
    def upsert_thread(self, thread: Thread) -> Thread:
        now = _utcnow()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO threads (id, org_id, user_id, project_id, workspace_path, title, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  workspace_path=excluded.workspace_path,
                  title=COALESCE(excluded.title, threads.title),
                  updated_at=excluded.updated_at
                """,
                (
                    thread.id, thread.org_id, thread.user_id, thread.project_id,
                    thread.workspace_path, thread.title, thread.created_at or now, now,
                ),
            )
        row = self._one("SELECT * FROM threads WHERE id = ?", (thread.id,))
        assert row is not None
        return _row_to_thread(row)

    def get_thread(self, thread_id: str) -> Optional[Thread]:
        row = self._one("SELECT * FROM threads WHERE id = ?", (thread_id,))
        return _row_to_thread(row) if row else None

    def list_threads(self, user_id: str, limit: int = 50) -> list[Thread]:
        rows = self._all(
            "SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
            (user_id, limit),
        )
        return [_row_to_thread(r) for r in rows]

    def add_message(self, msg: Message) -> Message:
        msg_id = msg.id or _uid("msg")
        created_at = msg.created_at or _utcnow()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (msg_id, msg.thread_id, msg.role, msg.content, created_at),
            )
            self._conn.execute(
                "UPDATE threads SET updated_at = ? WHERE id = ?",
                (created_at, msg.thread_id),
            )
        return Message(id=msg_id, thread_id=msg.thread_id, role=msg.role, content=msg.content, created_at=created_at)

    def get_messages(self, thread_id: str) -> list[Message]:
        rows = self._all(
            "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
            (thread_id,),
        )
        return [_row_to_message(r) for r in rows]

    # ---- attachments -----------------------------------------------------
    def upsert_attachment(self, att: Attachment) -> Attachment:
        att_id = att.id or _uid("att")
        created_at = att.created_at or _utcnow()
        with self._lock, self._conn:
            try:
                self._conn.execute(
                    """
                    INSERT INTO attachments
                      (id, org_id, thread_id, filename, mime, size, path, pages, indexed, fingerprint, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        att_id, att.org_id, att.thread_id, att.filename, att.mime,
                        att.size, att.path, att.pages, int(att.indexed),
                        att.fingerprint, created_at,
                    ),
                )
            except sqlite3.IntegrityError:
                # Same fingerprint under same org — reuse the existing row.
                row = self._one(
                    "SELECT * FROM attachments WHERE org_id = ? AND fingerprint = ?",
                    (att.org_id, att.fingerprint),
                )
                assert row is not None
                return _row_to_attachment(row)
        row = self._one("SELECT * FROM attachments WHERE id = ?", (att_id,))
        assert row is not None
        return _row_to_attachment(row)

    def get_attachment(self, attachment_id: str) -> Optional[Attachment]:
        row = self._one("SELECT * FROM attachments WHERE id = ?", (attachment_id,))
        return _row_to_attachment(row) if row else None

    def get_attachment_by_fingerprint(
        self, org_id: str, fingerprint: str
    ) -> Optional[Attachment]:
        row = self._one(
            "SELECT * FROM attachments WHERE org_id = ? AND fingerprint = ?",
            (org_id, fingerprint),
        )
        return _row_to_attachment(row) if row else None

    def list_attachments(
        self, org_id: str, thread_id: Optional[str] = None
    ) -> list[Attachment]:
        if thread_id is None:
            rows = self._all(
                "SELECT * FROM attachments WHERE org_id = ? ORDER BY created_at DESC",
                (org_id,),
            )
        else:
            rows = self._all(
                "SELECT * FROM attachments WHERE org_id = ? AND thread_id = ? ORDER BY created_at DESC",
                (org_id, thread_id),
            )
        return [_row_to_attachment(r) for r in rows]

    def mark_attachment_indexed(self, attachment_id: str, indexed: bool) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE attachments SET indexed = ? WHERE id = ?",
                (int(indexed), attachment_id),
            )

    # ---- artefacts -------------------------------------------------------
    def add_artefact(self, art: Artefact) -> Artefact:
        art_id = art.id or _uid("art")
        created_at = art.created_at or _utcnow()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO artefacts
                  (id, thread_id, org_id, project_id, kind, name, path, size, approved_by, approved_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    art_id, art.thread_id, art.org_id, art.project_id,
                    art.kind, art.name, art.path, art.size,
                    art.approved_by, art.approved_at, created_at,
                ),
            )
        row = self._one("SELECT * FROM artefacts WHERE id = ?", (art_id,))
        assert row is not None
        return _row_to_artefact(row)

    def list_artefacts(self, thread_id: str) -> list[Artefact]:
        rows = self._all(
            "SELECT * FROM artefacts WHERE thread_id = ? ORDER BY created_at ASC",
            (thread_id,),
        )
        return [_row_to_artefact(r) for r in rows]

    def approve_artefact(self, artefact_id: str, approver: str) -> Optional[Artefact]:
        now = _utcnow()
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE artefacts SET approved_by = ?, approved_at = ? WHERE id = ?",
                (approver, now, artefact_id),
            )
            if cur.rowcount == 0:
                return None
        row = self._one("SELECT * FROM artefacts WHERE id = ?", (artefact_id,))
        return _row_to_artefact(row) if row else None

    # ---- vector-chunk metadata ------------------------------------------
    def add_vector_chunks(self, chunks: list[VectorChunk]) -> list[int]:
        if not chunks:
            return []
        now = _utcnow()
        ids: list[int] = []
        with self._lock, self._conn:
            for c in chunks:
                cur = self._conn.execute(
                    """
                    INSERT INTO vector_chunks
                      (source, org_id, project_id, collection_id, page, chunk_index, text, metadata_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        c.source, c.org_id, c.project_id, c.collection_id,
                        c.page, c.chunk_index, c.text, json.dumps(c.metadata or {}),
                        c.created_at or now,
                    ),
                )
                ids.append(int(cur.lastrowid))
        return ids

    def get_vector_chunks_by_ids(self, ids: list[int]) -> list[VectorChunk]:
        if not ids:
            return []
        placeholders = ",".join(["?"] * len(ids))
        rows = self._all(
            f"SELECT * FROM vector_chunks WHERE id IN ({placeholders})",
            tuple(ids),
        )
        # Preserve caller ordering.
        by_id = {r["id"]: _row_to_chunk(r) for r in rows}
        return [by_id[i] for i in ids if i in by_id]

    def delete_vector_chunks_by_source(self, source: str, org_id: str) -> int:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "DELETE FROM vector_chunks WHERE source = ? AND org_id = ?",
                (source, org_id),
            )
        return cur.rowcount

    def list_chunk_ids(
        self,
        org_id: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> list[int]:
        clauses: list[str] = []
        params: list = []
        if org_id is not None:
            clauses.append("org_id = ?")
            params.append(org_id)
        if project_id is not None:
            clauses.append("project_id = ?")
            params.append(project_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._all(f"SELECT id FROM vector_chunks{where}", tuple(params))
        return [int(r["id"]) for r in rows]

    # ---- indexed sources -------------------------------------------------
    def get_indexed_source(self, source: str, org_id: str) -> Optional[IndexedSource]:
        row = self._one(
            "SELECT * FROM indexed_sources WHERE source = ? AND org_id = ?",
            (source, org_id),
        )
        return _row_to_indexed_source(row) if row else None

    def upsert_indexed_source(self, src: IndexedSource) -> IndexedSource:
        indexed_at = src.indexed_at or _utcnow()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO indexed_sources
                  (source, org_id, project_id, collection_id, fingerprint, chunk_count, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source, org_id) DO UPDATE SET
                  project_id=excluded.project_id,
                  collection_id=excluded.collection_id,
                  fingerprint=excluded.fingerprint,
                  chunk_count=excluded.chunk_count,
                  indexed_at=excluded.indexed_at
                """,
                (
                    src.source, src.org_id, src.project_id, src.collection_id,
                    src.fingerprint, src.chunk_count, indexed_at,
                ),
            )
        row = self._one(
            "SELECT * FROM indexed_sources WHERE source = ? AND org_id = ?",
            (src.source, src.org_id),
        )
        assert row is not None
        return _row_to_indexed_source(row)

    def delete_indexed_source(self, source: str, org_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "DELETE FROM indexed_sources WHERE source = ? AND org_id = ?",
                (source, org_id),
            )
        return cur.rowcount > 0

    def list_indexed_sources(
        self, org_id: str, project_id: Optional[str] = None
    ) -> list[IndexedSource]:
        if project_id is None:
            rows = self._all(
                "SELECT * FROM indexed_sources WHERE org_id = ? ORDER BY indexed_at DESC",
                (org_id,),
            )
        else:
            rows = self._all(
                "SELECT * FROM indexed_sources WHERE org_id = ? AND project_id = ? ORDER BY indexed_at DESC",
                (org_id, project_id),
            )
        return [_row_to_indexed_source(r) for r in rows]

    # ---- internals -------------------------------------------------------
    def _one(self, sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def _all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._conn.execute(sql, params).fetchall())


# ---- row → dataclass converters -----------------------------------------

def _row_to_org(r: sqlite3.Row) -> Org:
    return Org(id=r["id"], name=r["name"], created_at=r["created_at"])


def _row_to_user(r: sqlite3.Row) -> User:
    return User(
        id=r["id"], org_id=r["org_id"], name=r["name"],
        email=r["email"], created_at=r["created_at"],
    )


def _row_to_credential(r: sqlite3.Row) -> Credential:
    return Credential(
        id=r["id"], user_id=r["user_id"], team_id=r["team_id"],
        provider=r["provider"], base_url=r["base_url"], token=r["token"],
        refresh_token=r["refresh_token"], expires_at=r["expires_at"],
        auth_type=r["auth_type"] or "bearer", email=r["email"],
        created_at=r["created_at"], updated_at=r["updated_at"],
    )


def _row_to_project(r: sqlite3.Row) -> Project:
    return Project(
        id=r["id"], org_id=r["org_id"], name=r["name"],
        description=r["description"], created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def _row_to_thread(r: sqlite3.Row) -> Thread:
    return Thread(
        id=r["id"], org_id=r["org_id"], user_id=r["user_id"],
        project_id=r["project_id"], workspace_path=r["workspace_path"],
        title=r["title"], created_at=r["created_at"], updated_at=r["updated_at"],
    )


def _row_to_message(r: sqlite3.Row) -> Message:
    return Message(
        id=r["id"], thread_id=r["thread_id"], role=r["role"],
        content=r["content"], created_at=r["created_at"],
    )


def _row_to_attachment(r: sqlite3.Row) -> Attachment:
    return Attachment(
        id=r["id"], org_id=r["org_id"], thread_id=r["thread_id"],
        filename=r["filename"], mime=r["mime"], size=int(r["size"]),
        path=r["path"], pages=r["pages"], indexed=bool(r["indexed"]),
        fingerprint=r["fingerprint"], created_at=r["created_at"],
    )


def _row_to_artefact(r: sqlite3.Row) -> Artefact:
    return Artefact(
        id=r["id"], thread_id=r["thread_id"], org_id=r["org_id"],
        project_id=r["project_id"], kind=r["kind"], name=r["name"],
        path=r["path"], size=r["size"],
        approved_by=r["approved_by"], approved_at=r["approved_at"],
        created_at=r["created_at"],
    )


def _row_to_chunk(r: sqlite3.Row) -> VectorChunk:
    return VectorChunk(
        id=int(r["id"]), source=r["source"], org_id=r["org_id"],
        project_id=r["project_id"], collection_id=r["collection_id"],
        page=r["page"], chunk_index=int(r["chunk_index"]), text=r["text"],
        metadata=json.loads(r["metadata_json"] or "{}"),
        created_at=r["created_at"] or "",
    )


def _row_to_indexed_source(r: sqlite3.Row) -> IndexedSource:
    return IndexedSource(
        source=r["source"], org_id=r["org_id"], project_id=r["project_id"],
        collection_id=r["collection_id"], fingerprint=r["fingerprint"],
        chunk_count=int(r["chunk_count"]), indexed_at=r["indexed_at"],
    )
