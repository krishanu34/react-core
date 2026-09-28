"""
Tool error taxonomy — tell the model WHAT went wrong, not just THAT it did.

Every tool failure used to collapse into one string starting "Error", so the
model could not distinguish situations that need completely different
responses:

    file not found        → try a different path, or list the directory first
    permission denied     → stop and ask the user; retrying is pointless
    invalid arguments     → re-issue the SAME call with corrected arguments
    syntax error in edit  → fix the code being written, not the call
    timeout / transient   → retry as-is; nothing was wrong with the request
    not executed          → the call never ran, so no side effects happened

Undifferentiated, the model's only strategy is "try again", which is how a run
ends up repeating a doomed call until the stall guard kills it. Classifying the
failure lets the loop tell the model whether retrying can possibly help — and
lets the stall guard notice an agent thrashing on the SAME KIND of error with
superficially different arguments, which byte-identical signature matching
misses entirely.

`classify()` is intentionally forgiving: an unrecognised failure is "unknown"
and retriable, i.e. exactly today's behaviour. Nothing regresses when a new
error type shows up.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolError:
    kind: str
    retriable: bool
    guidance: str

    def format(self, tool_name: str, detail: str) -> str:
        """The tool-result text the model actually reads."""
        return f"Error [{self.kind}] running '{tool_name}': {detail}\n{self.guidance}"


# Ordered: first match wins, so put the specific patterns above the generic
# ones (a "permission denied" message often also contains the word "file").
_PATTERNS: list[tuple[re.Pattern, ToolError]] = [
    (
        # Prose forms AND the exception class names classify_exception() feeds
        # in — "PermissionError" has no space, so the prose pattern misses it.
        re.compile(
            r"permission denied|not approved|forbidden|access is denied|"
            r"eacces|eperm|permissionerror|\b401\b|\b403\b",
            re.I,
        ),
        ToolError(
            "permission_denied", False,
            "Retrying will not help — this is blocked by policy or the user "
            "declined. Use a different approach, or ask the user before "
            "continuing.",
        ),
    ),
    (
        re.compile(
            r"no such file|not found|enoent|does not exist|cannot find|"
            r"filenotfound|notfounderror|isadirectory|\b404\b",
            re.I,
        ),
        ToolError(
            "not_found", True,
            "The path or symbol does not exist. Do NOT retry the same path — "
            "list the directory or search for the correct name first.",
        ),
    ),
    (
        re.compile(r"has not been read|read the file first|read it first", re.I),
        ToolError(
            "unread_file", True,
            "You must read a file before overwriting it. Call read_file on this "
            "path, then retry the write.",
        ),
    ),
    (
        re.compile(
            r"invalid arguments|unexpected keyword|missing .*required|"
            r"typeerror|valueerror",
            re.I,
        ),
        ToolError(
            "invalid_args", True,
            "The arguments did not match this tool's schema. Re-issue the SAME "
            "call with corrected argument names and types.",
        ),
    ),
    (
        re.compile(r"not valid json|could not be parsed|json ?decode", re.I),
        ToolError(
            "malformed_call", True,
            "The call was NOT executed, so nothing changed. Re-issue it with "
            "well-formed JSON — escape quotes and newlines in large strings.",
        ),
    ),
    (
        re.compile(r"syntaxerror|indentationerror|unexpected token|parse error", re.I),
        ToolError(
            "bad_content", True,
            "The problem is in the CODE you wrote, not the tool call. Read the "
            "file, fix the syntax, and write it again.",
        ),
    ),
    (
        re.compile(r"timed out|timeout|etimedout|timeouterror", re.I),
        ToolError(
            "timeout", True,
            "The operation exceeded its time limit. Retry with a narrower scope "
            "or a longer timeout — do not simply repeat it unchanged.",
        ),
    ),
    (
        re.compile(
            r"connection|econnrefused|econnreset|network|temporarily unavailable|"
            r"503|502|rate limit|429",
            re.I,
        ),
        ToolError(
            "transient", True,
            "A transient failure — the request itself was fine. Retrying as-is "
            "is reasonable.",
        ),
    ),
    (
        re.compile(r"unknown tool", re.I),
        ToolError(
            "unknown_tool", False,
            "That tool does not exist. Use one of the tools listed in your "
            "system prompt.",
        ),
    ),
    (
        re.compile(r"not configured|no llm available|no tool registry", re.I),
        ToolError(
            "misconfigured", False,
            "This capability is not available in this deployment. Achieve the "
            "task another way and tell the user what you could not do.",
        ),
    ),
]

_UNKNOWN = ToolError(
    "unknown", True,
    "If you retry, change something about the call — repeating it identically "
    "will fail the same way.",
)


def classify(detail: str) -> ToolError:
    """Map a failure message to its kind. Unrecognised → retriable 'unknown'."""
    text = detail or ""
    for pattern, err in _PATTERNS:
        if pattern.search(text):
            return err
    return _UNKNOWN


def classify_exception(exc: BaseException) -> ToolError:
    """Classify from an exception, using its type name as an extra signal —
    OSError subclasses in particular carry the kind in the class name."""
    return classify(f"{type(exc).__name__}: {exc}")
