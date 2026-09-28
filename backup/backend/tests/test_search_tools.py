"""
Search tool tests — brownfield accuracy.

Greenfield never exposed these tools: it writes files. Brownfield questions
("where is X handled?", "what breaks if I change Y?") are search-dominated,
and every scenario here is a distilled version of a way the search used to
mislead the model:

  - one noisy generated file starving every other result out of the window
    (the `-m`/`--max-count` conflation made the per-file cap 50, not 5)
  - vendor code in nested node_modules leaking into results on repos that
    were exported without a .gitignore
  - no way to see the DISTRIBUTION of a widespread symbol before drilling
  - match lines with no context, forcing a read_file per candidate

Each test runs against BOTH engines (ripgrep when available, the pure-Python
fallback always) because a customer host without rg must get the same
contract, just slower.
"""

import os
import time

import pytest

from tools import grep_search_tool
from tools.file_search_tool import FileSearchTool
from tools.grep_search_tool import GrepSearchTool


# ── Fixture: a small brownfield-shaped repo ──────────────────────────────────

@pytest.fixture()
def brownfield(tmp_path):
    def w(rel, content, age_days=0):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        if age_days:
            old = time.time() - age_days * 86400
            os.utime(p, (old, old))
        return p

    # The noisy file: 300 matches for "authenticate".
    w("legacy/generated_bundle.js",
      "\n".join(f"function authenticate_{i}() {{}}" for i in range(300)))
    # The real definition.
    w("src/auth/service.py",
      "class AuthService:\n"
      "    def authenticate(self, user, password):\n"
      "        # the real one\n"
      "        return check(user, password)\n")
    w("src/api/routes.py", "from auth.service import AuthService\n"
                           "# calls authenticate() on login\n")
    w("tests/test_auth.py", "def test_authenticate():\n    pass\n")
    # Vendor noise, nested — no .gitignore anywhere in this fixture.
    w("packages/app/node_modules/lib/index.js",
      "function authenticate() { /* vendor */ }\n")
    # A signature wrapped across lines.
    w("src/auth/legacy.py",
      "def old_authenticate(\n        user,\n        password):\n    pass\n")
    # Old vs recent, for mtime ordering.
    w("old/ancient.py", "# authenticate here too\n", age_days=900)
    w("src/recent.py", "# just touched\n")
    return tmp_path


def _engines():
    """Run each scenario on every engine available on this host."""
    engines = ["python"]
    if grep_search_tool._RG:
        engines.append("ripgrep")
    return engines


@pytest.fixture(params=_engines())
def grep(request, brownfield, monkeypatch):
    if request.param == "python":
        monkeypatch.setattr(grep_search_tool, "_RG", None)
    tool = GrepSearchTool(str(brownfield))
    tool._expected_engine = request.param
    return tool


# ── The starvation bug ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_noisy_file_cannot_starve_real_results(grep):
    """300 matches in one generated file must not push the real definition
    out of the result set — this exact failure made the model read the wrong
    file and answer wrong."""
    result = await grep.run("authenticate")
    assert result["engine"] == grep._expected_engine

    per_file = {}
    for m in result["matches"]:
        per_file[m["file"]] = per_file.get(m["file"], 0) + 1

    assert per_file.get("legacy/generated_bundle.js", 0) <= grep_search_tool.MAX_PER_FILE
    assert "src/auth/service.py" in per_file, "the real definition was starved out"
    assert "src/api/routes.py" in per_file


@pytest.mark.asyncio
async def test_nested_vendor_dirs_are_excluded(grep):
    """packages/*/node_modules must be skipped even with no .gitignore —
    a bare `!node_modules/**` glob only covers the top level."""
    result = await grep.run("authenticate")
    assert not any("node_modules" in m["file"] for m in result["matches"])

    survey = await grep.run("authenticate", output_mode="files_with_matches")
    assert not any("node_modules" in f for f in survey["files"])


# ── Survey modes ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_files_with_matches_shows_distribution(grep):
    result = await grep.run("authenticate", output_mode="files_with_matches")
    assert result["output_mode"] == "files_with_matches"
    assert result["total_files"] == 6
    assert "src/auth/service.py" in result["files"]


@pytest.mark.asyncio
async def test_count_mode_ranks_hot_spots_first(grep):
    result = await grep.run("authenticate", output_mode="count")
    assert result["counts"][0]["file"] == "legacy/generated_bundle.js"
    assert result["counts"][0]["matches"] == 300
    assert result["total_matches"] >= 305


# ── Context ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_context_shows_before_and_after_lines(grep):
    """The snippet must include BOTH sides of the match — after-context on the
    rg engine arrives after the match event and was once silently dropped."""
    result = await grep.run("def authenticate", context=2)
    hit = next(m for m in result["matches"] if m["file"] == "src/auth/service.py")
    assert "class AuthService" in hit["snippet"]          # before
    assert "# the real one" in hit["snippet"]             # after
    # ':' marks the match line, '-' the context (grep -C convention).
    match_row = next(r for r in hit["snippet"].splitlines() if "def authenticate" in r)
    assert ":" in match_row.split("def")[0]


# ── Multiline ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_multiline_finds_wrapped_signature(grep):
    result = await grep.run(r"def old_authenticate\(.*?password\)", multiline=True)
    assert result["total_matches"] >= 1
    assert result["matches"][0]["file"] == "src/auth/legacy.py"


# ── Paging & filters ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_head_limit_and_offset_page_through(grep):
    page1 = await grep.run("authenticate", head_limit=3)
    page2 = await grep.run("authenticate", head_limit=3, offset=3)
    assert len(page1["matches"]) == 3
    assert page1["matches"] != page2["matches"]
    assert page1["truncated"]
    assert "offset=3" in page1["message"]


@pytest.mark.asyncio
async def test_file_pattern_filters(grep):
    result = await grep.run("authenticate", file_pattern="*.py")
    assert result["matches"]
    assert all(m["file"].endswith(".py") for m in result["matches"])


@pytest.mark.asyncio
async def test_no_matches_is_a_message_not_an_error(grep):
    result = await grep.run("zz_never_appears_zz")
    assert result["total_matches"] == 0
    assert "No matches" in result["message"]
    assert "error" not in result


# ── file_search / Glob ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_file_search_orders_by_mtime_newest_first(brownfield):
    tool = FileSearchTool(str(brownfield))
    result = await tool.run("*.py")
    paths = [f["path"] for f in result["files"]]
    assert "src/recent.py" in paths and "old/ancient.py" in paths
    assert paths.index("src/recent.py") < paths.index("old/ancient.py")
    assert result["sorted_by"].startswith("modification time")
    assert all("modified" in f for f in result["files"])


@pytest.mark.asyncio
async def test_ripgrep_is_discovered(monkeypatch):
    """RIPGREP_PATH must win over PATH lookup — it is the operator's pin."""
    fake = __file__  # any existing file
    monkeypatch.setenv("RIPGREP_PATH", fake)
    assert grep_search_tool._find_rg() == fake
