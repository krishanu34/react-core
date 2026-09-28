"""Sanitize LLM-generated file content before persisting to disk.

Root cause: coder/scaffolder agents are instructed to return JSON wrappers
of the form ``{"project_name": "...", "files": [{"file_path": "...",
"content": "..."}]}`` or ``{"files": [...]}``.  When that wrapper text
accidentally reaches a write_file call as the *content* argument (either
because the agent confused the tool call payload with its final answer, or
because an upstream parser passed the raw response through), every file on
disk ends up prefixed with the same static JSON blob.

This module strips a leading JSON wrapper from file content.  When the
wrapper contains a single matching file entry (or a list whose ``file_path``
matches the current target), the inner ``content`` is returned instead.
Otherwise the wrapper is stripped and only the trailing payload remains.
The function is conservative: if it cannot confidently identify a wrapper
it returns the original content unchanged.
"""
from __future__ import annotations

import json
from typing import Any

import logging

log = logging.getLogger(__name__)

# Keys that mark a payload as the agent's response wrapper (not file content).
_WRAPPER_MARKER_KEYS = ("files", "project_name", "structure")


def _find_leading_json_object(text: str) -> tuple[int, int] | None:
    """Return (start, end) indices of the first balanced JSON object that
    begins at the first non-whitespace position, or None if not found."""
    i = 0
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    if i >= n or text[i] != "{":
        return None

    depth = 0
    in_str = False
    escape = False
    j = i
    while j < n:
        ch = text[j]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i, j + 1
        j += 1
    return None


def _extract_content_for_target(payload: Any, target_path: str | None) -> str | None:
    """If payload looks like an agent wrapper, return inner content for target."""
    if not isinstance(payload, dict):
        return None

    # Direct shape: {"files": [{"file_path": ..., "content": ...}, ...]}
    files = payload.get("files")
    # Scaffolder shape: {"project_name": ..., "structure": {"files": [...]}}
    if files is None:
        structure = payload.get("structure")
        if isinstance(structure, dict):
            files = structure.get("files")

    if not isinstance(files, list) or not files:
        return None

    # Try exact path match first
    if target_path:
        norm = target_path.replace("\\", "/").lstrip("./")
        for entry in files:
            if not isinstance(entry, dict):
                continue
            ep = (entry.get("file_path") or entry.get("path") or "").replace("\\", "/").lstrip("./")
            if ep and (ep == norm or ep.endswith("/" + norm) or norm.endswith("/" + ep)):
                content = entry.get("content")
                if isinstance(content, str):
                    return content

    # Fallback: single-file wrapper → use that one
    if len(files) == 1 and isinstance(files[0], dict):
        content = files[0].get("content")
        if isinstance(content, str):
            return content

    return None


def sanitize_generated_content(
    content: str,
    *,
    file_path: str | None = None,
) -> str:
    """Strip a leading agent-wrapper JSON object from ``content``.

    - If the leading JSON object exposes ``files``/``structure``/``project_name``
      keys, treat it as a wrapper and either substitute the matching nested
      file content or drop the wrapper entirely.
    - If the JSON object does not look like a wrapper (e.g. legitimate
      ``package.json`` / ``tsconfig.json`` payload), return content unchanged.
    """
    if not isinstance(content, str) or not content:
        return content

    span = _find_leading_json_object(content)
    if span is None:
        return content

    start, end = span
    head = content[start:end]

    try:
        payload = json.loads(head)
    except json.JSONDecodeError:
        return content

    if not isinstance(payload, dict):
        return content

    if not any(k in payload for k in _WRAPPER_MARKER_KEYS):
        # Not an agent wrapper — leave untouched (e.g. real JSON config file).
        return content

    inner = _extract_content_for_target(payload, file_path)
    if inner is not None:
        log.warning(
            "generated_content_unwrapped path=%s wrapper_bytes=%d inner_bytes=%d",
            file_path, len(head), len(inner),
        )
        return inner

    # Drop the wrapper and keep whatever follows it on disk.
    tail = content[end:].lstrip("\r\n")
    log.warning(
        "generated_content_wrapper_stripped path=%s wrapper_bytes=%d tail_bytes=%d",
        file_path, len(head), len(tail),
    )
    return tail


__all__ = ["sanitize_generated_content"]
