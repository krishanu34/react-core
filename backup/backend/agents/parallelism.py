"""
Tool fan-out limit — shared by both agent loops (tool_use and react).

Parallel tool calls are the point of these loops: the LLM emits several calls
in one turn and they execute concurrently, turning N network round trips to
the client's workspace into one. That is where most of the agent's speed
comes from, so nothing here discourages it.

What it does bound is HOW MANY run at the same instant. The model chooses the
batch size and nothing stops it emitting fifteen calls; unbounded, that is
fifteen concurrent client round trips, subprocesses, or sub-agent runs (each
its own LLM conversation) fired at once — enough to saturate the client, the
Azure TPM quota, or the machine. Over the cap, calls queue and run as slots
free up: nothing is dropped, only paced.

MAX_PARALLEL_TOOLS=0 restores unlimited fan-out.
"""

import asyncio
import contextlib
import os

MAX_PARALLEL_TOOLS = int(os.getenv("MAX_PARALLEL_TOOLS", "8"))


def tool_slots():
    """Build the semaphore bounding ONE run's tool fan-out (None = unlimited).

    Call this per run(), not per module: it binds to the request's event loop,
    and a sub_agent's child run must get its own slots rather than compete for
    the parent's — a cap shared across nested agents could deadlock, with the
    parent holding slots while awaiting a child that needs one.
    """
    return asyncio.Semaphore(MAX_PARALLEL_TOOLS) if MAX_PARALLEL_TOOLS > 0 else None


def slot(slots):
    """`async with slot(slots):` — takes a slot if capped, no-op if not."""
    return slots if slots is not None else contextlib.nullcontext()
