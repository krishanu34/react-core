"""
End-to-end: the search TOOLS honour the scan policy.

test_scan_policy.py proves the policy decides correctly. This file proves the
tools actually consult it — the gap where a correct module sits beside code
that never calls it, which is how five tools ended up with five different
ignore lists in the first place.

Both engines are exercised where it matters: ripgrep when the host has it, the
pure-Python fallback always, because the contract must not depend on which one
happened to be installed.
"""

from pathlib import Path

import pytest

from tools.file_search_tool import FileSearchTool
from tools.grep_search_tool import GrepSearchTool
from tools.list_directory_tool import ListDirectoryTool
from tools.workspace_tree_tool import WorkspaceTreeTool


NEEDLE = "createServerXYZ"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.js").write_text(f"// calls {NEEDLE}\n")

    dep = tmp_path / "node_modules" / "express" / "lib"
    dep.mkdir(parents=True)
    (dep / "server.js").write_text(f"function {NEEDLE}() {{ return 1; }}\n")

    other = tmp_path / "node_modules" / "lodash"
    other.mkdir(parents=True)
    (other / "index.js").write_text(f"// unrelated {NEEDLE}\n")
    return tmp_path


def _files(result) -> set:
    if "matches" in result:
        return {m["file"] for m in result["matches"]}
    if "files" in result and result.get("output_mode"):
        return set(result["files"])
    return {f["path"] for f in result.get("files", [])}


# ── grep_search ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_grep_skips_dependencies_by_default(project):
    tool = GrepSearchTool(workspace=str(project))
    hits = _files(await tool.run(query=NEEDLE))
    assert "src/app.js" in hits
    assert not any(h.startswith("node_modules/") for h in hits)


@pytest.mark.asyncio
async def test_grep_reaches_a_dependency_when_told_to(project):
    """The question this restores: "the stack trace goes into express — show
    me what that function actually does". Before, there was no way to ask."""
    tool = GrepSearchTool(workspace=str(project))
    hits = _files(await tool.run(query=NEEDLE, include_ignored=True))
    assert "node_modules/express/lib/server.js" in hits


@pytest.mark.asyncio
async def test_grep_targets_one_dependency_via_file_pattern(project):
    """Aiming at express must find express and NOT drag lodash in with it."""
    tool = GrepSearchTool(workspace=str(project))
    hits = _files(await tool.run(query=NEEDLE,
                                 file_pattern="node_modules/express/**"))
    assert "node_modules/express/lib/server.js" in hits
    assert not any("lodash" in h for h in hits)


@pytest.mark.asyncio
async def test_grep_reports_its_scope(project):
    """A narrowed search that says nothing is indistinguishable from an empty
    one — the model has to be able to tell "not there" from "not looked"."""
    tool = GrepSearchTool(workspace=str(project))
    assert "skipped" in (await tool.run(query=NEEDLE))["scope"]
    assert "everything" in (await tool.run(query=NEEDLE, include_ignored=True))["scope"]


# ── file_search ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_file_search_skips_dependencies_by_default(project):
    tool = FileSearchTool(workspace=str(project))
    paths = _files(await tool.run(pattern="*.js"))
    assert "src/app.js" in paths
    assert not any(p.startswith("node_modules/") for p in paths)


@pytest.mark.asyncio
async def test_file_search_searches_a_targeted_dependency(project):
    """`path` aimed inside node_modules is an explicit request. This is the
    case that broke when pruning was by directory NAME: the walk started
    inside the target and pruned its own children."""
    tool = FileSearchTool(workspace=str(project))
    result = await tool.run(pattern="*.js", path="node_modules/express")
    paths = _files(result)
    assert any("server.js" in p for p in paths), result


@pytest.mark.asyncio
async def test_file_search_include_ignored(project):
    tool = FileSearchTool(workspace=str(project))
    paths = _files(await tool.run(pattern="*.js", include_ignored=True))
    assert any("express" in p for p in paths)
    assert any("lodash" in p for p in paths)


# ── workspace_tree ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_tree_prunes_by_default_and_opens_on_request(project):
    tool = WorkspaceTreeTool(workspace=str(project))
    default = await tool.run(path=".", include_summary=False)
    assert not any("node_modules" in f["path"] for f in default["files"])

    opened = await tool.run(path=".", include_summary=False, include_ignored=True)
    assert any("express" in f["path"] for f in opened["files"])


# ── list_directory ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_directory_marks_instead_of_hiding(project):
    """Hiding node_modules meant the agent could not learn it existed, so it
    could never decide to look inside. A single listing is bounded — there is
    nothing to gain by omitting entries and a real capability lost."""
    tool = ListDirectoryTool(workspace=str(project))
    result = await tool.run(path=".")
    by_name = {e["name"]: e for e in result["entries"]}
    assert "node_modules/" in by_name
    assert by_name["node_modules/"].get("ignored") is True
    assert by_name["src/"].get("ignored") is None
    assert "note" in result


@pytest.mark.asyncio
async def test_list_directory_still_hides_plumbing(project):
    (project / ".git").mkdir(exist_ok=True)
    result = await ListDirectoryTool(workspace=str(project)).run(path=".")
    assert ".git/" not in {e["name"] for e in result["entries"]}
