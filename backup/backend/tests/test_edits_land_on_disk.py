"""An edit the user is SHOWN must be an edit that happened.

Two independent ways the product used to break that, both of which look
identical from the user's seat — the chat renders the diff card, the Explorer
rescans, the agent says it made the change, and the file on disk is untouched:

  1. `code_edit` emitted `file_diff` BEFORE writing. `file_diff` is not a
     preview — ChatDock treats it as "a write reached the disk" and rescans on
     it. Any failure after the emit (unwritable file, stale mount, short write)
     still painted the change in the chat. Approval previews are what show an
     edit before it happens; that is `agents/change_preview.py`, and it is a
     different event for a different purpose.

  2. For a workspace that lives on the CLIENT's machine, a write tool the
     client didn't advertise stayed the SERVER's tool and wrote to the SERVER's
     disk — returning success. Worse than an error, because nothing anywhere
     reports it and the agent goes on editing a file state that never existed.

Both are regression-pinned here rather than in the tool's own tests, because
what is being protected is the contract BETWEEN the write and the event, not
either one alone.
"""

from __future__ import annotations

import asyncio
import os
import stat

import pytest

from tools.code_edit_tool import CodeEditTool
from tools.registry import ToolRegistry


def _events_of(kind, recorded):
    return [name for name, _ in recorded if name == kind]


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def workspace(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    return tmp_path


# ── 1. file_diff means "it landed" ───────────────────────────────────────────

def test_successful_edit_writes_then_announces(workspace):
    recorded = []

    async def on_event(kind, data):
        # Assert ordering at the moment of the emit, not after the fact: by the
        # time run() returns, a diff emitted too early is indistinguishable
        # from one emitted at the right time.
        if kind == "file_diff":
            assert (workspace / "a.py").read_text(encoding="utf-8") == (
                "def f():\n    return 2\n"
            ), "file_diff was emitted before the new bytes were on disk"
        recorded.append((kind, data))

    result = _run(CodeEditTool(str(workspace)).run(
        "a.py", "return 1", "return 2", on_event=on_event,
    ))

    assert result["status"] == "updated"
    assert _events_of("file_diff", recorded) == ["file_diff"]
    assert (workspace / "a.py").read_text(encoding="utf-8") == "def f():\n    return 2\n"


@pytest.mark.skipif(
    os.name != "nt" and os.geteuid() == 0,
    reason="root ignores the read-only bit, so the write cannot be made to fail",
)
def test_a_failed_write_announces_nothing(workspace):
    """The whole point: no diff card for an edit that did not happen."""
    target = workspace / "ro.py"
    target.write_text("x = 1\n", encoding="utf-8")
    os.chmod(target, stat.S_IREAD)
    recorded = []

    async def on_event(kind, data):
        recorded.append((kind, data))

    try:
        result = _run(CodeEditTool(str(workspace)).run(
            "ro.py", "x = 1", "x = 2", on_event=on_event,
        ))
    finally:
        os.chmod(target, stat.S_IWRITE | stat.S_IREAD)

    assert "error" in result
    assert _events_of("file_diff", recorded) == []
    assert target.read_text(encoding="utf-8") == "x = 1\n"


def test_a_write_that_does_not_stick_is_reported_as_an_error(workspace, monkeypatch):
    """Read-back verification, matching the client executor's verifyWrite.

    A write can raise nothing and still not land (stale mount, full disk,
    another process holding the file). Simulated here by neutering write_text,
    because no portable filesystem does this on demand.
    """
    from pathlib import Path

    monkeypatch.setattr(Path, "write_text", lambda self, *a, **k: len("ignored"))
    recorded = []

    async def on_event(kind, data):
        recorded.append((kind, data))

    result = _run(CodeEditTool(str(workspace)).run(
        "a.py", "return 1", "return 2", on_event=on_event,
    ))

    assert "error" in result
    assert "verification failed" in result["error"].lower()
    assert _events_of("file_diff", recorded) == []
    assert (workspace / "a.py").read_text(encoding="utf-8") == "def f():\n    return 1\n"


# ── 2. A client's files are never written on the server ──────────────────────

CLIENT_OWNS_FILES = {"read_file", "workspace_tree"}   # note: no write tools


def test_unadvertised_write_tools_refuse_instead_of_writing_server_side(workspace):
    registry = ToolRegistry.build_for_workspace(
        str(workspace), client_tools=CLIENT_OWNS_FILES,
    )

    for name in ToolRegistry.CLIENT_FS_WRITE_TOOLS:
        tool = registry.get(name)
        if tool is None:
            continue  # e.g. create_output only exists when output_dir is set
        assert type(tool).__name__ == "ClientWriteUnavailableTool", name

    result = _run(registry.get("code_edit").run(
        path="a.py", old_code="return 1", new_code="return 2",
    ))
    assert result["error"] == "no_client_write_channel"
    # The server's own copy of the file is the thing that must not change.
    assert (workspace / "a.py").read_text(encoding="utf-8") == "def f():\n    return 1\n"


def test_advertised_write_tools_are_delegated_to_the_client(workspace):
    registry = ToolRegistry.build_for_workspace(
        str(workspace), client_tools=CLIENT_OWNS_FILES | {"code_edit", "file_write"},
    )
    assert type(registry.get("code_edit")).__name__ == "ClientDelegatingTool"
    assert type(registry.get("file_write")).__name__ == "ClientDelegatingTool"


def test_a_server_owned_workspace_still_writes_on_the_server(workspace):
    """The guard keys on a client being present, so nothing changes without one."""
    registry = ToolRegistry.build_for_workspace(str(workspace))
    assert type(registry.get("code_edit")).__name__ == "CodeEditTool"

    result = _run(registry.get("code_edit").run(
        path="a.py", old_code="return 1", new_code="return 2",
    ))
    assert result["status"] == "updated"
    assert (workspace / "a.py").read_text(encoding="utf-8") == "def f():\n    return 2\n"


def test_every_guarded_write_tool_is_one_the_client_could_have_run(workspace):
    """A tool in CLIENT_FS_WRITE_TOOLS but not CLIENT_EXECUTABLE_TOOLS would be
    stubbed out for client workspaces with no delegated path to replace it —
    permanently unavailable rather than relocated."""
    assert ToolRegistry.CLIENT_FS_WRITE_TOOLS <= ToolRegistry.CLIENT_EXECUTABLE_TOOLS
