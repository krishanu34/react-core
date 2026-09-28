"""
What is about to happen — the preview shown on an approval card.

An approval prompt that names a tool and a path is not a decision, it is a
formality. "code_edit · src/auth.py — Approve?" gives the human nothing to
judge: they cannot tell a comment fix from a rewritten auth check, so they
approve everything, and the gate becomes a speed bump that protects nobody.
Claude Code shows the actual diff before asking. This builds the same thing.

BUILT FROM ARGUMENTS, NEVER FROM DISK
The preview is derived only from the tool call's own arguments. That is a
constraint, not an oversight: the workspace usually lives on the USER's
machine (Pattern C — file tools are executed by the browser or the daemon), so
the server has no file to read. Reading when we happen to be able to would
produce a richer card for server-side workspaces and a poorer one for
everybody else — the same silent divergence that has bitten this codebase
repeatedly. One code path, one card, every transport.

The cost is honest and small: for a whole-file write we can show the content
that will land but not a diff against what is there now. The card says so
rather than implying it is a diff.

SHAPE-DRIVEN, NOT TOOL-DRIVEN
Tools are recognised by the SHAPE of their arguments — an old/new pair, a
content field, a command string — rather than by name. A tool added later
gets a preview without anyone editing this file, and a tool whose arguments
match nothing simply gets no preview, which is the safe failure.

REDACTION IS NOT OPTIONAL
A preview of a `.env` write would otherwise stream real credentials to the
browser and into the transcript. Everything here goes through
tools/sensitive_guard.redact_sensitive_content first.
"""

import difflib
import os
from typing import Optional

# Bounds. A 4000-line generated file must not be pushed through the SSE
# channel or rendered into the chat — and nobody reviews 4000 lines anyway.
# The card says what was cut so truncation never reads as "that's all".
MAX_PREVIEW_LINES = 160
MAX_PREVIEW_CHARS = 12_000
DIFF_CONTEXT_LINES = 3

# Argument names that carry a before/after pair. Several spellings because
# different tools (and other agents' schemas) name them differently; matching
# on the pair rather than on a tool name is what makes this extensible.
_OLD_NEW_KEYS = [
    ("old_code", "new_code"),        # code_edit
    ("old_string", "new_string"),
    ("old_text", "new_text"),
    ("old", "new"),
    ("before", "after"),
    ("search", "replace"),
]

_CONTENT_KEYS = ("content", "text", "source", "body", "new_source")
_PATH_KEYS = ("path", "file_path", "filename", "file", "notebook_path", "target")
_COMMAND_KEYS = ("command", "cmd", "script", "shell")


def _first(args: dict, keys) -> str:
    for key in keys:
        value = args.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _redact(text: str) -> str:
    """Never let a preview be the thing that leaks a secret."""
    try:
        from tools.sensitive_guard import redact_sensitive_content
        return redact_sensitive_content(text)
    except Exception:  # noqa: BLE001 — a preview must never break the prompt
        return text


def _clip(text: str) -> tuple[str, bool]:
    lines = text.splitlines()
    truncated = False
    if len(lines) > MAX_PREVIEW_LINES:
        lines = lines[:MAX_PREVIEW_LINES]
        truncated = True
    out = "\n".join(lines)
    if len(out) > MAX_PREVIEW_CHARS:
        out = out[:MAX_PREVIEW_CHARS]
        truncated = True
    return out, truncated


def _language(path: str) -> str:
    """Extension without the dot — a hint for the client's highlighter, not a
    claim about the file's contents."""
    if not path:
        return ""
    return os.path.splitext(path)[1].lstrip(".").lower()


def _unified(path: str, old: str, new: str) -> tuple[str, int, int]:
    """Unified diff of the replaced REGION.

    Line numbers are relative to the snippet, not the file — the server does
    not have the file, so it cannot know where the region sits in it. The card
    presents this as "the change", not as a file-anchored patch, which is what
    a reviewer needs anyway: what is being removed and what replaces it.
    """
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    diff = list(difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"a/{path}" if path else "before",
        tofile=f"b/{path}" if path else "after",
        n=DIFF_CONTEXT_LINES,
    ))
    body = "".join(diff)
    added = sum(1 for line in diff if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff if line.startswith("-") and not line.startswith("---"))
    return body, added, removed


def build(tool_name: str, arguments: Optional[dict]) -> Optional[dict]:
    """
    Return the preview payload for a pending tool call, or None when there is
    nothing meaningful to show (a read, a search, a tool whose arguments match
    no known shape).

    Shape of the result — all fields optional except `kind`:
        kind      "diff" | "content" | "command"
        path      what is being changed
        diff      unified diff text            (kind == "diff")
        content   the text that will be written (kind == "content")
        command   the command line             (kind == "command")
        language  extension hint for highlighting
        added/removed  line counts             (kind == "diff")
        truncated bool
        summary   one line for a collapsed card
    """
    if not isinstance(arguments, dict) or not arguments:
        return None

    path = _first(arguments, _PATH_KEYS)

    # ── A before/after pair → a real diff, the most useful card there is.
    for old_key, new_key in _OLD_NEW_KEYS:
        old = arguments.get(old_key)
        new = arguments.get(new_key)
        if isinstance(old, str) and isinstance(new, str) and (old or new):
            diff, added, removed = _unified(path, _redact(old), _redact(new))
            body, truncated = _clip(diff)
            return {
                "kind": "diff",
                "path": path,
                "diff": body,
                "language": _language(path),
                "added": added,
                "removed": removed,
                "truncated": truncated,
                "summary": f"+{added} −{removed}" + (f" in {path}" if path else ""),
            }

    # ── Whole content → show what will land. Deliberately NOT called a diff:
    # without reading the file we cannot know whether this creates or
    # overwrites, and a card that implies a comparison it did not make is
    # worse than one that admits what it knows.
    content = _first(arguments, _CONTENT_KEYS)
    if content and tool_name not in ("remember", "update_project_memory"):
        body, truncated = _clip(_redact(content))
        line_count = len(content.splitlines())
        return {
            "kind": "content",
            "path": path,
            "content": body,
            "language": _language(path),
            "truncated": truncated,
            "lines": line_count,
            "summary": f"{line_count} line{'s' if line_count != 1 else ''}"
                       + (f" → {path}" if path else ""),
        }

    # ── A command → the full line, never an abbreviation. Truncating the
    # middle of a shell command is precisely where the dangerous part hides.
    command = _first(arguments, _COMMAND_KEYS)
    if command:
        body, truncated = _clip(_redact(command))
        return {
            "kind": "command",
            "command": body,
            "truncated": truncated,
            "summary": command.splitlines()[0][:120],
        }

    return None
