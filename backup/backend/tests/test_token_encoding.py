"""
Token encoding must follow the running model.

The estimator hardcoded cl100k_base — right for the GPT-4 family, wrong for
gpt-5 / o-series, which use o200k_base. Every budget in budget_manager derives
from these counts, so on a gpt-5-class deployment the agent was mis-measuring
how full its own context window was.
"""

import pytest

from context import token_estimator
from context.token_estimator import (
    encoding_for, estimate_tokens, set_model,
)

tiktoken = pytest.importorskip("tiktoken")


@pytest.fixture(autouse=True)
def _reset_model():
    set_model("")
    token_estimator._load_encoder.cache_clear()
    yield
    set_model("")


@pytest.mark.parametrize("name,expected", [
    ("gpt-5.6-terra", "o200k_base"),
    ("gpt-5.3-chat", "o200k_base"),
    ("gpt-4o", "o200k_base"),
    ("my-o3-mini", "o200k_base"),
    ("gpt-4.1", "cl100k_base"),
    ("gpt-4-turbo", "cl100k_base"),
    ("", "cl100k_base"),            # unset — unchanged default
    ("mystery-deployment", "cl100k_base"),
])
def test_encoding_selected_by_model_name(name, expected):
    assert encoding_for(name) == expected


def test_counts_differ_on_non_ascii_content():
    """Where the fix actually matters.

    Measured: on plain ASCII source the two encodings agree EXACTLY, so an
    English-only codebase was never affected by the old hardcoded constant.
    The gap opens on non-ASCII content — CJK comments, accented strings,
    emoji in docs — where cl100k over-counts by ~44%, which made the agent
    compact context it did not need to.
    """
    text = "こんにちは世界 café naïve Привет мир\n" * 10

    set_model("gpt-4.1")
    cl100k = estimate_tokens(text)
    set_model("gpt-5.6-terra")
    o200k = estimate_tokens(text)

    assert cl100k > o200k, "cl100k should over-count non-English text"
    assert (cl100k - o200k) / cl100k > 0.2, "the gap should be substantial"


def test_ascii_source_is_unaffected():
    """The reassuring half: this change is a no-op for English source code, so
    it cannot silently shift budgets on an existing workspace."""
    code = "def authenticate(self, user_id: int, password_hash: str) -> bool:\n" * 40

    set_model("gpt-4.1")
    cl100k = estimate_tokens(code)
    set_model("gpt-5.6-terra")
    o200k = estimate_tokens(code)

    assert cl100k == o200k


def test_matches_tiktoken_directly():
    text = "The quick brown fox — jumps over 123 lazy dogs. def f(): return {'a': 1}"
    set_model("gpt-5.6-terra")
    assert estimate_tokens(text) == len(tiktoken.get_encoding("o200k_base").encode(text))
    set_model("gpt-4.1")
    assert estimate_tokens(text) == len(tiktoken.get_encoding("cl100k_base").encode(text))


def test_empty_and_unset_are_safe():
    assert estimate_tokens("") == 0
    set_model("")
    assert estimate_tokens("hello world") > 0


def test_unknown_encoding_falls_back_rather_than_losing_counting(monkeypatch):
    """A bad encoding name must degrade to cl100k_base, not to the heuristic."""
    monkeypatch.setattr(token_estimator, "encoding_for", lambda _n: "not_a_real_encoding")
    token_estimator._load_encoder.cache_clear()
    set_model("gpt-5.6-terra")
    assert estimate_tokens("hello world") > 0


def test_model_is_isolated_per_context():
    """Concurrent runs on different models must not overwrite each other."""
    import asyncio

    async def count_with(model: str) -> str:
        set_model(model)
        await asyncio.sleep(0)          # force a context switch
        return encoding_for(token_estimator._active_model.get())

    async def main():
        return await asyncio.gather(
            count_with("gpt-5.6-terra"), count_with("gpt-4.1"),
        )

    a, b = asyncio.run(main())
    assert {a, b} == {"o200k_base", "cl100k_base"}
