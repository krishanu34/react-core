"""
Read Tracker — Claude Code's "read-before-overwrite" invariant.

Claude Code refuses to overwrite a file the agent hasn't Read this session
("File has not been read yet — read it first"). The model must have SEEN the
current bytes before it can replace them, so a blind full-file overwrite — the
classic way an agent silently destroys real code — is structurally impossible.
This is a STRONGER guard than "don't write empty content": it also blocks a
non-empty but stale/wrong rewrite, not just a blank one.

Scoped per THREAD (not per tool instance): a ToolRegistry is rebuilt on every
/api/agent/stream request (one HTTP call per conversational turn), so
attaching this state to a tool instance would forget everything the moment the
user sends their next message and legitimately wants to edit a file they read
two turns ago. Threads are otherwise the durable unit in this codebase (see
permissions.py's _session_approvals, task_manager, monitor) — same pattern
here: a process-wide dict keyed by thread_id.
"""

from typing import Dict, Set

# thread_id -> set of workspace-relative paths the agent has seen this thread
# (via read_file, batch_read_files, or its own code_edit/file_write).
_read_paths: Dict[str, Set[str]] = {}


def _norm(path: str) -> str:
    return (path or "").replace("\\", "/").strip()


def mark_read(thread_id: str, path: str) -> None:
    """Record that the agent has seen `path`'s current content this thread."""
    if not thread_id:
        return
    _read_paths.setdefault(thread_id, set()).add(_norm(path))


def has_been_read(thread_id: str, path: str) -> bool:
    """True if `path` was read (or written) earlier in this thread."""
    if not thread_id:
        # No thread context (e.g. direct/test invocation) — don't block;
        # only the live agent path enforces this invariant.
        return True
    return _norm(path) in _read_paths.get(thread_id, set())


def merge_thread(src_thread: str, dst_thread: str) -> None:
    """
    Fold `src_thread`'s read set into `dst_thread`.

    Used when a sub-agent finishes: the child read those files ON THE PARENT'S
    BEHALF, so the parent has legitimately "seen" them and may edit them. The
    reverse never happens — a child does NOT inherit its parent's or its
    siblings' reads, because that is precisely what would let one agent
    blind-overwrite a file another agent read (see tools/sub_agent_tool.py).
    """
    if not src_thread or not dst_thread or src_thread == dst_thread:
        return
    src = _read_paths.get(src_thread)
    if src:
        _read_paths.setdefault(dst_thread, set()).update(src)


def clear_thread(thread_id: str) -> None:
    """Drop a thread's read history (e.g. on thread deletion)."""
    _read_paths.pop(thread_id, None)
