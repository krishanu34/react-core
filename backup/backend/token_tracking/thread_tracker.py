"""
Per-Thread Token Tracker Registry

AzureTokenTracker (token_tracking/azure_tracking.py) was originally
created ONCE as a single process-wide instance in router/apis.py,
meaning /usage/total and /usage/history reported across EVERY
conversation mixed together with no way to tell which thread used
what.

This registry keeps that exact same AzureTokenTracker class
unchanged, but gives each thread_id its own instance, plus one
"global" instance that mirrors every entry across all threads (so
the existing process-wide /usage endpoints keep working exactly as
before, for anyone relying on that view).

Why mirror into a global tracker instead of just summing the
per-thread ones on demand?
Because BaseTokenTracker's get_total()/get_history() already do
exactly what's needed (sum / list, oldest first) - reimplementing
that aggregation logic a second time here would just be duplicating
code that already exists and is already correct. Recording into both
trackers at once costs nothing extra (it's an in-memory list append)
and keeps every consumer of BaseTokenTracker's interface working
unmodified.
"""

from typing import Dict

from token_tracking.azure_tracking import AzureTokenTracker
from token_tracking.base_tracking import TokenUsage


class _DualTracker:
    """
    Wraps a per-thread AzureTokenTracker AND the shared global one,
    so a single record_usage() call updates both. Exposes the same
    record_usage()/get_total()/get_history() shape as
    BaseTokenTracker so it can be passed anywhere a tracker is
    expected (agents/react_agent.py, agents/planner_agent.py,
    agents/orchestrator.py all just call .record_usage(...) on
    whatever they're given).
    """

    def __init__(self, thread_tracker: AzureTokenTracker, global_tracker: AzureTokenTracker):
        self._thread_tracker = thread_tracker
        self._global_tracker = global_tracker

    def record_usage(self, raw_usage: dict, model: str = "unknown") -> TokenUsage:
        self._global_tracker.record_usage(raw_usage, model=model)
        return self._thread_tracker.record_usage(raw_usage, model=model)

    def get_total(self) -> dict:
        return self._thread_tracker.get_total()

    def get_history(self) -> list:
        return self._thread_tracker.get_history()


class ThreadTokenTrackerStore:
    """
    Process-wide cache of per-thread trackers, plus the one shared
    global tracker every thread also reports into.
    """

    def __init__(self):
        self._global_tracker = AzureTokenTracker()
        self._per_thread: Dict[str, AzureTokenTracker] = {}

    def get(self, thread_id: str) -> _DualTracker:
        if thread_id not in self._per_thread:
            self._per_thread[thread_id] = AzureTokenTracker()
        return _DualTracker(self._per_thread[thread_id], self._global_tracker)

    def get_thread_total(self, thread_id: str) -> dict:
        tracker = self._per_thread.get(thread_id)
        if tracker is None:
            return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "request_count": 0}
        return tracker.get_total()

    def get_global_total(self) -> dict:
        return self._global_tracker.get_total()

    def get_global_history(self) -> list:
        return self._global_tracker.get_history()
