"""
Token Estimator

Counts tokens with tiktoken, using the encoding the RUNNING model actually
uses. The encoder is loaded once per encoding and cached — subsequent calls
are instant.

Why the encoding is not a constant: this module hardcoded `cl100k_base`, which
is correct for the GPT-4 family and WRONG for the gpt-5 / o-series family,
which use `o200k_base`. Every budget in context/budget_manager.py is computed
from these counts, so on a gpt-5-class deployment the agent was mis-measuring
how full its own context window was.

Measured, so nobody has to guess how much this matters (identical input, both
encoders):

    plain ASCII source code    cl100k 240   o200k 240   no difference
    JSON, numbers, indented    cl100k 300   o200k 300   no difference
    non-English text           cl100k 130   o200k  90   cl100k +44%
    emoji / rich markdown      cl100k 150   o200k 120   cl100k +25%

So for an English-only codebase the old constant was harmless, and the fix
changes nothing. It matters for workspaces with non-ASCII content — CJK
comments and identifiers, accented strings, emoji in docs — where cl100k
over-counts badly enough to make the agent compact context it did not need to,
throwing away history to make room that was already there.

The active model is set once per run by the router (`set_model`). Nothing
calls it in tests or scripts, so the default stays cl100k_base and behaviour
there is unchanged.

Falls back to a word-based heuristic if tiktoken is not installed.
Install it for exact counts:  pip install tiktoken
"""

import functools
import re
from contextvars import ContextVar

# Families that use o200k_base. Same matching rule as
# llm/model_capabilities.py::_REASONING_NAME so one deployment name cannot be
# "reasoning-class" for parameters and "GPT-4-class" for tokens.
_O200K_NAME = re.compile(r"gpt-5|gpt-4o|(?:^|[-_/])o[134](?:[-_.]|$)", re.IGNORECASE)

# Deployment/model name for the current run. A ContextVar, not a global, so
# concurrent runs on different models don't overwrite each other's encoding.
_active_model: ContextVar[str] = ContextVar("devsphere_token_model", default="")


def set_model(model_or_deployment: str) -> None:
    """Bind the model this run executes on, so counts use its encoding."""
    _active_model.set(model_or_deployment or "")


def encoding_for(model_or_deployment: str) -> str:
    """Which tiktoken encoding a model name implies."""
    return "o200k_base" if _O200K_NAME.search(model_or_deployment or "") else "cl100k_base"


@functools.lru_cache(maxsize=4)
def _load_encoder(encoding_name: str):
    """Load and cache one encoder. Cached per encoding rather than per
    process, so a host serving two model families pays the load cost twice
    and never again."""
    try:
        import tiktoken
        return tiktoken.get_encoding(encoding_name)
    except Exception:  # noqa: BLE001 — tiktoken missing or encoding unknown
        return None


def _get_encoder():
    """The encoder for the model this run is on."""
    enc = _load_encoder(encoding_for(_active_model.get()))
    if enc is None and _active_model.get():
        # An unknown encoding name must not cost us exact counting entirely.
        enc = _load_encoder("cl100k_base")
    return enc


def estimate_tokens(text: str) -> int:
    """
    Count tokens in a text string.

    Uses tiktoken with the running model's encoding when available.
    Falls back to a word-based heuristic otherwise.
    """
    if not text:
        return 0

    enc = _get_encoder()
    if enc is not None:
        return len(enc.encode(text))

    # Heuristic: each word ≈ 1 token for short words,
    # more tokens for long identifiers (camelCase, snake_case, etc.)
    return sum(max(1, len(word) // 4 + 1) for word in text.split())


def estimate_messages_tokens(messages: list) -> int:
    """
    Estimate tokens for a chat messages list:
    [{"role": "system", "content": "..."}, ...]

    Accounts for per-message overhead (~4 tokens each for role and
    message separators) and reply-priming overhead (~3 tokens).

    Handles both plain-string content and multipart content lists
    (text + image_url blocks — e.g. vision requests).
    """
    if not messages:
        return 0

    total = 3  # reply priming overhead
    for msg in messages:
        total += 4  # per-message overhead (role + separators)
        content = msg.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    total += estimate_tokens(part.get("text", ""))
                elif isinstance(part, dict) and part.get("type") == "image_url":
                    # OpenAI charges ~85 tokens base per image tile
                    total += 85
        elif content:
            total += estimate_tokens(content)

    return total
