"""Hashing helpers used for idempotent sync and conflict detection."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def content_hash(content: str | bytes | None) -> str:
    raw = b"" if content is None else content if isinstance(content, bytes) else content.encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def stable_payload_hash(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

