"""
Context Spill — offload instead of destroy.

When the prompt outgrows the model's window, the agent has to shed content.
Until now both shedding paths in tool_use_agent.py were LOSSY and final:

  • _evict_stale_tool_results replaced a large tool result with
    "[evicted: N chars — re-read the file or re-run the search]", i.e. it told
    the agent to REDO the work.
  • _compress_if_needed collapsed old messages into one-liners and dropped the
    originals.

Nothing was written anywhere, so an 18 KB grep result that cost a real search
was simply gone. This module writes the full content to disk FIRST and leaves a
pointer behind, turning lossy compaction into lossless offload: the agent calls
restore_context(ref) and gets the exact bytes back instead of re-running the
search.

Layout (per thread, alongside input/workspace/output — see workspace_paths.py):

    .devaccel/{thread_id}/tmp/
        ctx/<ref>.txt          spilled content
        ctx/<ref>.json         its metadata (label, size, created_at)
        <agent_id>/checkpoint.json

DURABILITY: this is the backend pod's EPHEMERAL disk. It is a fast working
cache for a live run, not the durable record — a pod restart or a second
replica loses it. Anything that must survive that goes to the database (see
persistence/postgres_agent.py). Spilled files can contain source code, so they
live inside the thread's own directory and are never served over an endpoint.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Optional

from agents.workspace_paths import ThreadWorkspace
from utils.logger import get_logger

log = get_logger(__name__)

# Crashed runs leave their tmp dir behind (deliberately — that is what makes
# them resumable). Sweep anything older than this so the disk can't fill.
CONTEXT_SPILL_TTL_HOURS = float(os.getenv("CONTEXT_SPILL_TTL_HOURS", "24"))

_SAFE_REF = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"


def _ctx_dir(thread_id: str) -> Path:
    path = Path(ThreadWorkspace.for_thread(thread_id).tmp_dir) / "ctx"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe(ref: str) -> Optional[str]:
    """Refs come back through an LLM-authored tool argument, so treat them as
    untrusted: reject anything that isn't a plain token before it touches a
    path (no traversal, no absolute paths)."""
    ref = (ref or "").strip()
    if not ref or len(ref) > 64:
        return None
    return ref if all(c in _SAFE_REF for c in ref) else None


def spill(thread_id: str, content: str, label: str = "") -> Optional[str]:
    """
    Write `content` to the thread's spill area and return its ref.

    Returns None if the write fails — callers must fall back to their previous
    behaviour rather than losing the turn. Shedding context is a last-resort
    path; it must never be the thing that breaks a run.
    """
    try:
        ctx = _ctx_dir(thread_id)
        ref = f"ctx-{int(time.time() * 1000):x}-{len(content) % 9973:04d}"
        (ctx / f"{ref}.txt").write_text(content, encoding="utf-8", errors="replace")
        (ctx / f"{ref}.json").write_text(
            json.dumps({
                "ref": ref, "label": label, "chars": len(content),
                "created_at": time.time(),
            }),
            encoding="utf-8",
        )
        return ref
    except Exception as e:  # noqa: BLE001 — never break the run over a spill
        log.warning(f"Context spill failed (falling back to plain eviction): {e}")
        return None


def restore(thread_id: str, ref: str) -> Optional[str]:
    """The spilled content for `ref`, or None if it's unknown/unreadable."""
    safe = _safe(ref)
    if not safe:
        return None
    try:
        path = _ctx_dir(thread_id) / f"{safe}.txt"
        return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else None
    except Exception as e:  # noqa: BLE001
        log.warning(f"Context restore failed for {ref}: {e}")
        return None


def describe(thread_id: str, ref: str) -> dict:
    """Metadata for `ref` (label/size), or {} if unknown."""
    safe = _safe(ref)
    if not safe:
        return {}
    try:
        path = _ctx_dir(thread_id) / f"{safe}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except Exception:  # noqa: BLE001
        return {}


def pointer(ref: str, chars: int, label: str) -> str:
    """
    The text left in the message where the content used to be.

    Deliberately a POINTER, not a tombstone: the old text told the agent to
    re-run the search, which is exactly the wasted work this module exists to
    prevent.
    """
    kb = f"{chars / 1024:.1f} KB" if chars >= 1024 else f"{chars} chars"
    what = f", {label}" if label else ""
    return (
        f"[offloaded → {ref} ({kb}{what}) — call restore_context(\"{ref}\") "
        f"if you need it again]"
    )


def clear_thread(thread_id: str) -> None:
    """
    Drop a thread's whole tmp area.

    Called on SUCCESSFUL completion only: success means there is nothing left
    to resume. A stopped or failed run keeps its tmp dir so it can continue.
    """
    try:
        tmp = Path(ThreadWorkspace.for_thread(thread_id).tmp_dir)
        if tmp.is_dir():
            shutil.rmtree(tmp, ignore_errors=True)
    except Exception as e:  # noqa: BLE001
        log.debug(f"Spill cleanup skipped for {thread_id}: {e}")


def sweep_stale(root: str = None, ttl_hours: float = None) -> int:
    """
    Remove tmp dirs older than the TTL. Returns how many were removed.

    Run at startup: a run killed mid-flight leaves its tmp dir behind by
    design, and without this they accumulate forever on a long-lived pod.
    """
    from agents.workspace_paths import DEVACCEL_ROOT

    ttl = (ttl_hours if ttl_hours is not None else CONTEXT_SPILL_TTL_HOURS) * 3600
    base = Path(root or DEVACCEL_ROOT)
    if not base.is_dir() or ttl <= 0:
        return 0

    removed = 0
    cutoff = time.time() - ttl
    for thread_dir in base.iterdir():
        tmp = thread_dir / "tmp"
        try:
            if tmp.is_dir() and tmp.stat().st_mtime < cutoff:
                shutil.rmtree(tmp, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    if removed:
        log.info(f"Context spill sweep: removed {removed} stale tmp dir(s)")
    return removed
