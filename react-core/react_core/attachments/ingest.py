"""End-to-end attachment ingestion: extract → chunk → embed → upsert.

Called by the API layer once an upload has been saved and registered in the
App DB. Uses `IndexedSource` fingerprints to skip re-embedding unchanged
content.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from ..app_db import Attachment, IndexedSource, get_app_db
from ..vector_store import VectorDoc, chunk_text, get_vector_store
from .extractors import extract as extract_text

log = logging.getLogger(__name__)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def ingest_attachment(
    attachment: Attachment,
    *,
    org_id: str,
    project_id: Optional[str] = None,
    collection_id: Optional[str] = None,
) -> int:
    """Return the number of chunks written (0 if source was unchanged)."""
    db = get_app_db()
    source_uri = f"attachment:{attachment.id}"

    existing = db.get_indexed_source(source_uri, org_id)
    if existing and existing.fingerprint == attachment.fingerprint:
        log.info("attachment %s already indexed (fingerprint match) — skipping", attachment.id)
        return 0

    if existing is not None:
        # Fingerprint changed — drop the old chunks and re-index.
        store = get_vector_store()
        await store.delete_source(source_uri, org_id)

    try:
        doc = extract_text(attachment.path, filename=attachment.filename)
    except Exception as e:  # noqa: BLE001
        log.error("attachment %s extraction failed: %s", attachment.id, e)
        return 0

    if doc.pages:
        db.mark_attachment_indexed(attachment.id, False)  # will be flipped after upsert
        # Also stamp page count.
        try:
            from ..app_db.sqlite_backend import SqliteAppDB
            if isinstance(db, SqliteAppDB):
                with db._lock, db._conn:  # noqa: SLF001
                    db._conn.execute(
                        "UPDATE attachments SET pages = ? WHERE id = ?",
                        (len(doc.pages), attachment.id),
                    )
        except Exception:  # noqa: BLE001
            pass

    total_written = 0
    store = get_vector_store()
    if doc.pages:
        for page in doc.pages:
            if not page.text.strip():
                continue
            chunks = chunk_text(page.text)
            docs = [
                VectorDoc(
                    text=chunk,
                    org_id=org_id,
                    source=source_uri,
                    project_id=project_id,
                    collection_id=collection_id,
                    page=page.page,
                    chunk_index=i,
                    metadata={
                        "filename": attachment.filename,
                        "attachment_id": attachment.id,
                    },
                )
                for i, chunk in enumerate(chunks)
            ]
            if docs:
                await store.upsert(docs)
                total_written += len(docs)
    else:
        chunks = chunk_text(doc.text)
        docs = [
            VectorDoc(
                text=chunk,
                org_id=org_id,
                source=source_uri,
                project_id=project_id,
                collection_id=collection_id,
                page=None,
                chunk_index=i,
                metadata={
                    "filename": attachment.filename,
                    "attachment_id": attachment.id,
                },
            )
            for i, chunk in enumerate(chunks)
        ]
        if docs:
            await store.upsert(docs)
            total_written += len(docs)

    if total_written > 0:
        db.upsert_indexed_source(
            IndexedSource(
                source=source_uri,
                org_id=org_id,
                project_id=project_id,
                collection_id=collection_id,
                fingerprint=attachment.fingerprint,
                chunk_count=total_written,
                indexed_at=_utcnow(),
            )
        )
    db.mark_attachment_indexed(attachment.id, True)
    return total_written
