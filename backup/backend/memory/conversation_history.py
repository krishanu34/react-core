"""
Conversation History - In-Memory Store

Why this is a SEPARATE thing from memory/short_term.py:

ShortTermMemory (memory/short_term.py) holds the Thought/Action/
Observation scratchpad for ONE call to agent.run() - the agent's
internal "working notes" while it figures out an answer. It gets
thrown away the moment that one answer is produced.

ConversationHistory (this file) holds the actual back-and-forth
chat messages between the user and the assistant - what you'd see
rendered in a chat UI. It needs to survive ACROSS multiple separate
requests to the API (the user sends message 1, gets a reply, then
sends message 2 and the assistant should still remember message 1).

In other words: ShortTermMemory is about HOW the agent thinks
through a single answer. ConversationHistory is about WHAT was
said in the conversation overall, across many answers.

Why in-memory and not a database?
Per your requirements, this just needs to live in the server
process's memory while it's running. If the server restarts, history
is gone - that's an accepted tradeoff for keeping this simple. If you
need persistence later, the LongTermMemory pattern (memory/long_term.py)
shows how you'd swap a JSON file or database in without changing how
the rest of the app calls this class.
"""

import uuid


class ConversationHistory:
    """
    Stores chat messages for many separate conversations at once,
    keyed by a conversation_id (so multiple users/chat sessions
    don't see each other's messages).

    Internally this is just a dict of lists:
        {
            "conv-abc123": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello!"},
            ],
            "conv-def456": [...],
        }

    Each message dict follows the same {"role": ..., "content": ...}
    shape that the LLM's invoke()/stream() methods expect for their
    `messages` argument, so you can pass history straight through
    without reformatting it.
    """

    def __init__(self):
        self._conversations: dict[str, list[dict]] = {}

    def create_conversation(self) -> str:
        """
        Start a brand new, empty conversation and return its id.
        Call this once when a user starts a new chat session.
        """
        conversation_id = str(uuid.uuid4())
        self._conversations[conversation_id] = []
        return conversation_id

    def add_message(self, conversation_id: str, role: str, content: str):
        """
        Append one message to a conversation's history.

        role: "user", "assistant", or "system"
        content: the actual text of the message

        If the conversation_id doesn't exist yet (e.g. the caller
        forgot to call create_conversation(), or is using their own
        id scheme), we create it on the fly rather than raising an
        error - this keeps the API forgiving to use.
        """
        if conversation_id not in self._conversations:
            self._conversations[conversation_id] = []

        self._conversations[conversation_id].append({
            "role": role,
            "content": content,
        })

    def get_messages(self, conversation_id: str) -> list[dict]:
        """
        Return the full message history for a conversation, oldest
        first, in the exact {"role", "content"} shape the LLM expects.
        Returns an empty list if the conversation doesn't exist yet,
        rather than raising - a brand new conversation simply has no
        history yet, which isn't an error condition.
        """
        return self._conversations.get(conversation_id, [])

    def clear_conversation(self, conversation_id: str):
        """
        Wipe one conversation's history while keeping the id valid
        (so the next message starts fresh, but you don't need to
        hand the client a new id).
        """
        self._conversations[conversation_id] = []

    def delete_conversation(self, conversation_id: str):
        """
        Remove a conversation entirely, including its id. Use this
        when a chat session is truly over and you want to free the
        memory it was using.
        """
        self._conversations.pop(conversation_id, None)
