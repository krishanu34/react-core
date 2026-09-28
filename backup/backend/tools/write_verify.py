"""Read-back verification for writes that run on the SERVER's disk.

The client executor has done this from the start — `verifyWrite` in
ui/src/lib/agent/clientTools.ts reads the file back after every write and turns
a mismatch into a tool error. The server-side tools did not, so a write that
raised no exception but did not land (a stale or read-only mount, a full disk,
another process holding the file, a path that resolved somewhere other than the
file just read) was reported to the agent — and rendered in the chat — as a
successful edit.

That is the worst failure mode a coding agent has: the transcript shows the
change, the file on disk does not have it, and every later edit is reasoned
against a state that never existed. Verifying costs one read of a file already
in the page cache; being wrong costs the user their work.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional


def verify_written(file_path: Path, path: str, expected: str) -> Optional[str]:
    """Return an error message if `path` does not hold `expected`, else None.

    `path` is the workspace-relative name the agent used, so the message names
    the file the way the model and the user refer to it.
    """
    try:
        on_disk = file_path.read_text(encoding="utf-8")
    except Exception as exc:
        return (
            f"Wrote {path} but could not read it back to verify ({exc}). "
            f"Treat this edit as NOT applied: re-read the file before relying "
            f"on its contents."
        )
    if on_disk != expected:
        return (
            f"Write verification failed for {path}: the file on disk does not "
            f"match what was just written. The edit did NOT take effect — the "
            f"file may be read-only, held by another process, or on a stale "
            f"mount. Re-read the file before retrying."
        )
    return None
