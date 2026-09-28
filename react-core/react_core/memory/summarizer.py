"""Compress older messages into 2-3 sentences via one LLM call.

Called by ThreadMemory when the thread's message count crosses the summarize
threshold. Cached per thread: the summary is only regenerated when the
message count changes, so the summarizer runs at most once per user turn
(not per ReAct step). LLM failures fall back to a hard-truncation summary so
the loop can still make progress.
"""
from __future__ import annotations

from typing import Any

from ..llm.base import LLMClient


class ConversationSummarizer:
    def __init__(self, llm: LLMClient):
        self._llm = llm
        self._cache: dict[str, tuple[int, str]] = {}

    async def summarize(self, thread_id: str, messages: list[dict[str, Any]]) -> str:
        count = len(messages)
        cached = self._cache.get(thread_id)
        if cached and cached[0] == count:
            return cached[1]
        summary = await self._call_llm(messages)
        self._cache[thread_id] = (count, summary)
        return summary

    async def _call_llm(self, messages: list[dict[str, Any]]) -> str:
        if not messages:
            return ""
        conv_lines: list[str] = []
        for m in messages:
            role = "User" if m.get("role") == "user" else "Assistant"
            content = str(m.get("content", ""))[:200]
            conv_lines.append(f"{role}: {content}")
        prompt = (
            "Summarize this conversation in 2-3 concise sentences. Preserve "
            "key facts: file names mentioned, decisions made, tasks completed, "
            "and user preferences.\n\n" + "\n".join(conv_lines)
        )
        try:
            text = await self._llm.complete(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=250,
            )
            return text.strip()
        except Exception:  # noqa: BLE001 — summariser must never fail the run
            return _fallback_summary(messages)

    def invalidate(self, thread_id: str) -> None:
        self._cache.pop(thread_id, None)


def _fallback_summary(messages: list[dict[str, Any]]) -> str:
    tail = messages[-6:]
    parts: list[str] = []
    for m in tail:
        role = "User" if m.get("role") == "user" else "Assistant"
        content = str(m.get("content", ""))[:120]
        parts.append(f"{role}: {content}")
    return "Earlier conversation (truncated): " + " | ".join(parts)
