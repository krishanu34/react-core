"""
Per-file async locks — serialise read-modify-write on the SAME path.

Why this exists: every tool call in one LLM turn runs concurrently
(ToolUseAgent._run_tool → asyncio.gather). That is the point — it's what
turns N network round trips to the client's workspace into one. But
code_edit, file_write and notebook_edit are all read → modify → write
sequences, and two of them targeting the same file in one batch interleave:

    code_edit(app.py, A→A')      code_edit(app.py, B→B')
      read  app.py  (original)     read  app.py  (original)
      write app.py  (A' only)      write app.py  (B' only)   ← A' is gone

Nothing errors. Both tools return {"status": "updated"}, the model believes
both edits landed, and the first one has silently vanished. Locking makes the
second call read the bytes the first one wrote, so `old_code` either matches
(edit applies on top) or misses loudly with the existing not-found error —
either way the model learns the truth instead of being lied to.

The key is the RESOLVED absolute path, so "src/a.py", "./src/a.py" and the
absolute form all contend for the same lock. Unrelated files are untouched
and stay fully parallel; only same-file work serialises.

Scope: in-process, like tools/client_broker.py and context/read_tracker.py.
That covers the real race (one agent turn, one worker). Concurrent writes
from two different workers to one shared disk would need a filesystem lock —
out of scope here, and not reachable in the current deployment where a thread
is pinned to the worker that started it.
"""

import asyncio
import os
from typing import Dict

# Resolved-and-normalised path -> lock. Entries are created lazily and kept
# for the process lifetime: an asyncio.Lock is a few bytes and the key space
# is bounded by the number of distinct files actually edited.
_locks: Dict[str, asyncio.Lock] = {}

# The loop those locks were created on. An asyncio.Lock binds to the loop it
# is first awaited on and raises if reused from another one, so a new loop
# (test runners calling asyncio.run per case) gets a fresh registry rather
# than a RuntimeError. A long-lived server has exactly one loop and never
# hits this branch.
_owner_loop: asyncio.AbstractEventLoop | None = None


def _key(path: str) -> str:
    """Normalise so every spelling of one file maps to one lock.
    normcase matters on Windows, where App.py and app.py are the same file."""
    return os.path.normcase(os.path.abspath(path))


def file_lock(path: str) -> asyncio.Lock:
    """Return the lock guarding `path`. Call as `async with file_lock(p):`.

    `path` should be the ABSOLUTE path (BaseTool._resolve_path output), not
    the agent-supplied relative one — two different relative spellings of the
    same file must not get two different locks.
    """
    global _owner_loop

    loop = asyncio.get_running_loop()
    if loop is not _owner_loop:
        _owner_loop = loop
        _locks.clear()

    key = _key(path)
    lock = _locks.get(key)
    if lock is None:
        # dict.setdefault/assignment is atomic between awaits, and there is no
        # await above — two coroutines cannot end up with different locks.
        lock = _locks[key] = asyncio.Lock()
    return lock
