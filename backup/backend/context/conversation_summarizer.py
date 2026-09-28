"""
Conversation Summarizer

When a thread's conversation history exceeds its token budget,
this uses ONE LLM call to compress older messages into a 2-3
sentence summary. Recent messages stay verbatim.

How it works:
  1. Split messages into "old" (first 60%) and "recent" (last 40%)
  2. Summarize the old messages with a single LLM call
  3. Cache the summary (only re-generate when message count changes)
  4. Return: summary + recent messages + long-term memory

Why cache?
  Within a single ReAct loop (multiple tool calls, same user message),
  the conversation history doesn't change. The summarization call
  happens at most once per user message, not per ReAct step.

Fallback:
  If the LLM call fails (network error, rate limit), fall back to
  hard-truncating old messages. The system should NEVER fail because
  of a summarization failure.
"""

from .token_estimator import estimate_tokens


class ConversationSummarizer:
    """
    Summarizes conversation history when it exceeds a token budget.
    One instance per server process, shared across threads.
    """

    def __init__(self, llm):
        self._llm = llm
        # Cache: thread_id -> (message_count, summary_text)
        # Re-summarize only when message_count changes
        self._cache: dict[str, tuple[int, str]] = {}

    async def build_memory_context(
        self,
        thread_id: str,
        messages: list,
        long_term_entries: list,
        token_budget: int,
        max_long_term: int = 10,
    ) -> str:
        """
        Build a token-budget-aware memory context string.

        If the raw messages + long-term entries fit within budget,
        returns them as-is. If they exceed budget, summarizes older
        messages and returns a compressed version.

        All per-message character limits are derived from token_budget
        so they scale with the model's context window.
        """
        # Build the raw context to check if it fits
        raw_context = _build_raw_context(messages, long_term_entries, max_long_term, token_budget)
        raw_tokens = estimate_tokens(raw_context)

        if raw_tokens <= token_budget:
            return raw_context

        # Over budget — need to summarize older messages
        if len(messages) <= 4:
            # Too few messages to split meaningfully — just truncate
            return _build_truncated_context(messages, long_term_entries, token_budget)

        # Split: old 60% / recent 40%
        split_point = int(len(messages) * 0.6)
        old_messages = messages[:split_point]
        recent_messages = messages[split_point:]

        # Get or generate summary for old messages
        summary = await self._get_summary(thread_id, old_messages)

        # Per-message char limit for the recent verbatim section.
        # Conversation gets ~60% of the budget; divide among recent messages.
        recent_count = max(len(recent_messages), 1)
        recent_chars = max(80, int(token_budget * 4 * 0.60) // recent_count)

        sections = []

        if summary:
            sections.append(f"## Conversation Summary (earlier messages)\n{summary}")

        # Recent messages (verbatim, budget-derived truncation)
        if recent_messages:
            conv_lines = []
            for msg in recent_messages:
                role = "User" if msg["role"] == "user" else "Assistant"
                content = msg["content"]
                if len(content) > recent_chars:
                    content = content[:recent_chars] + "..."
                conv_lines.append(f"  {role}: {content}")
            sections.append("## Recent Conversation\n" + "\n".join(conv_lines))

        # Long-term memory
        if long_term_entries:
            recent_lt = long_term_entries[-max_long_term:]
            recent_lt.reverse()
            lt_lines = [f"- {e['content']}" for e in recent_lt]
            sections.append("## Long-Term Memory\n" + "\n".join(lt_lines))

        result = "\n\n".join(sections) if sections else ""

        # Final safety: if still over budget, truncate from the end
        while estimate_tokens(result) > token_budget and len(result) > 200:
            result = result[:int(len(result) * 0.8)] + "\n[...truncated]"

        return result

    async def _get_summary(self, thread_id: str, old_messages: list) -> str:
        """Get a cached summary or generate a new one via LLM call."""
        msg_count = len(old_messages)
        cached = self._cache.get(thread_id)

        if cached and cached[0] == msg_count:
            return cached[1]

        summary = await self._summarize_messages(old_messages)
        self._cache[thread_id] = (msg_count, summary)
        return summary

    async def _summarize_messages(self, messages: list) -> str:
        """
        One LLM call to compress messages into 2-3 sentences.
        Falls back to hard truncation if the LLM call fails.

        Input truncation (200 chars/msg) is intentionally fixed — this
        controls how much text we send TO the summarizer, not how much
        the agent sees. The output is always just 2-3 short sentences.
        """
        conv_text = ""
        for msg in messages:
            role = "User" if msg["role"] == "user" else "Assistant"
            content = msg["content"][:200]  # input to summarizer — fixed is fine
            conv_text += f"{role}: {content}\n"

        prompt = (
            "Summarize this conversation in 2-3 concise sentences. "
            "Preserve key facts: file names mentioned, decisions made, "
            "tasks completed, and user preferences.\n\n"
            f"{conv_text}"
        )

        try:
            response, _ = await self._llm.invoke(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=200,
            )
            return response.strip()
        except Exception:
            return _fallback_summary(messages)


def _build_raw_context(
    messages: list,
    long_term_entries: list,
    max_long_term: int = 10,
    token_budget: int = None,
) -> str:
    """
    Build memory context in the same format as ThreadMemory.build_memory_context.

    Per-message char limit is derived from token_budget when provided,
    so it scales with the model's context window.
    """
    sections = []

    if messages:
        recent_msgs = messages[-10:]
        # Derive per-message char limit from budget (60% for conversation)
        if token_budget and token_budget > 0:
            msg_chars = max(80, int(token_budget * 4 * 0.60) // max(len(recent_msgs), 1))
        else:
            msg_chars = 300  # generous default when unconstrained

        conv_lines = []
        for msg in recent_msgs:
            role = "User" if msg["role"] == "user" else "Assistant"
            content = msg["content"]
            if len(content) > msg_chars:
                content = content[:msg_chars] + "..."
            conv_lines.append(f"  {role}: {content}")
        sections.append("## Recent Conversation\n" + "\n".join(conv_lines))

    if long_term_entries:
        recent = long_term_entries[-max_long_term:]
        recent.reverse()
        lt_lines = [f"- {e['content']}" for e in recent]
        sections.append("## Long-Term Memory\n" + "\n".join(lt_lines))

    return "\n\n".join(sections) if sections else ""


def _build_truncated_context(messages: list, long_term_entries: list, token_budget: int) -> str:
    """
    When we can't split messages (too few), truncate more aggressively.
    All limits are derived from token_budget.
    """
    sections = []

    if messages:
        # 5 messages, conversation gets 60% of budget
        msg_chars = max(60, int(token_budget * 4 * 0.60) // 5)
        conv_lines = []
        for msg in messages[-5:]:
            role = "User" if msg["role"] == "user" else "Assistant"
            content = msg["content"][:msg_chars]
            conv_lines.append(f"  {role}: {content}")
        sections.append("## Recent Conversation\n" + "\n".join(conv_lines))

    if long_term_entries:
        # Long-term entries get ~8% of budget each (40% / 5 entries)
        lt_chars = max(40, int(token_budget * 4 * 0.40) // 5)
        lt_lines = [f"- {e['content'][:lt_chars]}" for e in long_term_entries[-5:]]
        sections.append("## Long-Term Memory\n" + "\n".join(lt_lines))

    return "\n\n".join(sections) if sections else ""


def _fallback_summary(messages: list) -> str:
    """When LLM summarization fails, build a simple text-based summary."""
    parts = []
    for msg in messages:
        role = "User" if msg["role"] == "user" else "Assistant"
        content = msg["content"][:80]
        parts.append(f"{role}: {content}...")
    return "Earlier conversation: " + " | ".join(parts[-5:])
