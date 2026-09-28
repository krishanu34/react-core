"""
Stop & Resume Registry

Backs POST /api/agent/stop AND POST /api/agent/resume. Manages two
things per thread_id:

  1. A cancellation flag (the original stop mechanism) - so a running
     agent loop can check should_stop() between steps and wind down
     gracefully at a clean boundary.

  2. A partial-state snapshot (new for resume) - when a run is stopped,
     the orchestrator saves where it got to (which route was taken,
     how far through the plan, what the last answer was) so a later
     /resume call can pick up from there instead of starting over.

Why cooperative stop (flag) instead of asyncio.Task.cancel()?
Because cancelling a Task mid-await can interrupt things at an
arbitrary point - mid-tool-call, mid-file-write, mid-HTTP-request.
The agents check should_stop() at clean boundaries (between LLM
calls, never inside one), so we always cancel between steps, never
mid-step.

Why save partial state instead of just re-running?
Because complex_task runs can take many LLM calls (plan + N steps).
If the user stops at step 3 of 7, re-running from scratch wastes
the tokens and time already spent on steps 1-3. Saving the partial
state lets resume pick up at step 4.
"""

import threading
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, List, Optional


@dataclass
class RunState:
    """
    Snapshot of a run's progress at the moment it was stopped.

    This captures enough context for the orchestrator to resume from
    where it left off rather than re-running the entire task:

      route:           which classification path was taken
                       ("direct", "simple_task", "complex_task")
      original_input:  the user's original message (needed to resume
                       the same task)
      memory_context:  the memory_context string at run start
      plan:            the full plan (only for complex_task route)
      completed_steps: results from plan steps that already finished
      current_step_id: which step was being executed when stopped
      partial_answer:  any answer text accumulated so far
      usage:           token usage at stop time (so resume can add to
                       it rather than losing the count)
    """
    route: str = ""
    original_input: str = ""
    memory_context: str = ""
    plan: Optional[Dict] = None
    completed_steps: List[Dict] = field(default_factory=list)
    current_step_id: Optional[int] = None
    partial_answer: str = ""
    usage: Dict[str, int] = field(default_factory=lambda: {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
    })

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> "RunState":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in (data or {}).items() if k in known})


class StopRegistry:
    """
    Thread-safe store of cancellation flags + partial state, one per
    thread_id that currently has (or recently had) an active run.

    Thread safety uses a plain threading.Lock because FastAPI may run
    sync and async code on different threads under the hood.

    state_store — optional durable backend for the partial-run state
    (e.g. persistence.postgres_agent.PostgresRunStateStore, storing
    dicts). When provided, a stopped run survives server restarts and
    can be resumed from ANY worker/replica. Without it, state lives in
    this process's memory (original single-worker behaviour).
    """

    def __init__(self, state_store=None):
        # _flags: thread_id -> bool (True = stop requested)
        self._flags: Dict[str, bool] = {}
        # _states: thread_id -> RunState (saved when a run is stopped,
        # consumed when a run is resumed). In-memory fallback only —
        # unused when state_store is provided.
        self._states: Dict[str, RunState] = {}
        self._state_store = state_store
        self._lock = threading.Lock()

    # ── Lifecycle: start / finish a run ──────────────────────────

    def start(self, thread_id: str):
        """Call when a run begins. Creates the cancellation flag."""
        with self._lock:
            self._flags[thread_id] = False

    def finish(self, thread_id: str):
        """
        Call when a run ends normally (not stopped). Cleans up the
        flag AND any saved state - if the run finished on its own,
        there's nothing to resume.
        """
        with self._lock:
            self._flags.pop(thread_id, None)
            # Don't clear _states here - a stopped run's state should
            # survive until it's either resumed or explicitly cleared.

    # ── Stop: request + check ────────────────────────────────────

    def request_stop(self, thread_id: str) -> bool:
        """
        Flip the stop flag for thread_id. Returns True if a run was
        actually found and flagged, False if thread_id had no active
        run (e.g. already finished, or never started).
        """
        with self._lock:
            if thread_id not in self._flags:
                return False
            self._flags[thread_id] = True
            return True

    def should_stop(self, thread_id: str) -> bool:
        """The callable agents poll between steps."""
        with self._lock:
            return self._flags.get(thread_id, False)

    def is_active(self, thread_id: str) -> bool:
        """True if thread_id has a currently running (not finished) run."""
        with self._lock:
            return thread_id in self._flags

    # ── Resume: save + retrieve partial state ────────────────────

    def save_state(self, thread_id: str, state: RunState):
        """
        Called by the orchestrator when a run is stopped, to save
        where it got to. This state persists until consumed by
        resume or explicitly cleared.
        """
        if self._state_store is not None:
            self._state_store.save(thread_id, state.to_dict())
            with self._lock:
                self._flags.pop(thread_id, None)
            return
        with self._lock:
            self._states[thread_id] = state
            # Clean up the stop flag since the run is now over
            self._flags.pop(thread_id, None)

    def get_saved_state(self, thread_id: str) -> Optional[RunState]:
        """
        Peek at saved state without consuming it. Used by the
        /resume endpoint to check if there's anything to resume
        before starting.
        """
        if self._state_store is not None:
            data = self._state_store.peek(thread_id)
            return RunState.from_dict(data) if data else None
        with self._lock:
            return self._states.get(thread_id)

    def consume_saved_state(self, thread_id: str) -> Optional[RunState]:
        """
        Retrieve AND remove saved state. Called when a resume
        actually starts, so the same state can't be resumed twice.
        Returns None if there's nothing to resume.
        """
        if self._state_store is not None:
            data = self._state_store.consume(thread_id)
            return RunState.from_dict(data) if data else None
        with self._lock:
            return self._states.pop(thread_id, None)

    def has_resumable_state(self, thread_id: str) -> bool:
        """True if thread_id has a saved state that can be resumed."""
        if self._state_store is not None:
            return self._state_store.exists(thread_id)
        with self._lock:
            return thread_id in self._states

    def clear_state(self, thread_id: str):
        """
        Explicitly discard saved state without resuming it. Called
        if the user decides to start fresh instead of resuming.
        """
        if self._state_store is not None:
            self._state_store.clear(thread_id)
        with self._lock:
            self._states.pop(thread_id, None)
            self._flags.pop(thread_id, None)
