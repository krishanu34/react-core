"""request_approval tool tests — the checkpoint payload must carry the
decision-ready fields (concrete items, next_action, artefacts).
"""
from __future__ import annotations

import asyncio


def _tool():
    from react_core.tools.request_approval import RequestApprovalTool
    return RequestApprovalTool("/ws", thread_id="t-1")


def test_payload_includes_next_action_and_artefacts():
    from react_core.tools.ask_user import ask_user_broker
    tool = _tool()
    events: list[tuple[str, dict]] = []

    async def on_event(event_type, data):
        events.append((event_type, data))
        if event_type == "checkpoint_request":
            # Resolve immediately so run() returns without blocking.
            ask_user_broker.resolve("t-1", data["call_id"], "approve")

    result = asyncio.run(tool.run(
        checkpoint="design",
        summary="Approve the security test design for TELCO-088.",
        items=["Account lockout after 5 attempts @requirement:AC-1"],
        next_action="Generate the review-only security bundle.",
        artefacts=["artefacts/analysis.md", "artefacts/test_strategy.md"],
        on_event=on_event,
    ))

    assert result["answer"] == "approve"
    assert len(events) == 1
    _, payload = events[0]
    assert payload["checkpoint"] == "design"
    assert payload["next_action"] == "Generate the review-only security bundle."
    assert payload["artefacts"] == ["artefacts/analysis.md", "artefacts/test_strategy.md"]
    assert payload["items"] == ["Account lockout after 5 attempts @requirement:AC-1"]
    assert payload["options"] == ["approve", "revise", "reject"]


def test_optional_fields_omitted_when_absent():
    from react_core.tools.ask_user import ask_user_broker
    tool = _tool()
    events: list[tuple[str, dict]] = []

    async def on_event(event_type, data):
        events.append((event_type, data))
        if event_type == "checkpoint_request":
            ask_user_broker.resolve("t-1", data["call_id"], "approve")

    asyncio.run(tool.run(checkpoint="cases", summary="Sign off?", on_event=on_event))
    _, payload = events[0]
    assert "next_action" not in payload
    assert "artefacts" not in payload
