"""
Structured Output Parsing Helper

Every agent in this system (Orchestrator, Planner, ReAct) asks the
LLM to respond with ONLY a JSON object (see prompts/orchestrator.md,
prompts/planner_agent.md, prompts/react_agent.md). This is the fix
for the fragile regex-based parsing that react_agent.py used to rely
on (Thought:/Action:/Action Input: text matching) - structured JSON
output via response_format/JSON schema is far more robust than
hoping the model follows an exact free-text template every time.

Even with that instruction, models occasionally:
  - wrap the JSON in ```json ... ``` fences anyway
  - add a sentence of preamble before the JSON starts
  - add trailing commentary after the JSON ends

extract_json() below strips all of that defensively, so every agent
that depends on structured output shares ONE parsing path instead of
each reimplementing its own cleanup.
"""

import json
import re


class StructuredOutputError(Exception):
    """
    Raised when the LLM's response could not be parsed as the JSON
    object an agent expected. Callers should catch this and decide
    how to recover (retry, fall back to a plain-text answer, surface
    an error event to the client, etc.) rather than letting a raw
    json.JSONDecodeError propagate.
    """

    def __init__(self, message: str, raw_text: str):
        super().__init__(message)
        self.raw_text = raw_text


def extract_json(raw_text: str) -> dict:
    """
    Best-effort extraction of a single JSON object from an LLM
    response that was asked to return ONLY JSON.

    Handles, in order:
      1. The ideal case: the whole string is valid JSON already.
      2. Markdown-fenced JSON: ```json {...} ``` or plain ``` {...} ```
      3. JSON embedded with stray text around it: finds the first
         '{' and the matching last '}' and tries that slice.

    Raises StructuredOutputError if none of these produce valid
    JSON, carrying the original raw_text so the caller can log/show
    it for debugging.
    """
    text = raw_text.strip()

    # Case 1: already clean JSON.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Case 2: pull content out of a ```json ... ``` or ``` ... ``` fence.
    fence_match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence_match:
        candidate = fence_match.group(1).strip()
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # Case 3: slice from the first '{' to the last '}' and try that.
    # This handles "Sure, here's the plan:\n{...}\nLet me know if..."
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidate = text[first_brace:last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    raise StructuredOutputError(
        "Could not parse a JSON object out of the model's response.",
        raw_text=raw_text,
    )
