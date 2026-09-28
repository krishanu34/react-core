"""
Token Tracking - Azure OpenAI Tracker

This is the ONLY file that needs to know Azure/OpenAI's specific
field names for token usage ("prompt_tokens", "completion_tokens",
"total_tokens"). If you add a second provider later (Anthropic,
local model, etc.), you write one more small file like this one -
you do NOT touch BaseTokenTracker or anything that consumes it.
"""

from .base_tracking import BaseTokenTracker, TokenUsage


class AzureTokenTracker(BaseTokenTracker):
    """
    Translates Azure OpenAI's raw usage dict into our normalized
    TokenUsage shape.

    Azure's raw usage dict (from either invoke() or the final chunk
    of stream()) looks like:

        {
            "prompt_tokens": 123,
            "completion_tokens": 45,
            "total_tokens": 168
        }

    Conveniently, Azure's field names already match our normalized
    names exactly, so this translation is almost a no-op. That won't
    be true for every provider (Anthropic uses "input_tokens" and
    "output_tokens", for example) - which is exactly why this
    translation step exists as its own method instead of just
    storing the raw dict directly. If Azure ever changes their field
    names, or you want to track a different provider, only THIS file
    needs to change.
    """

    def record_usage(self, raw_usage: dict, model: str = "unknown") -> TokenUsage:
        usage = TokenUsage(
            prompt_tokens=raw_usage.get("prompt_tokens", 0),
            completion_tokens=raw_usage.get("completion_tokens", 0),
            total_tokens=raw_usage.get("total_tokens", 0),
            model=model,
        )
        self._history.append(usage)
        return usage
