"""
Thread Memory Manager

Wires together the two existing memory primitives
(memory/short_term.py's ShortTermMemory and memory/long_term.py's
LongTermMemory) PLUS the conversation history
(memory/conversation_history.py), all scoped to one thread_id, and
produces the single "memory_context" text block that gets injected
into every agent prompt (orchestrator, planner, ReAct - see
{memory_context} in prompts/*.md).

Why does this need to exist as its own file, instead of agents just
constructing these three classes directly?

Because "remember history short_term and long_term" (the actual
requirement this file exists to satisfy) means three DIFFERENT
sources of context need to be combined into one block of text each
time an agent is asked to do something:

  1. ConversationHistory - the actual back-and-forth chat messages
     for this thread. This is the full multi-turn conversation, used
     to build the `messages` list sent to the LLM (unchanged from
     how router/apis.py's /chat/stream endpoint already used it).

  2. LongTermMemory - facts/notes that persisted from PREVIOUS runs
     in this thread (or, if you choose to share one file across
     threads, across threads too - see note on file_path below).
     This is what makes the agent remember "the user said X" days
     later even after the server restarted.

  3. ShortTermMemory - the CURRENT run's own scratchpad (Thought/
     Action/Observation steps). This one is NOT shared across calls
     to ThreadMemory - each ReActAgent.run() still creates its own
     fresh ShortTermMemory internally (see react_agent.py), exactly
     as before. ThreadMemory only owns #1 and #2; ReActAgent owns its
     own #3 per call, by design (a scratchpad from task A leaking
     into task B's prompt would actively confuse the model).

One ThreadMemory instance is created per thread_id and cached for
the lifetime of the server process (see ThreadMemoryStore below) -
matching the same in-memory-while-running, gone-on-restart tradeoff
ConversationHistory already makes, while LongTermMemory's own file
underneath it still persists across restarts regardless.
"""

import os
from typing import Dict

from memory.conversation_history import ConversationHistory
from memory.long_term import LongTermMemory


