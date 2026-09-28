"""
Gate Broker — parked-turn approval between spec phases.

Exactly the same mechanism as tools/permission_broker.py: one asyncio.Future
per pending gate, keyed by (thread_id, gate_id). The flow:

    1. SpecWorkflow finishes a phase and emits a `gate_request` SSE event.
    2. It awaits the future created here (with a timeout).
    3. The UI shows an approval card; the client POSTs the decision to
       /api/agent/gate_response, which resolves the future.
    4. Multi-worker: if the POST lands on another worker, the router relays
       the decision over the signal bus (kind "gate") and the worker holding
       the future resolves it locally — same as permission responses.

Decisions carried in the future's result:
    {"decision": "approve" | "revise" | "abort", "feedback": "..."}
"""

import asyncio
from typing import Dict, Optional, Tuple


class GateBroker:
    def __init__(self):
        self._futures: Dict[Tuple[str, str], asyncio.Future] = {}

    def create(self, thread_id: str, gate_id: str) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._futures[(thread_id, gate_id)] = fut
        return fut

    def resolve(self, thread_id: str, gate_id: str, decision: str,
                feedback: Optional[str] = None) -> bool:
        """Deliver the user's gate decision. False if the gate is unknown
        (timed out, workflow ended, or already answered)."""
        fut = self._futures.pop((thread_id, gate_id), None)
        if fut is None or fut.done():
            return False
        fut.set_result({"decision": decision, "feedback": feedback or ""})
        return True

    def discard(self, thread_id: str, gate_id: str) -> None:
        self._futures.pop((thread_id, gate_id), None)

    def has_pending(self, thread_id: str) -> bool:
        """True when a workflow is parked at a gate for this thread — the
        stream teardown must then KEEP the workflow alive: the decision
        arrives via POST /gate_response even without a live stream."""
        return any(k[0] == thread_id and not f.done()
                   for k, f in self._futures.items())

    def cancel_thread(self, thread_id: str) -> None:
        """Abort any pending gate. Only called when the run is genuinely
        over — stream teardown SKIPS this while a gate is parked (see
        agent_stream's finally), otherwise a transient disconnect would
        silently abort the workflow the user is still reviewing."""
        for key in [k for k in self._futures if k[0] == thread_id]:
            fut = self._futures.pop(key, None)
            if fut is not None and not fut.done():
                fut.set_result({"decision": "abort", "feedback": "stream closed"})


# Process-wide singleton (same pattern as permission_broker).
gate_broker = GateBroker()
