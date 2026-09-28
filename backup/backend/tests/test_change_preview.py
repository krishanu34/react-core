"""
The approval card's preview — what the human is actually consenting to.

Without it the card read "code_edit · src/auth.py — Approve?", which is not a
decision: a comment fix and a rewritten auth check look identical, so people
approve everything and the gate protects nobody.

Two properties matter most and are asserted hardest:
  1. It is built from ARGUMENTS ONLY. The workspace usually lives on the
     user's machine, so the server has no file to read; a preview that
     depended on disk access would work for server-side workspaces and
     silently degrade for everyone on the daemon or in the browser.
  2. It is REDACTED. The preview streams to the browser and lands in the
     saved transcript, so a preview of a `.env` write is a credential leak
     with extra steps.
"""

import pytest

from agents.change_preview import MAX_PREVIEW_LINES, build


# ── Edits → a real diff ──────────────────────────────────────────────────────

def test_an_edit_previews_as_a_diff():
    p = build("code_edit", {
        "path": "src/auth.py",
        "old_code": "def check(t):\n    return True\n",
        "new_code": "def check(t):\n    if not t:\n        return False\n    return verify(t)\n",
    })
    assert p["kind"] == "diff"
    assert p["path"] == "src/auth.py"
    assert "-    return True" in p["diff"]
    assert "+    return verify(t)" in p["diff"]
    assert (p["added"], p["removed"]) == (3, 1)
    assert p["summary"] == "+3 −1 in src/auth.py"


def test_no_file_is_read_to_build_the_diff(tmp_path, monkeypatch):
    """The distributed constraint, asserted rather than assumed: any disk read
    here would make the card richer on server-side workspaces and poorer for
    every daemon/browser user — the divergence that keeps biting this
    codebase."""
    def _boom(*args, **kwargs):
        raise AssertionError("change_preview must not touch the filesystem")

    monkeypatch.setattr("builtins.open", _boom)
    p = build("code_edit", {"path": "a.py", "old_code": "x\n", "new_code": "y\n"})
    assert p["kind"] == "diff"


@pytest.mark.parametrize("old_key,new_key", [
    ("old_code", "new_code"),
    ("old_string", "new_string"),
    ("old_text", "new_text"),
    ("search", "replace"),
])
def test_before_after_pairs_are_recognised_by_shape(old_key, new_key):
    """Recognised by argument SHAPE, not tool name, so a tool added later gets
    a preview without anyone editing change_preview.py."""
    p = build("some_future_edit_tool", {"path": "f.ts", old_key: "a\n", new_key: "b\n"})
    assert p and p["kind"] == "diff"


# ── Whole-file writes → content, honestly labelled ───────────────────────────

def test_a_write_previews_its_content():
    p = build("file_write", {"path": "src/new.py", "content": "import os\nprint(1)\n"})
    assert p["kind"] == "content"
    assert "import os" in p["content"]
    assert p["lines"] == 2
    assert p["language"] == "py"


def test_a_write_is_not_presented_as_a_diff():
    """We cannot read the file, so we cannot know whether this creates or
    overwrites. A card implying a comparison it never made is worse than one
    that admits what it knows."""
    p = build("file_write", {"path": "existing.py", "content": "x = 1\n"})
    assert p["kind"] == "content"
    assert "diff" not in p


def test_create_output_uses_its_filename_argument():
    p = build("create_output", {"filename": "report.md", "content": "# Title\n"})
    assert p["kind"] == "content"
    assert p["path"] == "report.md"


# ── Commands ─────────────────────────────────────────────────────────────────

def test_a_command_previews_in_full():
    p = build("run_terminal", {"command": "alembic upgrade head"})
    assert p["kind"] == "command"
    assert p["command"] == "alembic upgrade head"


def test_a_long_command_is_not_abbreviated_in_the_middle():
    """Truncating the middle of a shell command is exactly where the
    dangerous part hides."""
    command = "npm run build && rm -rf ./dist-old && aws s3 sync ./dist s3://prod-bucket --delete"
    p = build("run_terminal", {"command": command})
    assert p["command"] == command


# ── Nothing to show ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("tool,args", [
    ("read_file", {"path": "a.py"}),
    ("grep_search", {"query": "foo"}),
    ("list_directory", {"path": "."}),
    ("some_tool", {}),
    ("some_tool", None),
])
def test_calls_with_nothing_to_preview_return_none(tool, args):
    assert build(tool, args) is None


# ── Redaction ────────────────────────────────────────────────────────────────

def test_a_dotenv_write_does_not_leak_its_secrets():
    """The preview is streamed to the browser and saved in the transcript. An
    unredacted .env preview is a credential leak with extra steps — and this
    caught a real gap: the redactor only matched QUOTED assignments, so the
    unquoted `KEY=value` form that every .env actually uses went straight
    through."""
    p = build("file_write", {
        "path": ".env",
        "content": "AZURE_OPENAI_API_KEY=abc123secretvalue\nDB_PASSWORD=hunter2\nDEBUG=1\n",
    })
    assert "abc123secretvalue" not in p["content"]
    assert "hunter2" not in p["content"]
    assert "[REDACTED]" in p["content"]
    # Non-secret settings survive — a preview scrubbed into uselessness is not
    # reviewable either.
    assert "DEBUG=1" in p["content"]


def test_secrets_are_redacted_on_both_sides_of_a_diff():
    """The OLD side matters as much as the new one: it is the value currently
    in the file."""
    p = build("code_edit", {
        "path": ".env",
        "old_code": "API_KEY=oldsecretvalue\n",
        "new_code": "API_KEY=newsecretvalue\n",
    })
    assert "oldsecretvalue" not in p["diff"]
    assert "newsecretvalue" not in p["diff"]


def test_ordinary_source_is_not_mangled_by_redaction():
    """Over-redaction has a real cost here: a diff of the user's own code with
    lines blanked out is not reviewable. `api_key = os.getenv(...)` holds no
    secret."""
    p = build("code_edit", {
        "path": "config.py",
        "old_code": 'api_key = os.getenv("KEY")\n',
        "new_code": 'api_key = settings.api_key\n',
    })
    assert "os.getenv" in p["diff"]
    assert "settings.api_key" in p["diff"]


# ── Bounds ───────────────────────────────────────────────────────────────────

def test_a_huge_write_is_clipped_and_says_so():
    """A 4000-line generated file must not be pushed through the SSE channel,
    and nobody reviews 4000 lines anyway. Silent truncation would read as
    'that is the whole change'."""
    p = build("file_write", {"path": "big.py", "content": "x = 1\n" * 4000})
    assert p["truncated"] is True
    assert len(p["content"].splitlines()) <= MAX_PREVIEW_LINES
    # The true size is still reported, so the card can say how much was cut.
    assert p["lines"] == 4000


def test_a_small_change_is_not_marked_truncated():
    p = build("file_write", {"path": "a.py", "content": "x = 1\n"})
    assert p["truncated"] is False
