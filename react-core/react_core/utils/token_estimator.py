"""Token counter — tiktoken with a graceful fallback.

Pick the encoding from the running model name (o200k_base for the gpt-4o /
gpt-5 / o-series families, cl100k_base otherwise). Cache one encoder per
encoding for the process. If tiktoken isn't installed, fall back to a
word-based heuristic so budget code keeps working — counts will be rough but
the system won't crash.
"""
from __future__ import annotations

import functools
import re
from contextvars import ContextVar

_O200K_NAME = re.compile(r"gpt-5|gpt-4o|(?:^|[-_/])o[134](?:[-_.]|$)", re.IGNORECASE)

_active_model: ContextVar[str] = ContextVar("react_core_token_model", default="")


def set_model(model_or_deployment: str) -> None:
    _active_model.set(model_or_deployment or "")


def encoding_for(model_or_deployment: str) -> str:
    return "o200k_base" if _O200K_NAME.search(model_or_deployment or "") else "cl100k_base"


@functools.lru_cache(maxsize=4)
def _load_encoder(encoding_name: str):
    try:
        import tiktoken
        return tiktoken.get_encoding(encoding_name)
    except Exception:  # noqa: BLE001
        return None


def _get_encoder():
    enc = _load_encoder(encoding_for(_active_model.get()))
    if enc is None and _active_model.get():
        enc = _load_encoder("cl100k_base")
    return enc


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    enc = _get_encoder()
    if enc is not None:
        return len(enc.encode(text))
    return sum(max(1, len(word) // 4 + 1) for word in text.split())


def estimate_messages_tokens(messages: list[dict]) -> int:
    if not messages:
        return 0
    total = 3  # reply-priming overhead
    for msg in messages:
        total += 4  # per-message overhead (role + separators)
        content = msg.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    total += estimate_tokens(part.get("text", ""))
        elif content:
            total += estimate_tokens(content)
    return total
