"""Per-thread debug recorder.

Writes ONE JSON file per conversation at:
    <state_dir>/debug/threads/<thread_id>.json

Structure:
    {
      "thread_id": "...",
      "created_at": "...",
      "events": [ {kind, ts, ...}, ... ]
    }

Every user turn, thinking step, tool call, tool result, ask_user question,
user answer, final answer, and error is appended in order. Multiple runs on
the same thread keep appending to the same file.

Concurrency
-----------
Uses one `threading.Lock` per thread_id (kept in a module-level dict) so
concurrent runs on the same thread — or multiple SSE events landing at
once — never corrupt the file. Reads happen entirely inside the lock, so
readers always see a consistent snapshot.

Enable / disable
----------------
`REACT_CORE_DEBUG_RECORDING=0` turns it off. Default: on. Per-event size is
capped at `REACT_CORE_DEBUG_MAX_EVENT_KB` (default 256 KB) so runaway tool
outputs can't blow up the file.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _enabled() -> bool:
    return (os.getenv("REACT_CORE_DEBUG_RECORDING") or "1").strip().lower() not in {"0", "false", "no"}


def _max_event_bytes() -> int:
    try:
        return int(float(os.getenv("REACT_CORE_DEBUG_MAX_EVENT_KB", "256")) * 1024)
    except ValueError:
        return 256 * 1024


# module-level per-thread locks
_LOCKS_LOCK = threading.Lock()
_LOCKS: dict[str, threading.Lock] = {}


def _lock_for(thread_id: str) -> threading.Lock:
    with _LOCKS_LOCK:
        lock = _LOCKS.get(thread_id)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[thread_id] = lock
        return lock


class DebugRecorder:
    """Append-only JSON writer for one thread."""

    def __init__(self, state_dir: str | os.PathLike, thread_id: str):
        self.thread_id = thread_id
        self._enabled = _enabled()
        self._path = Path(state_dir) / "debug" / "threads" / f"{thread_id}.json"
        if self._enabled:
            self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def record(self, kind: str, payload: Optional[dict[str, Any]] = None) -> None:
        """Append one event (`kind` + timestamp + payload) to the thread's file."""
        if not self._enabled:
            return
        event: dict[str, Any] = {"kind": kind, "ts": _utcnow()}
        if payload:
            event.update(_shrink(payload, _max_event_bytes()))
        lock = _lock_for(self.thread_id)
        with lock:
            data = self._load_locked()
            data["events"].append(event)
            self._save_locked(data)

    def read_snapshot(self) -> Optional[dict[str, Any]]:
        """Return the current debug JSON (used by the debug endpoint)."""
        if not self._enabled:
            return None
        lock = _lock_for(self.thread_id)
        with lock:
            if not self._path.exists():
                return None
            return self._load_locked()

    def _load_locked(self) -> dict[str, Any]:
        if not self._path.exists():
            return {
                "thread_id": self.thread_id,
                "created_at": _utcnow(),
                "events": [],
            }
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            log.warning("debug file %s corrupt (%s) — starting fresh", self._path, e)
            return {
                "thread_id": self.thread_id,
                "created_at": _utcnow(),
                "events": [],
            }

    def _save_locked(self, data: dict[str, Any]) -> None:
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        os.replace(tmp, self._path)


def _shrink(payload: dict[str, Any], max_bytes: int) -> dict[str, Any]:
    """If a payload serialises above `max_bytes`, truncate its largest strings."""
    try:
        raw = json.dumps(payload, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return {"_repr": repr(payload)[: max_bytes // 2]}
    if len(raw.encode("utf-8")) <= max_bytes:
        return payload
    return _truncate_strings(payload, max_bytes)


def _truncate_strings(obj: Any, max_bytes: int) -> Any:
    """Replace long strings with `<...N chars omitted>` markers, in place."""
    limit = max(512, max_bytes // 16)
    if isinstance(obj, str):
        if len(obj) > limit:
            return obj[:limit] + f"... <{len(obj) - limit} chars omitted>"
        return obj
    if isinstance(obj, dict):
        return {k: _truncate_strings(v, max_bytes) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_truncate_strings(x, max_bytes) for x in obj]
    return obj
