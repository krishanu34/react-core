"""
Ask-mode approval must reach sub-agents.

Same bug class as the delegated-tool broker: a sub-agent's thread id is
derived ("{root}::sub::{agent_id}") to isolate its STATE, but the browser
answers approval requests under the thread id it opened the stream with — the
root. A child that registered its future under the derived id waited on a key
nothing would resolve, timed out, and the safe default turned that into a
DENIAL. In ask/strict mode every sub-agent write was silently refused, which
is why "modes other than auto" looked broken on fan-out work.
"""

import pytest

from agents.thread_ids import (
    SUB_SEPARATOR, is_subagent_thread, root_thread_id,
)
from tools.permission_broker import permission_broker


ROOT = "conversation-1"
CHILD = f"{ROOT}{SUB_SEPARATOR}agent-3"
GRANDCHILD = f"{CHILD}{SUB_SEPARATOR}agent-9"


@pytest.mark.parametrize("thread,expected", [
    (ROOT, ROOT),
    (CHILD, ROOT),
    (GRANDCHILD, ROOT),          # nested spawns still answer to the root
    ("", ""),
    ("plain-thread", "plain-thread"),
])
def test_root_thread_id(thread, expected):
    assert root_thread_id(thread) == expected


def test_is_subagent_thread():
    assert is_subagent_thread(CHILD)
    assert is_subagent_thread(GRANDCHILD)
    assert not is_subagent_thread(ROOT)


@pytest.mark.asyncio
async def test_a_child_request_resolves_from_the_root_channel():
    """The end-to-end shape: a child asks, the UI answers under the ROOT id."""
    channel = root_thread_id(CHILD)
    fut = permission_broker.create(channel, "req-1")

    # What POST /api/agent/permission_response does — it only ever knows ROOT.
    delivered = permission_broker.resolve(ROOT, "req-1", "allow")

    assert delivered is True
    assert fut.done() and fut.result() == "allow"


@pytest.mark.asyncio
async def test_resolving_under_the_child_id_finds_nothing():
    """Guards the regression: if the channel moves back to the derived id, the
    UI's real (root-keyed) response stops matching and the request times out
    into a denial."""
    permission_broker.create(root_thread_id(CHILD), "req-2")
    assert permission_broker.resolve(CHILD, "req-2", "allow") is False
    assert permission_broker.resolve(ROOT, "req-2", "allow") is True


@pytest.mark.asyncio
async def test_cancelling_the_root_releases_child_requests():
    """When the stream ends, `cancel_thread(root)` must unblock children too —
    they share the root channel, so nothing is left awaiting a dead stream."""
    fut = permission_broker.create(root_thread_id(CHILD), "req-3")
    permission_broker.cancel_thread(ROOT)
    assert fut.done()


def test_a_childs_permission_request_is_forwarded_to_the_ui():
    """The OTHER half of the same failure, found after the channel was fixed.

    SubAgentTool forwards only an allowlist of a child's events to the parent
    stream; `permission_request` was not on it. So the channel was correct and
    the event still never left the child: the request was dropped, the future
    waited out its 300s timeout, and the safe default turned that silence into
    a DENIAL. In manual mode every sub-agent write failed for a reason the
    user was never shown and could not have answered.

    Asserted against the real set rather than a copy — a duplicated list is
    how the two drift apart again.
    """
    import inspect

    from tools.sub_agent_tool import SubAgentTool

    source = inspect.getsource(SubAgentTool.run)
    forward_block = source.split("_FORWARD = {", 1)[1].split("}", 1)[0]
    assert '"permission_request"' in forward_block
    # A child's clarification card blocks the run for the same reason.
    assert '"ask_user"' in forward_block
