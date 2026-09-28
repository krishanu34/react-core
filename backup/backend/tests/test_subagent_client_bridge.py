"""
Sub-agents must be able to reach client files.

The bug: a sub-agent's tools are shallow clones of the parent's, re-stamped
with a derived thread id (`{root}::sub::{agent_id}`) so siblings cannot
authorise each other's writes. That re-stamp also moved the BROKER channel —
but the browser only knows the thread id it opened the SSE stream with, and
POSTs every tool result under that one. So a child's client-delegated call
registered its future under a key nothing would ever resolve: the result came
back, matched no pending call, returned 404, and the child blocked until the
120 s timeout before reporting a tool error.

Every client-delegated call in every fan-out did this — which is what made
sub-agents useless on an IDE workspace.

The fix separates the two ideas: `thread_id` is per-thread STATE and still
moves with the child; `channel_thread_id` is the broker channel and does not.
"""

import asyncio
import copy

import pytest

from tools.client_broker import broker
from tools.client_delegating_tool import ClientDelegatingTool


ROOT = "thread-root"
CHILD = "thread-root::sub::agent-7"


def _tool(thread_id=ROOT):
    return ClientDelegatingTool(
        name="read_file",
        description="read a file",
        parameters_schema={"type": "object", "properties": {}},
        thread_id=thread_id,
        workspace="/ws",
    )


def _child_clone(parent):
    """Exactly what sub_agent_tool does: shallow copy, re-stamp thread_id."""
    clone = copy.copy(parent)
    clone.thread_id = CHILD
    return clone


def test_clone_keeps_the_parent_channel_but_gets_its_own_state():
    child = _child_clone(_tool())
    assert child.thread_id == CHILD, "state namespace must be per-child"
    assert child.channel_thread_id == ROOT, "broker channel must stay on the root"


@pytest.mark.asyncio
async def test_child_call_resolves_from_the_root_thread():
    """The end-to-end shape: a child issues a call, the browser answers under
    the ROOT thread id (the only one it knows), and the child unblocks."""
    child = _child_clone(_tool())
    seen = {}

    async def on_event(event_type, data):
        if event_type == "client_tool_use":
            seen["id"] = data["id"]
            # The browser POSTs to /api/agent/tool_result with the thread id it
            # opened the stream with — the ROOT, never the child's derived id.
            await asyncio.sleep(0)
            assert broker.resolve(ROOT, data["id"], {"content": "file body"}) is True

    result = await child.run(on_event=on_event, path="src/app.py")

    assert "file body" in result
    assert seen["id"], "the call id must reach the client"


@pytest.mark.asyncio
async def test_resolving_under_the_child_id_does_not_deliver():
    """Guards the regression directly: if the channel ever moves back to the
    child's id, the browser's real POST (root-keyed) stops matching."""
    child = _child_clone(_tool())

    async def on_event(event_type, data):
        if event_type == "client_tool_use":
            # A resolve under the CHILD id must find nothing, because the tool
            # registered on the root channel.
            assert broker.resolve(CHILD, data["id"], {"x": 1}) is False
            broker.resolve(ROOT, data["id"], {"ok": True})

    result = await child.run(on_event=on_event, path="a.py")
    assert "ok" in result


@pytest.mark.asyncio
async def test_parent_run_cancellation_unblocks_child_calls():
    """`cancel_thread(root)` runs when the stream ends. Because children share
    the root channel, their pending calls are released too — before the fix
    they were keyed elsewhere and leaked until timeout."""
    child = _child_clone(_tool())

    async def on_event(event_type, data):
        if event_type == "client_tool_use":
            broker.cancel_thread(ROOT)

    result = await child.run(on_event=on_event, path="a.py")
    assert "disconnected" in result.lower()


def test_vision_buffer_stays_per_child():
    """The other half of the distinction: images a CHILD read must land in the
    CHILD's buffer, because the child's own loop is what drains it."""
    child = _child_clone(_tool())
    out = child._siphon_images({
        "path": "shot.png",
        "images": [{"mime_type": "image/png", "data": "aGk=", "filename": "shot.png"}],
    })
    assert out.get("images_attached") == 1

    from agents import vision_buffer
    assert vision_buffer.drain(CHILD), "image should be queued on the child's thread"
    assert not vision_buffer.drain(ROOT), "root must not receive the child's image"
