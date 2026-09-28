"""
Git Checkpoints — undo for agent edits.

The brownfield safety gap: the agent edits real files in a real repo, and a
wrong edit is only recoverable if the user happened to have committed first.
Claude Code snapshots before destructive changes so a bad run can be rolled
back; nothing here did.

The primitive is `git stash create`. It is the one git command that captures
the full working state — tracked modifications AND staged content — as a
commit object WITHOUT touching anything:

    * the working tree is unchanged
    * the index is unchanged
    * the stash LIST is unchanged (`git stash list` stays empty)

It just returns a dangling commit sha. That is exactly the property needed to
snapshot someone else's repository without being rude: a user who runs `git
status`, `git stash list` or `git log` after a checkpoint sees nothing new.

Dangling commits are garbage-collectable, so each sha is anchored under
`refs/devaccel/checkpoints/<thread>/<n>`. That namespace is invisible to
normal use — it is not `refs/heads`, so it never appears in `git branch`, and
never in `git log` without an explicit `--all`.

What is deliberately NOT done:
  * No `git add`, no commit to a branch, no `git stash push` — none of those
    are reversible from the user's point of view, and all of them show up in
    their tooling.
  * Untracked files are not captured by `stash create`. Restoring therefore
    never DELETES a file the agent created; it restores the content of files
    that already existed. Stated in the restore result so nobody assumes
    otherwise.
"""

import asyncio
import os
import re
from dataclasses import dataclass
from typing import List, Optional

from utils.logger import get_logger

log = get_logger(__name__)

# Refs live here. One level per thread so a restore can never reach across
# conversations, and so cleanup is a single ref-namespace delete.
REF_PREFIX = "refs/devaccel/checkpoints"

# Keep the most recent N per thread. A long run makes one checkpoint per write
# burst, and unbounded refs would hold every intermediate state of the repo
# alive against gc forever.
MAX_PER_THREAD = int(os.getenv("CHECKPOINT_MAX_PER_THREAD", "20"))

_GIT_TIMEOUT = 30.0

# A thread id reaches this module from the request and is interpolated into a
# ref name, so it is constrained rather than trusted.
#
# Alphanumerics, underscore and hyphen ONLY — deliberately narrower than it
# looks like it needs to be. git-check-ref-format rejects a component that
# contains "..", ":", "~", "^", "?", "*", "[", "\", a space, or that begins
# with a dot. Two of those arrive in ordinary use, not just from an attacker:
# a sub-agent's thread id is "{root}::sub::{agent_id}", and any dotted id
# produces ".." the moment a path-ish value is passed. Both made update-ref
# fail, silently, so sub-agents got no checkpoints at all.
_SAFE_THREAD = re.compile(r"[^A-Za-z0-9_-]")


@dataclass
class Checkpoint:
    ref: str
    sha: str
    index: int
    label: str

    def to_dict(self) -> dict:
        return {"id": str(self.index), "sha": self.sha[:12], "label": self.label}


def _safe_thread(thread_id: str) -> str:
    cleaned = _SAFE_THREAD.sub("_", str(thread_id or "default"))
    return cleaned[:80] or "default"


