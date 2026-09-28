"""Extract a JSON object from an LLM response.

The model is asked to reply with a single JSON object. In practice it may:
  - reply with raw JSON (happy path)
  - wrap it in ```json ... ``` fences
  - prepend a sentence like "Sure, here's my next step:"
  - emit multiple objects, only the first is the current step

`extract_json` handles all three by trying strict parse first, then a fenced
block, then a brace-balanced scan starting at the first `{`.
"""
from __future__ import annotations

import json
import re
from typing import Any


class StructuredOutputError(ValueError):
    """The LLM's text could not be parsed into a JSON object."""


_FENCE = re.compile(r"```(?:json|JSON)?\s*(\{.*?\})\s*```", re.DOTALL)


def extract_json(text: str) -> dict[str, Any]:
    if not text or not text.strip():
        raise StructuredOutputError("empty response")
    stripped = text.strip()
    try:
        obj = json.loads(stripped)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    m = _FENCE.search(text)
    if m:
        try:
            obj = json.loads(m.group(1))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    start = text.find("{")
    if start < 0:
        raise StructuredOutputError(f"no JSON object found in response: {text[:200]!r}")

    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\" and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start : i + 1]
                try:
                    obj = json.loads(candidate)
                    if isinstance(obj, dict):
                        return obj
                except json.JSONDecodeError as e:
                    raise StructuredOutputError(f"malformed JSON: {e}: {candidate[:200]!r}") from e
    raise StructuredOutputError(f"unterminated JSON object in response: {text[:200]!r}")
