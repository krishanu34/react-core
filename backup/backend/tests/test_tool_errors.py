"""
Tool error taxonomy (§10e).

Every failure used to be one string starting "Error", so the model could not
tell a retry-with-a-different-path from a stop-and-ask. These pin the
distinctions that change what the agent should do next.
"""

from __future__ import annotations

import pytest

from tools.tool_errors import classify, classify_exception


# ── Retriable vs. dead end — the distinction that matters most ───────────

@pytest.mark.parametrize("message", [
    "Permission denied: write blocked in standard mode",
    "permission denied by user: 'file_write' was not approved",
    "EACCES: permission denied, open '/etc/hosts'",
])
def test_permission_failures_are_dead_ends(message):
    err = classify(message)
    assert err.kind == "permission_denied"
    assert err.retriable is False
    assert "not help" in err.guidance


@pytest.mark.parametrize("message", [
    "No such file or directory: 'src/missing.py'",
    "ENOENT: no such file or directory",
    "Error: file not found",
])
def test_missing_paths_are_retriable_but_not_identically(message):
    err = classify(message)
    assert err.kind == "not_found"
    assert err.retriable is True
    assert "Do NOT retry the same path" in err.guidance


@pytest.mark.parametrize("message", ["404", "HTTP 404", "status code 404"])
def test_bare_http_404_is_not_found(message):
    """A daemon or web_fetch error surface won't always spell out 'not found' —
    sometimes it's just the bare status code. Must still classify correctly,
    not fall through to generic 'unknown' with weaker guidance."""
    err = classify(message)
    assert err.kind == "not_found"
    assert err.retriable is True


@pytest.mark.parametrize("message", ["401", "HTTP 403", "request failed: 403"])
def test_bare_http_401_403_are_permission_denied(message):
    err = classify(message)
    assert err.kind == "permission_denied"
    assert err.retriable is False


def test_unknown_tool_is_a_dead_end():
    assert classify("unknown tool 'frobnicate'").retriable is False


def test_transient_failures_say_retrying_as_is_is_fine():
    err = classify("ConnectionError: connection refused")
    assert err.kind == "transient"
    assert err.retriable is True


def test_timeouts_say_do_not_repeat_unchanged():
    err = classify("Command timed out after 60s")
    assert err.kind == "timeout"
    assert "unchanged" in err.guidance


# ── Distinctions that change WHAT the agent fixes ────────────────────────

def test_bad_content_points_at_the_code_not_the_call():
    """A syntax error means the CODE is wrong, not the tool call — retrying
    the call verbatim is the wrong move."""
    err = classify("SyntaxError: invalid syntax (line 42)")
    assert err.kind == "bad_content"
    assert "CODE you wrote" in err.guidance


def test_invalid_args_says_reissue_the_same_call():
    err = classify("invalid arguments for 'read_file': unexpected keyword 'file_name'")
    assert err.kind == "invalid_args"
    assert "SAME call" in err.guidance


def test_malformed_call_states_nothing_was_executed():
    """The model must know no side effects happened, or it may 'undo' work
    that never occurred."""
    err = classify("the arguments were not valid JSON and could not be parsed")
    assert err.kind == "malformed_call"
    assert "NOT executed" in err.guidance


def test_unread_file_tells_it_to_read_first():
    err = classify("File has not been read yet — read it first")
    assert err.kind == "unread_file"
    assert "read_file" in err.guidance


# ── Ordering and fallback ────────────────────────────────────────────────

def test_permission_wins_over_file_wording():
    """Permission messages often also mention a file; the dead end must win,
    or the agent retries something it can never do."""
    assert classify("permission denied: cannot open file '/etc/shadow'").kind == "permission_denied"


def test_unrecognised_failure_degrades_to_retriable_unknown():
    err = classify("something nobody anticipated went sideways")
    assert err.kind == "unknown"
    assert err.retriable is True


@pytest.mark.parametrize("value", ["", None])
def test_empty_input_is_safe(value):
    assert classify(value).kind == "unknown"


def test_classify_exception_uses_the_type_name():
    assert classify_exception(FileNotFoundError("nope")).kind == "not_found"
    assert classify_exception(PermissionError("denied")).kind == "permission_denied"
    assert classify_exception(TimeoutError("slow")).kind == "timeout"


# ── The rendered message ─────────────────────────────────────────────────

def test_formatted_message_carries_kind_and_guidance():
    err = classify("No such file or directory")
    text = err.format("read_file", "No such file or directory: 'x.py'")
    assert "[not_found]" in text
    assert "read_file" in text
    assert err.guidance in text
