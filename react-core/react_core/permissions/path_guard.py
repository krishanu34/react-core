"""Workspace path sandbox.

Every tool that touches disk MUST route its path through `resolve_in_root`,
otherwise the agent can be talked into reading `/etc/passwd` or writing
outside the folder the user pointed us at.
"""
from __future__ import annotations

import os
from pathlib import Path


class PathEscape(ValueError):
    """Raised when a caller-supplied path escapes the workspace root."""


def resolve_in_root(root: str | os.PathLike, rel: str) -> Path:
    """Resolve `rel` inside `root`, or raise `PathEscape`.

    - `rel` must be workspace-relative (no absolute paths, no UNC).
    - `..` traversal is rejected — the resolved path must stay under `root`.
    - Symlinks are followed but the final target must also stay under `root`.
    """
    if rel is None:
        raise PathEscape("path is required")
    rel_str = str(rel).strip()
    if not rel_str:
        raise PathEscape("path is empty")
    if os.path.isabs(rel_str) or rel_str.startswith("\\\\"):
        raise PathEscape(f"absolute paths are not allowed: {rel_str!r}")

    root_real = os.path.realpath(str(root))
    if not os.path.isdir(root_real):
        raise PathEscape(f"workspace root does not exist: {root!r}")

    joined = os.path.join(root_real, rel_str)
    # realpath resolves .. and symlinks even for a path that doesn't exist yet.
    target = os.path.realpath(joined)

    try:
        common = os.path.commonpath([root_real, target])
    except ValueError:  # different drives on Windows
        raise PathEscape(f"path escapes workspace root: {rel_str!r}") from None
    if os.path.normcase(common) != os.path.normcase(root_real):
        raise PathEscape(f"path escapes workspace root: {rel_str!r}")

    return Path(target)


def workspace_relative(root: str | os.PathLike, abs_path: str | os.PathLike) -> str:
    """Format `abs_path` relative to `root` with POSIX separators."""
    rel = os.path.relpath(str(abs_path), str(root))
    return rel.replace(os.sep, "/")
