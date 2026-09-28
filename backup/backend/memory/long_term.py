import json
import os
from datetime import datetime, timezone


class LongTermMemory:
    """
    This holds facts/notes that should survive AFTER a run() call
    finishes, so a future run() call (maybe tomorrow, maybe in a
    totally separate Python process) can still see them.

    Unlike ShortTermMemory, this writes to a real file on disk, so
    it isn't lost when the program exits.

    Why JSON instead of a database?
    Because right now you just need "remember a few things between
    runs", not querying or searching at scale. JSON is plain text,
    easy to open and read yourself, and needs zero extra setup. If
    this ever needs to scale up (lots of memories, need to search by
    similarity, etc.) you'd swap this out for a real database or a
    vector store - but the rest of your code wouldn't need to change,
    because it only talks to this class through load()/save()/add().
    """

    def __init__(self, file_path="memory/long_term_memory.json"):
        self.file_path = file_path
        self._ensure_file_exists()

    def _ensure_file_exists(self):
        """
        If the JSON file doesn't exist yet (e.g. first time this
        agent has ever run), create it with an empty list so that
        every other method can assume the file is always there and
        always valid JSON.
        """
        if not os.path.exists(self.file_path):
            os.makedirs(os.path.dirname(self.file_path) or ".", exist_ok=True)
            with open(self.file_path, "w") as f:
                json.dump([], f)

    def load(self):
        """
        Read everything currently stored and return it as a list of
        dicts. If the file is somehow empty or corrupted, fail safe
        and return an empty list rather than crashing the agent.
        """
        try:
            with open(self.file_path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            return []

    def save_all(self, memories):
        """
        Overwrite the file with a full new list of memories. You
        usually won't call this directly - prefer add() below, which
        appends one memory at a time without you having to manually
        load -> modify -> save yourself.
        """
        with open(self.file_path, "w") as f:
            json.dump(memories, f, indent=2)

    def add(self, content, tags=None):
        """
        Append ONE new memory and immediately persist it to disk.

        content: whatever you want to remember, as plain text
                 (e.g. "User prefers metric units")
        tags:    optional list of strings to help you find this again
                 later, e.g. ["preference", "units"]

        Each memory gets a timestamp automatically, so you can see
        when it was learned.
        """
        memories = self.load()
        memories.append(
            {
                "content": content,
                "tags": tags or [],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        self.save_all(memories)

    def search(self, tag):
        """
        Very simple lookup: return all memories that include the
        given tag. This is intentionally basic (exact tag match, no
        fuzzy search) - good enough for "has the agent already learned
        something about X" type checks.
        """
        return [m for m in self.load() if tag in m.get("tags", [])]