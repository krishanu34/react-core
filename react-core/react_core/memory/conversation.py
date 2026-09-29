"""Per-thread conversation history persisted as JSON on disk.

One file per thread under `state_dir/threads/<thread_id>.json`:

    {
      "thread_id": "...",
      "workspace_path": "/abs/path/or/null",
      "messages": [
        {"role": "user", "content": "...", "ts": "..."},
        {"role": "assistant", "content": "...", "ts": "..."}
      ]
    }
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class ConversationMemory:
    def __init__(self, state_dir: str | os.PathLike):
        self._dir = Path(state_dir) / "threads"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, thread_id: str) -> Path:
        if "/" in thread_id or "\\" in thread_id or thread_id in ("..", "."):
            raise ValueError(f"invalid thread_id: {thread_id!r}")
        return self._dir / f"{thread_id}.json"

    def _load(self, thread_id: str) -> dict[str, Any]:
        p = self._path(thread_id)
        if not p.exists():
            return {"thread_id": thread_id, "workspace_path": None, "messages": []}
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"thread_id": thread_id, "workspace_path": None, "messages": []}

    def _save(self, thread_id: str, data: dict[str, Any]) -> None:
        p = self._path(thread_id)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, p)

    def exists(self, thread_id: str) -> bool:
        return self._path(thread_id).exists()

    def get_workspace(self, thread_id: str) -> str | None:
        with self._lock:
            return self._load(thread_id).get("workspace_path")

    def set_workspace(self, thread_id: str, workspace_path: str) -> None:
        with self._lock:
            data = self._load(thread_id)
            data["workspace_path"] = workspace_path
            self._save(thread_id, data)

    def get_project(self, thread_id: str) -> str | None:
        with self._lock:
            return self._load(thread_id).get("project_id")

    def set_project(self, thread_id: str, project_id: str | None) -> None:
        with self._lock:
            data = self._load(thread_id)
            data["project_id"] = project_id
            self._save(thread_id, data)

    def get_messages(self, thread_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._load(thread_id).get("messages", []))

    def add_message(self, thread_id: str, role: str, content: str) -> None:
        with self._lock:
            data = self._load(thread_id)
            data.setdefault("messages", []).append({
                "role": role,
                "content": content,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            self._save(thread_id, data)

    def clear(self, thread_id: str) -> None:
        with self._lock:
            p = self._path(thread_id)
            if p.exists():
                p.unlink()
