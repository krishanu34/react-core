"""manage_plan tool tests.

Non-blocking: `run()` must complete without a client answer (unlike
ask_user / request_approval, there is no broker/future involved). It should
emit exactly one `plan_update` event carrying the normalized, full item list.
"""
from __future__ import annotations

import asyncio


def _tool():
    from react_core.tools.manage_plan import ManagePlanTool
    return ManagePlanTool("/ws")


def test_emits_plan_update_and_returns_immediately():
    tool = _tool()
    events: list[tuple[str, dict]] = []

    async def on_event(event_type, data):
        events.append((event_type, data))

    result = asyncio.run(tool.run(
        items=[
            {"id": "1", "title": "Fetch JIRA-1", "status": "in_progress"},
            {"id": "2", "title": "Draft scenarios"},
        ],
        on_event=on_event,
    ))

    assert result["ok"] is True
    assert len(events) == 1
    event_type, payload = events[0]
    assert event_type == "plan_update"
    assert payload["items"] == [
        {"id": "1", "title": "Fetch JIRA-1", "status": "in_progress"},
        {"id": "2", "title": "Draft scenarios", "status": "pending"},
    ]


def test_unknown_status_defaults_to_pending():
    tool = _tool()
    result = asyncio.run(tool.run(items=[{"id": "1", "title": "x", "status": "bogus"}]))
    assert result["items"][0]["status"] == "pending"


def test_items_without_title_are_dropped():
    tool = _tool()
    result = asyncio.run(tool.run(items=[{"id": "1", "title": "  "}, {"id": "2", "title": "keep"}]))
    assert [it["title"] for it in result["items"]] == ["keep"]


def test_empty_items_is_an_error():
    tool = _tool()
    result = asyncio.run(tool.run(items=[]))
    assert "error" in result


def test_works_without_on_event():
    tool = _tool()
    result = asyncio.run(tool.run(items=[{"id": "1", "title": "solo", "status": "completed"}]))
    assert result["ok"] is True
