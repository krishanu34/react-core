"""Attachment storage: save uploads to disk, register in App DB.

Attachments are ORG-owned (per architectural decision — indefinite retention,
queryable across all threads in the org). Layout under `state_dir`:

    state_dir/orgs/<org_id>/attachments/<attachment_id>/<safe_filename>

Fingerprint (sha256 of bytes) drives dedup: uploading the same file twice
returns the existing `Attachment` row.
"""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..app_db import Attachment, get_app_db

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(slots=True)
class AttachmentIn:
    filename: str
    content_type: Optional[str]
    data: bytes


def save_upload(
    *,
    org_id: str,
    thread_id: Optional[str],
    upload: AttachmentIn,
    state_dir: Path,
) -> Attachment:
    """Persist bytes on disk + register in App DB. Idempotent by fingerprint."""
    fingerprint = hashlib.sha256(upload.data).hexdigest()
    db = get_app_db()

    existing = db.get_attachment_by_fingerprint(org_id, fingerprint)
    if existing is not None:
        return existing

    attachment_id = f"att-{uuid.uuid4().hex[:12]}"
    root = state_dir / "orgs" / org_id / "attachments" / attachment_id
    root.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_filename(upload.filename)
    dest = root / safe_name
    dest.write_bytes(upload.data)

    row = Attachment(
        id=attachment_id,
        org_id=org_id,
        thread_id=thread_id,
        filename=safe_name,
        mime=upload.content_type or _guess_mime(safe_name),
        size=len(upload.data),
        path=str(dest),
        pages=None,
        indexed=False,
        fingerprint=fingerprint,
        created_at="",
    )
    return db.upsert_attachment(row)


def _safe_filename(name: str) -> str:
    base = os.path.basename(name or "attachment")
    cleaned = _SAFE.sub("_", base).strip("._")
    if not cleaned:
        cleaned = "attachment"
    return cleaned[:200]


def _guess_mime(name: str) -> Optional[str]:
    ext = os.path.splitext(name)[1].lower()
    return {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".html": "text/html",
        ".htm": "text/html",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".json": "application/json",
    }.get(ext)