class ThreadMemory:
    """
    All memory for ONE thread_id. Combines three sources into a single
    memory_context string that every agent prompt receives:

      1. Conversation history - the actual user/assistant messages in
         this thread (so the agent knows what was already discussed).
      2. Long-term memory - facts/notes persisted across runs and
         server restarts (so the agent remembers learned facts).
      3. Short-term memory (scratchpad) - NOT managed here; each
         ReActAgent.run() creates its own fresh scratchpad internally.
    """

    def __init__(self, thread_id: str, conversation_history: ConversationHistory, long_term_file: str):
        self.thread_id = thread_id
        self.conversation_history = conversation_history
        self.long_term = LongTermMemory(file_path=long_term_file)

    def add_user_message(self, content: str):
        """Append a user message to conversation history for this thread."""
        self.conversation_history.add_message(self.thread_id, "user", content)

    def add_assistant_message(self, content: str):
        """Append an assistant message to conversation history for this thread."""
        self.conversation_history.add_message(self.thread_id, "assistant", content)

    def get_messages(self):
        """Full chat history for this thread, oldest first."""
        return self.conversation_history.get_messages(self.thread_id)

    def remember(self, content: str, tags=None):
        """Persist one fact/note to long-term memory for this thread."""
        self.long_term.add(content, tags=tags)

    def build_memory_context(
        self,
        max_long_term: int = 10,
        max_conversation: int = 10,
        token_budget: int = None,
    ) -> str:
        """
        Builds the {memory_context} text block injected into agent
        prompts. Combines conversation history + long-term memory.

        When token_budget is provided, per-message character limits are
        derived from the budget so they scale with the model's context
        window — no hardcoded magic numbers. Progressive reduction:
          1. Full context: max_conversation msgs, budget-derived chars each
          2. Medium: 5 msgs, budget-derived chars (larger slice per msg)
          3. Minimal: 3 msgs, budget-derived chars (largest slice per msg)
          4. Hard truncate: keep only the last token_budget*4 chars
        """
        from context.token_estimator import estimate_tokens

        # Derive per-message character limits from token_budget so they
        # scale with the model's context window rather than being fixed.
        # Conversation gets ~60% of the budget, long-term memory gets ~40%.
        # Each tier uses fewer messages but allows more chars per message.
        if token_budget and token_budget > 0:
            conv_chars = int(token_budget * 4 * 0.60)
            full_chars    = max(80, conv_chars // max(max_conversation, 1))
            medium_chars  = max(60, conv_chars // 5)
            minimal_chars = max(40, conv_chars // 3)
        else:
            # Generous defaults when no budget constraint is given
            full_chars, medium_chars, minimal_chars = 400, 200, 100

        # Try building at full detail first
        result = self._build_context_at_detail(max_conversation, max_long_term, full_chars)

        if token_budget is None or not result:
            return result

        # Progressive reduction if over budget
        if estimate_tokens(result) > token_budget:
            result = self._build_context_at_detail(
                min(max_conversation, 5), min(max_long_term, 5), medium_chars,
            )

        if estimate_tokens(result) > token_budget:
            result = self._build_context_at_detail(3, 3, minimal_chars)

        # Last resort: hard truncate to the raw char equivalent of the budget
        if estimate_tokens(result) > token_budget:
            target_chars = token_budget * 4
            if len(result) > target_chars:
                result = result[-target_chars:]

        return result

    def _build_context_at_detail(
        self,
        max_msgs: int,
        max_lt: int,
        msg_truncate: int,
    ) -> str:
        """Build memory context with configurable detail levels."""
        sections = []

        messages = self.get_messages()
        if messages:
            recent_msgs = messages[-max_msgs:]
            conv_lines = []
            for msg in recent_msgs:
                role_label = "User" if msg["role"] == "user" else "Assistant"
                content = msg["content"]
                if len(content) > msg_truncate:
                    content = content[:msg_truncate] + "..."
                conv_lines.append(f"  {role_label}: {content}")
            sections.append("## Recent Conversation\n" + "\n".join(conv_lines))

        entries = self.long_term.load()
        if entries:
            recent_entries = entries[-max_lt:]
            recent_entries.reverse()
            lt_lines = [f"- {entry['content']}" for entry in recent_entries]
            sections.append("## Long-Term Memory\n" + "\n".join(lt_lines))

        return "\n\n".join(sections) if sections else ""


class ThreadMemoryStore:
    """
    Process-wide cache of ThreadMemory instances, one per thread_id,
    so every request for the same thread_id reuses the same
    ConversationHistory + LongTermMemory wiring instead of
    re-creating it (and re-reading the long-term JSON file from
    disk) on every single message.
    """

    def __init__(self, conversation_history: ConversationHistory = None):
        # Share ONE ConversationHistory across all threads (it's
        # already keyed internally by thread_id - see
        # memory/conversation_history.py), matching how router/apis.py
        # originally created one process-wide instance.
        self._conversation_history = conversation_history or ConversationHistory()
        self._threads: Dict[str, ThreadMemory] = {}

    def get(self, thread_id: str, devaccel_root: str = ".devaccel") -> ThreadMemory:
        """
        Get (or create) the ThreadMemory for thread_id. Long-term
        memory is stored at .devaccel/{thread_id}/long_term_memory.json
        - inside the same per-thread folder structure as
        input/workspace/output (see agent/workspace_paths.py), so a
        thread's entire footprint on disk lives in one place.
        """
        if thread_id not in self._threads:
            long_term_path = os.path.join(devaccel_root, thread_id, "long_term_memory.json")
            self._threads[thread_id] = ThreadMemory(
                thread_id=thread_id,
                conversation_history=self._conversation_history,
                long_term_file=long_term_path,
            )
        return self._threads[thread_id]
