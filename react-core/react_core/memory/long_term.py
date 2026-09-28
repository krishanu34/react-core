"""Long-term memory: facts persisted across turns and process restarts.

One JSON file per thread under `state_dir/threads/<thread_id>.long_term.json`,
sibling to the conversation file. The agent writes to it via the `remember`
tool; the ReAct loop reads recent entries into each prompt's memory context.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class LongTermMemory:
    def __init__(self, state_dir: str | os.PathLike, thread_id: str):
        if "/" in thread_id or "\\" in thread_id or thread_id in ("..", "."):
            raise ValueError(f"invalid thread_id: {thread_id!r}")
        self._path = Path(state_dir) / "threads" / f"{thread_id}.long_term.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _load_locked(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        return []

    def _save_locked(self, entries: list[dict[str, Any]]) -> None:
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)

    def load(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._load_locked())

    def add(self, content: str, tags: list[str] | None = None) -> dict[str, Any]:
        entry = {
            "content": str(content),
            "tags": list(tags or []),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            entries = self._load_locked()
            entries.append(entry)
            self._save_locked(entries)
        return entry

    def search(self, tag: str) -> list[dict[str, Any]]:
        with self._lock:
            return [e for e in self._load_locked() if tag in (e.get("tags") or [])]

    def clear(self) -> None:
        with self._lock:
            if self._path.exists():
                self._path.unlink()
