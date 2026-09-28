"""ThreadMemory — the one place the agent gets its `memory_context` block.

Composes three sources, all keyed on `thread_id`:
  1. ConversationMemory      — the actual user/assistant messages for this thread.
  2. LongTermMemory          — facts the agent chose to persist via `remember`.
  3. ConversationSummarizer  — LLM digest of older messages, applied only when
                               the thread's message count crosses a threshold.

`build_memory_context()` returns the markdown block injected into every ReAct
step. Trigger for summarization is a simple message-count heuristic — token
budgeting arrives in a later pass.
"""
from __future__ import annotations

from typing import Any

from .conversation import ConversationMemory
from .long_term import LongTermMemory
from .summarizer import ConversationSummarizer

DEFAULT_MAX_RECENT_MESSAGES = 10
DEFAULT_MAX_LONG_TERM = 10
DEFAULT_SUMMARIZE_THRESHOLD = 20


class ThreadMemory:
    def __init__(
        self,
        thread_id: str,
        conversation: ConversationMemory,
        long_term: LongTermMemory,
        summarizer: ConversationSummarizer | None = None,
    ):
        self.thread_id = thread_id
        self.conversation = conversation
        self.long_term = long_term
        self.summarizer = summarizer

    def add_user_message(self, content: str) -> None:
        self.conversation.add_message(self.thread_id, "user", content)
        if self.summarizer is not None:
            self.summarizer.invalidate(self.thread_id)

    def add_assistant_message(self, content: str) -> None:
        self.conversation.add_message(self.thread_id, "assistant", content)
        if self.summarizer is not None:
            self.summarizer.invalidate(self.thread_id)

    def get_messages(self) -> list[dict[str, Any]]:
        return self.conversation.get_messages(self.thread_id)

    def remember(self, content: str, tags: list[str] | None = None) -> dict[str, Any]:
        return self.long_term.add(content, tags=tags)

    async def build_memory_context(
        self,
        *,
        max_recent_messages: int = DEFAULT_MAX_RECENT_MESSAGES,
        max_long_term: int = DEFAULT_MAX_LONG_TERM,
        summarize_threshold: int = DEFAULT_SUMMARIZE_THRESHOLD,
    ) -> str:
        messages = self.get_messages()
        long_term_entries = self.long_term.load()

        sections: list[str] = []
        should_summarize = (
            self.summarizer is not None
            and len(messages) > summarize_threshold
        )

        if should_summarize:
            split = len(messages) - max_recent_messages
            old_messages = messages[:split]
            recent_messages = messages[split:]
            summary = await self.summarizer.summarize(self.thread_id, old_messages)
            if summary:
                sections.append(f"## Conversation Summary (earlier)\n{summary}")
            if recent_messages:
                sections.append(_render_conversation_section(recent_messages))
        elif messages:
            sections.append(_render_conversation_section(messages[-max_recent_messages:]))

        if long_term_entries:
            sections.append(_render_long_term_section(long_term_entries, max_long_term))

        return "\n\n".join(sections)


def _render_conversation_section(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = ["## Recent Conversation"]
    for m in messages:
        role = "User" if m.get("role") == "user" else "Assistant"
        content = str(m.get("content", ""))
        lines.append(f"  {role}: {content}")
    return "\n".join(lines)


def _render_long_term_section(entries: list[dict[str, Any]], limit: int) -> str:
    tail = list(entries[-limit:])
    tail.reverse()
    body = "\n".join(f"- {e.get('content', '')}" for e in tail)
    return f"## Long-Term Memory\n{body}"