async def _git(workspace: str, *args, timeout: float = _GIT_TIMEOUT):
    """Run one git command. Returns (ok, stdout, stderr) and never raises —
    a checkpoint failing must never fail the edit it was protecting."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", workspace, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (
            proc.returncode == 0,
            out.decode("utf-8", "replace").strip(),
            err.decode("utf-8", "replace").strip(),
        )
    except (asyncio.TimeoutError, FileNotFoundError, OSError) as e:
        return False, "", f"{type(e).__name__}: {e}"


async def is_git_repo(workspace: str) -> bool:
    ok, out, _ = await _git(workspace, "rev-parse", "--is-inside-work-tree")
    return ok and out == "true"


async def list_checkpoints(workspace: str, thread_id: str) -> List[Checkpoint]:
    """Newest first."""
    prefix = f"{REF_PREFIX}/{_safe_thread(thread_id)}"
    ok, out, _ = await _git(
        workspace, "for-each-ref", "--format=%(refname) %(objectname) %(subject)", prefix,
    )
    if not ok or not out:
        return []

    found: List[Checkpoint] = []
    for line in out.splitlines():
        ref, _, rest = line.partition(" ")
        sha, _, subject = rest.partition(" ")
        tail = ref.rsplit("/", 1)[-1]
        if not tail.isdigit():
            continue
        found.append(Checkpoint(ref=ref, sha=sha, index=int(tail), label=subject))
    found.sort(key=lambda c: -c.index)
    return found


async def create_checkpoint(
    workspace: str, thread_id: str, label: str = "",
) -> Optional[Checkpoint]:
    """Snapshot the working tree. Returns None when there is nothing to
    snapshot (a clean tree) or when this isn't a git repo — both normal, and
    neither an error worth surfacing to the model."""
    if not await is_git_repo(workspace):
        return None

    # `stash create` prints nothing on a clean tree: there is no state to save,
    # so there is no checkpoint to make.
    ok, sha, err = await _git(workspace, "stash", "create", label or "devsphere checkpoint")
    if not ok:
        log.debug("checkpoint: stash create failed: %s", err)
        return None
    sha = sha.strip()
    if not sha:
        return None

    existing = await list_checkpoints(workspace, thread_id)
    index = (existing[0].index + 1) if existing else 1
    ref = f"{REF_PREFIX}/{_safe_thread(thread_id)}/{index}"

    ok, _, err = await _git(workspace, "update-ref", ref, sha)
    if not ok:
        log.debug("checkpoint: update-ref failed: %s", err)
        return None

    # Retire the oldest beyond the cap — the refs are what keep these commits
    # alive against gc, so dropping the ref is the whole cleanup.
    for old in existing[MAX_PER_THREAD - 1:]:
        await _git(workspace, "update-ref", "-d", old.ref)

    log.info("Checkpoint %s created at %s (%s)", index, sha[:12], label or "unlabelled")
    return Checkpoint(ref=ref, sha=sha, index=index, label=label or "devsphere checkpoint")


async def restore_checkpoint(workspace: str, thread_id: str, index: int) -> dict:
    """Put the working tree back to a checkpoint.

    Uses `git checkout <sha> -- .`, which overwrites tracked files with their
    checkpointed content. It does NOT remove files created after the
    checkpoint: `stash create` never recorded them, so there is nothing
    authoritative to say they should not exist. The caller is told this rather
    than left to infer it.
    """
    points = await list_checkpoints(workspace, thread_id)
    match = next((c for c in points if c.index == index), None)
    if match is None:
        return {
            "error": f"Checkpoint {index} not found.",
            "available": [c.to_dict() for c in points],
        }

    # Snapshot the CURRENT state first: restoring is itself a destructive act,
    # and an undo with no undo is a trap.
    before = await create_checkpoint(workspace, thread_id, label="before restore")

    ok, _, err = await _git(workspace, "checkout", match.sha, "--", ".")
    if not ok:
        return {"error": f"Restore failed: {err}"}

    return {
        "restored": match.to_dict(),
        "undo_with": before.index if before else None,
        "note": (
            "Tracked files are back to their checkpointed contents. Files "
            "CREATED after that point still exist — checkpoints record "
            "modifications to known files, not the absence of new ones. "
            "Delete any unwanted new files explicitly."
        ),
    }


async def diff_checkpoint(workspace: str, thread_id: str, index: int) -> dict:
    """What changed since a checkpoint — the question asked before restoring."""
    points = await list_checkpoints(workspace, thread_id)
    match = next((c for c in points if c.index == index), None)
    if match is None:
        return {"error": f"Checkpoint {index} not found.",
                "available": [c.to_dict() for c in points]}

    ok, stat, _ = await _git(workspace, "diff", "--stat", match.sha)
    ok2, names, _ = await _git(workspace, "diff", "--name-only", match.sha)
    if not ok and not ok2:
        return {"error": "Could not diff against that checkpoint."}
    return {
        "checkpoint": match.to_dict(),
        "files_changed": [n for n in names.splitlines() if n],
        "summary": stat[:4000],
    }


async def clear_thread(workspace: str, thread_id: str) -> int:
    """Drop every checkpoint ref for a thread. Returns how many were removed."""
    points = await list_checkpoints(workspace, thread_id)
    for c in points:
        await _git(workspace, "update-ref", "-d", c.ref)
    return len(points)
