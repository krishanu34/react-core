"""
Git checkpoints — undo for agent edits, against a real repository.

Brownfield edits land in a repo that usually has uncommitted work in it. Before
this, a wrong edit was only recoverable if the user happened to have committed
first. These tests run real git, because the whole value rests on one property
of `git stash create` that is easy to assume and easy to get wrong: it must
snapshot WITHOUT disturbing the working tree, the index, or the stash list.
"""

import asyncio
import shutil
import subprocess

import pytest

from tools import checkpoint_git
from tools.checkpoint_tool import CheckpointTool

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def _run(cwd, *args):
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True, text=True, check=False,
    )


@pytest.fixture()
def repo(tmp_path):
    """A repo with one committed file and one uncommitted modification."""
    _run(tmp_path, "init", "-q")
    _run(tmp_path, "config", "user.email", "t@example.com")
    _run(tmp_path, "config", "user.name", "Test")
    (tmp_path / "app.py").write_text("original content\n", encoding="utf-8")
    _run(tmp_path, "add", ".")
    _run(tmp_path, "commit", "-qm", "initial")
    # Uncommitted work — the state a user is usually in when the agent starts.
    (tmp_path / "app.py").write_text("user's own edit\n", encoding="utf-8")
    return tmp_path


# ── The non-invasiveness contract ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_checkpoint_does_not_disturb_the_users_repo(repo):
    """The property everything else depends on: after a checkpoint, the user's
    own git commands must show nothing new."""
    status_before = _run(repo, "status", "--porcelain").stdout
    stash_before = _run(repo, "stash", "list").stdout
    branches_before = _run(repo, "branch", "--list").stdout
    content_before = (repo / "app.py").read_text(encoding="utf-8")

    made = await checkpoint_git.create_checkpoint(str(repo), "t1", label="before edit")
    assert made is not None

    assert _run(repo, "status", "--porcelain").stdout == status_before
    assert _run(repo, "stash", "list").stdout == stash_before, "stash list must stay empty"
    assert _run(repo, "branch", "--list").stdout == branches_before
    assert (repo / "app.py").read_text(encoding="utf-8") == content_before


@pytest.mark.asyncio
async def test_refs_are_hidden_from_normal_git(repo):
    await checkpoint_git.create_checkpoint(str(repo), "t1")
    # Not a branch, so it never shows in `git branch` or a plain `git log`.
    assert "devaccel" not in _run(repo, "branch", "--list").stdout
    refs = _run(repo, "for-each-ref", "--format=%(refname)", "refs/devaccel").stdout
    assert "refs/devaccel/checkpoints/t1/1" in refs


# ── Restore ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_restore_undoes_an_agent_edit(repo):
    """The scenario that matters: checkpoint, agent wrecks the file, restore."""
    await checkpoint_git.create_checkpoint(str(repo), "t1", label="before edit")
    (repo / "app.py").write_text("AGENT BROKE THIS\n", encoding="utf-8")

    result = await checkpoint_git.restore_checkpoint(str(repo), "t1", 1)

    assert "error" not in result
    assert (repo / "app.py").read_text(encoding="utf-8") == "user's own edit\n"


@pytest.mark.asyncio
async def test_restore_is_itself_undoable(repo):
    """Restoring is destructive too — an undo with no undo is a trap."""
    await checkpoint_git.create_checkpoint(str(repo), "t1")
    (repo / "app.py").write_text("second state\n", encoding="utf-8")

    result = await checkpoint_git.restore_checkpoint(str(repo), "t1", 1)
    assert result["undo_with"] is not None

    # Going back to the pre-restore snapshot returns the discarded state.
    await checkpoint_git.restore_checkpoint(str(repo), "t1", result["undo_with"])
    assert (repo / "app.py").read_text(encoding="utf-8") == "second state\n"


@pytest.mark.asyncio
async def test_restore_states_that_new_files_survive(repo):
    """`stash create` never records untracked files, so restore cannot delete
    them. The result must SAY so rather than let the model assume otherwise."""
    await checkpoint_git.create_checkpoint(str(repo), "t1")
    (repo / "brand_new.py").write_text("created by the agent\n", encoding="utf-8")

    result = await checkpoint_git.restore_checkpoint(str(repo), "t1", 1)

    assert (repo / "brand_new.py").exists()
    assert "CREATED after" in result["note"]


