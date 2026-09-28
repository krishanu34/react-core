"""Embedding factory: picks the provider from `EMBEDDING_PROVIDER` env var."""
from __future__ import annotations

import os

from .base import EmbeddingClient, EmbeddingError


def create_embeddings() -> EmbeddingClient:
    provider = os.getenv("EMBEDDING_PROVIDER", "gemini").strip().lower()
    if provider == "gemini":
        from .gemini_embeddings import GeminiEmbeddings
        return GeminiEmbeddings()
    if provider == "openai":
        from .openai_embeddings import OpenAIEmbeddings
        return OpenAIEmbeddings()
    if provider == "azure":
        from .azure_openai_embeddings import AzureOpenAIEmbeddings
        return AzureOpenAIEmbeddings()
    raise EmbeddingError(
        f"Unknown EMBEDDING_PROVIDER: {provider!r} (expected 'gemini', 'openai', or 'azure')"
    )
