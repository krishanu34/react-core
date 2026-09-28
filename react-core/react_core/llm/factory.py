"""LLM factory: picks the provider from `LLM_PROVIDER` env var.

Providers imported lazily so switching (`gemini` → `openai` → `azure`) doesn't
require every SDK to be installed.
"""
from __future__ import annotations

import os

from .base import LLMClient, LLMError


def create_llm() -> LLMClient:
    provider = os.getenv("LLM_PROVIDER", "gemini").strip().lower()
    if provider == "gemini":
        from .gemini_client import GeminiLLM
        return GeminiLLM()
    if provider == "openai":
        from .openai_client import OpenAILLM
        return OpenAILLM()
    if provider == "azure":
        from .azure_openai import AzureOpenAILLM
        return AzureOpenAILLM()
    raise LLMError(
        f"Unknown LLM_PROVIDER: {provider!r} (expected 'gemini', 'openai', or 'azure')"
    )
