"""
Permission Broker — interactive tool approval (Phase 3, ARCHITECTURE_PLAN.md).

Same parked-turn mechanism as client_broker, but for the "ask" permission mode:
when a mutating tool (write/edit/bash/git) is about to run, the agent emits a
`permission_request` event and awaits a Future here. The UI shows an approve /
reject card; the browser POSTs the choice to /api/agent/permission_response,
which resolves the Future so the tool either runs or is skipped.

Decisions: "allow" (once) · "allow_session" (don't ask again this thread) · "deny".
"""

import asyncio
from typing import Dict, Tuple


class PermissionBroker:
    def __init__(self):
        self._futures: Dict[Tuple[str, str], asyncio.Future] = {}

    def create(self, thread_id: str, request_id: str) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._futures[(thread_id, request_id)] = fut
        return fut

    def resolve(self, thread_id: str, request_id: str, decision: str) -> bool:
        fut = self._futures.pop((thread_id, request_id), None)
        if fut is None or fut.done():
            return False
        fut.set_result(decision)
        return True

    def discard(self, thread_id: str, request_id: str) -> None:
        self._futures.pop((thread_id, request_id), None)

    def cancel_thread(self, thread_id: str) -> None:
        """Deny any pending request when the run ends — safe default."""
        for key in [k for k in self._futures if k[0] == thread_id]:
            fut = self._futures.pop(key, None)
            if fut is not None and not fut.done():
                fut.set_result("deny")


# Process-wide singleton.
permission_broker = PermissionBroker()
