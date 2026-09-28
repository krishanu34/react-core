"""
Post-fan-out integration check (§10c).

N children each verified in isolation does not mean their work composes.
Serial execution catches that implicitly; parallel does not. The loop nudges
the parent to run the project's build/test once after a parallel fan-out that
changed files.
"""

from __future__ import annotations

from types import SimpleNamespace

from agents.tool_use_agent import ToolUseAgent


def _call(name, i=0):
    return SimpleNamespace(id=f"c{i}", name=name, arguments={})


def _report(files):
    return str({"status": "done", "files_changed": files, "summary": "ok"})


def test_parallel_fanout_reports_changed_files():
    batch = [_call("sub_agent", 0), _call("sub_agent", 1)]
    results = [
        (batch[0], _report(["src/api.py"]), None),
        (batch[1], _report(["tests/test_api.py"]), None),
    ]
    assert ToolUseAgent._fanout_files_changed(batch, results) == [
        "src/api.py", "tests/test_api.py",
    ]


def test_single_subagent_does_not_trigger_the_check():
    """One delegated task is no more at risk than doing the work inline —
    nudging there would just be noise."""
    batch = [_call("sub_agent")]
    results = [(batch[0], _report(["src/api.py"]), None)]
    assert ToolUseAgent._fanout_files_changed(batch, results) == []


def test_read_only_fanout_does_not_trigger_the_check():
    batch = [_call("sub_agent", 0), _call("sub_agent", 1)]
    results = [(batch[0], _report([]), None), (batch[1], _report([]), None)]
    assert ToolUseAgent._fanout_files_changed(batch, results) == []


def test_ordinary_parallel_tools_do_not_trigger_the_check():
    batch = [_call("read_file", 0), _call("grep_search", 1)]
    results = [(batch[0], "contents", None), (batch[1], "matches", None)]
    assert ToolUseAgent._fanout_files_changed(batch, results) == []


def test_duplicate_files_are_reported_once():
    batch = [_call("sub_agent", 0), _call("sub_agent", 1)]
    results = [
        (batch[0], _report(["src/shared.py", "src/a.py"]), None),
        (batch[1], _report(["src/shared.py", "src/b.py"]), None),
    ]
    assert ToolUseAgent._fanout_files_changed(batch, results) == [
        "src/shared.py", "src/a.py", "src/b.py",
    ]


def test_unparseable_child_result_is_skipped_not_fatal():
    batch = [_call("sub_agent", 0), _call("sub_agent", 1)]
    results = [
        (batch[0], "Error running sub_agent: boom", None),
        (batch[1], _report(["src/ok.py"]), None),
    ]
    assert ToolUseAgent._fanout_files_changed(batch, results) == ["src/ok.py"]


def test_malformed_dict_string_does_not_raise():
    batch = [_call("sub_agent", 0), _call("sub_agent", 1)]
    results = [(batch[0], "{not a dict", None), (batch[1], "{'files_changed': 'notalist'}", None)]
    assert ToolUseAgent._fanout_files_changed(batch, results) == []
