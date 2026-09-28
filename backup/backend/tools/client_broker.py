"""
Client Tool Broker — Pattern C (see devsphere_ai/ARCHITECTURE_PLAN.md).

Holds one asyncio.Future per in-flight client-side tool call, keyed by
(thread_id, call_id). The flow:

    1. ClientDelegatingTool.run() calls broker.create() and awaits the future.
    2. The orchestrator emits `client_tool_use` over SSE; the browser executes
       the tool locally against its File System Access handle.
    3. The browser POSTs the result to /api/agent/tool_result, which calls
       broker.resolve() — unblocking the awaiting tool so the loop resumes.

Process-wide singleton `broker`. State is in-process, so a thread is pinned to
the worker that started it (fine for now; Phase 7 externalises this to Redis so
any replica can resolve any call).
"""

import asyncio
from typing import Any, Dict, Tuple


class ClientToolBroker:
    def __init__(self):
        self._futures: Dict[Tuple[str, str], asyncio.Future] = {}

    def create(self, thread_id: str, call_id: str) -> asyncio.Future:
        """Register a pending call and return the future to await."""
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._futures[(thread_id, call_id)] = fut
        return fut

    def resolve(self, thread_id: str, call_id: str, output: Any) -> bool:
        """Deliver the client's result. Returns False if the call is unknown
        (e.g. it already timed out and was discarded)."""
        fut = self._futures.pop((thread_id, call_id), None)
        if fut is None or fut.done():
            return False
        fut.set_result(output)
        return True

    def discard(self, thread_id: str, call_id: str) -> None:
        """Drop a call without resolving it (used on timeout)."""
        self._futures.pop((thread_id, call_id), None)

    def cancel_thread(self, thread_id: str) -> None:
        """Unblock every pending call for a thread when its run ends/disconnects,
        so no ClientDelegatingTool is left awaiting forever."""
        for key in [k for k in self._futures if k[0] == thread_id]:
            fut = self._futures.pop(key, None)
            if fut is not None and not fut.done():
                fut.set_result({"error": "Client disconnected before returning a result."})


# Process-wide singleton.
broker = ClientToolBroker()
