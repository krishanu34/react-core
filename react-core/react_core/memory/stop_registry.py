"""Process-wide stop registry for cooperative cancellation."""
from __future__ import annotations

import asyncio
import threading


class StopRegistry:
    """Tracks which threads have been requested to stop.

    `should_stop(thread_id)` is polled by the ReAct loop between steps and
    after every tool call. `request_stop` is called from the /stop endpoint.
    """

    def __init__(self):
        self._stopped: set[str] = set()
        self._lock = threading.Lock()
        self._cond = asyncio.Event()

    def request_stop(self, thread_id: str) -> None:
        with self._lock:
            self._stopped.add(thread_id)

    def clear(self, thread_id: str) -> None:
        with self._lock:
            self._stopped.discard(thread_id)

    def should_stop(self, thread_id: str) -> bool:
        with self._lock:
            return thread_id in self._stopped


stop_registry = StopRegistry()