# ── Listing, diffing, bookkeeping ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_is_newest_first_and_diff_names_changed_files(repo):
    await checkpoint_git.create_checkpoint(str(repo), "t1", label="first")
    (repo / "app.py").write_text("changed once\n", encoding="utf-8")
    await checkpoint_git.create_checkpoint(str(repo), "t1", label="second")

    points = await checkpoint_git.list_checkpoints(str(repo), "t1")
    assert [c.index for c in points] == [2, 1]

    (repo / "app.py").write_text("changed again\n", encoding="utf-8")
    diff = await checkpoint_git.diff_checkpoint(str(repo), "t1", 2)
    assert "app.py" in diff["files_changed"]


@pytest.mark.asyncio
async def test_threads_cannot_reach_each_others_checkpoints(repo):
    await checkpoint_git.create_checkpoint(str(repo), "thread-a")
    assert await checkpoint_git.list_checkpoints(str(repo), "thread-b") == []

    result = await checkpoint_git.restore_checkpoint(str(repo), "thread-b", 1)
    assert "error" in result


@pytest.mark.asyncio
async def test_clean_tree_produces_no_checkpoint(repo):
    _run(repo, "add", ".")
    _run(repo, "commit", "-qm", "commit everything")
    assert await checkpoint_git.create_checkpoint(str(repo), "t1") is None


@pytest.mark.asyncio
async def test_old_checkpoints_rotate_out(repo, monkeypatch):
    monkeypatch.setattr(checkpoint_git, "MAX_PER_THREAD", 3)
    for i in range(5):
        (repo / "app.py").write_text(f"state {i}\n", encoding="utf-8")
        await checkpoint_git.create_checkpoint(str(repo), "t1")
    points = await checkpoint_git.list_checkpoints(str(repo), "t1")
    assert len(points) <= 3


@pytest.mark.asyncio
@pytest.mark.parametrize("thread_id", [
    "../../evil ref~name",              # traversal + characters git rejects
    "root::sub::agent-7",               # a real SUB-AGENT thread id
    "thread.with.dots",                 # produces ".." components
    "has spaces and ^carets?",
])
async def test_thread_ids_are_sanitised_into_valid_refs(repo, thread_id):
    """Thread ids are interpolated into ref names, and git rejects a great deal.
    Sub-agent ids ("root::sub::x") hit this in ordinary use — before the
    sanitiser was narrowed, every sub-agent silently got no checkpoints."""
    made = await checkpoint_git.create_checkpoint(str(repo), thread_id)
    assert made is not None, f"{thread_id!r} produced no checkpoint"
    # git's own validator is the authority, not our regex.
    check = _run(repo, "check-ref-format", made.ref)
    assert check.returncode == 0, f"git rejected {made.ref!r}"
    assert await checkpoint_git.list_checkpoints(str(repo), thread_id)


# ── Non-repos and the tool surface ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_non_git_workspace_is_a_no_op_not_a_crash(tmp_path):
    assert await checkpoint_git.is_git_repo(str(tmp_path)) is False
    assert await checkpoint_git.create_checkpoint(str(tmp_path), "t1") is None


@pytest.mark.asyncio
async def test_tool_reports_missing_git_actionably(tmp_path):
    tool = CheckpointTool(str(tmp_path))
    tool.thread_id = "t1"
    result = await tool.run("list")
    assert "git init" in result["error"]


@pytest.mark.asyncio
async def test_tool_list_diff_restore(repo):
    tool = CheckpointTool(str(repo))
    tool.thread_id = "t1"

    empty = await tool.run("list")
    assert empty["count"] == 0 and "automatically" in empty["message"]

    created = await tool.run("create", label="manual")
    assert created["created"] is True

    (repo / "app.py").write_text("later\n", encoding="utf-8")
    listed = await tool.run("list")
    assert listed["count"] == 1

    cid = int(listed["checkpoints"][0]["id"])
    assert "app.py" in (await tool.run("diff", id=cid))["files_changed"]
    assert "error" not in await tool.run("restore", id=cid)
    assert (repo / "app.py").read_text(encoding="utf-8") == "user's own edit\n"


@pytest.mark.asyncio
async def test_tool_requires_an_id_for_diff_and_restore(repo):
    tool = CheckpointTool(str(repo))
    tool.thread_id = "t1"
    for op in ("diff", "restore"):
        assert "needs a checkpoint id" in (await tool.run(op))["error"]
