"""
The two paths that shed context must OFFLOAD, never destroy (§8a).

These drive the real methods on ToolUseAgent rather than the spill store in
isolation — the store working is not the same as the loop using it. Both of
these assertions fail on the pre-change code, where eviction and compression
dropped content with nothing written anywhere.
"""

from __future__ import annotations

import json

import pytest

from agents.tool_use_agent import ToolUseAgent
from context import context_spill


@pytest.fixture(autouse=True)
def _isolated_root(tmp_path, monkeypatch):
    monkeypatch.setattr("agents.workspace_paths.DEVACCEL_ROOT", str(tmp_path))
    yield


def _agent(thread_id="compact-test"):
    # Small window so the thresholds trip on modest fixtures.
    return ToolUseAgent(llm=None, context_window=4000, thread_id=thread_id)


def _tool_msg(i, content):
    return {"role": "tool", "tool_call_id": f"c{i}", "content": content}


# ── _evict_stale_tool_results ────────────────────────────────────────────

def test_evicted_tool_result_is_recoverable():
    agent = _agent("evict-1")
    original = "MATCH " * 6000            # comfortably over the threshold
    messages = [{"role": "system", "content": "sys"}]
    messages += [_tool_msg(i, original) for i in range(8)]

    out = agent._evict_stale_tool_results(list(messages))

    evicted = [m for m in out if (m.get("content") or "").startswith("[offloaded")]
    assert evicted, "large stale tool results should have been offloaded"

    marker = evicted[0]["content"]
    assert "restore_context" in marker
    ref = marker.split("→ ")[1].split(" ")[0]
    assert context_spill.restore("evict-1", ref) == original, (
        "the exact bytes must come back — otherwise the agent has to redo the work"
    )


def test_eviction_preserves_tool_call_structure():
    """Dropping role/tool_call_id would break the OpenAI tool-call contract."""
    agent = _agent("evict-2")
    messages = [{"role": "system", "content": "sys"}]
    messages += [_tool_msg(i, "X" * 40000) for i in range(8)]

    out = agent._evict_stale_tool_results(list(messages))
    for msg in out[1:]:
        assert msg["role"] == "tool"
        assert msg["tool_call_id"].startswith("c")


def test_recent_tool_results_are_left_alone():
    agent = _agent("evict-3")
    messages = [{"role": "system", "content": "sys"}]
    messages += [_tool_msg(i, "X" * 40000) for i in range(8)]

    out = agent._evict_stale_tool_results(list(messages))
    kept = [m for m in out if not (m.get("content") or "").startswith("[offloaded")]
    assert len(kept) >= agent._EVICT_KEEP_RECENT


def test_already_offloaded_results_are_not_respilled():
    agent = _agent("evict-4")
    messages = [{"role": "system", "content": "sys"}]
    messages += [_tool_msg(i, "X" * 40000) for i in range(8)]

    once = agent._evict_stale_tool_results(list(messages))
    twice = agent._evict_stale_tool_results(list(once))
    assert once == twice, "a second pass must be a no-op"


# ── _compress_if_needed ──────────────────────────────────────────────────

def test_compression_spills_the_originals():
    agent = _agent("compress-1")
    messages = [{"role": "system", "content": "sys"}]
    for i in range(40):
        messages.append({"role": "user", "content": f"user turn {i} " + "pad " * 200})
        messages.append({"role": "assistant", "content": f"assistant turn {i} " + "pad " * 200})

    out = agent._compress_if_needed(list(messages))
    assert len(out) < len(messages), "history should have been compressed"

    block = next(
        (m["content"] for m in out
         if m["role"] == "system" and "compressed to free context" in (m.get("content") or "")),
        None,
    )
    assert block, "expected a compression summary block"
    assert "restore_context" in block, "summary must point at the spilled originals"

    ref = block.split("saved as `")[1].split("`")[0]
    restored = json.loads(context_spill.restore("compress-1", ref))
    assert any("user turn 0" in (m.get("content") or "") for m in restored), (
        "the dropped originals must be recoverable in full"
    )


def test_compression_is_a_noop_when_history_fits():
    agent = ToolUseAgent(llm=None, context_window=128_000, thread_id="compress-2")
    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}]
    assert agent._compress_if_needed(list(messages)) == messages


def test_compression_keeps_the_system_message_first():
    agent = _agent("compress-3")
    messages = [{"role": "system", "content": "SYSTEM"}]
    for i in range(40):
        messages.append({"role": "user", "content": "pad " * 300})

    out = agent._compress_if_needed(list(messages))
    assert out[0]["role"] == "system" and out[0]["content"] == "SYSTEM"
