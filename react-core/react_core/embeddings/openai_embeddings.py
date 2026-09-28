"""OpenAI embeddings client (drop-in alternative to Gemini)."""
from __future__ import annotations

import os

from ..ai_stack import start_langfuse_span
from .base import EmbeddingClient, EmbeddingError


class OpenAIEmbeddings(EmbeddingClient):
    def __init__(self, api_key: str | None = None, model: str | None = None):
        api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            raise EmbeddingError("OPENAI_API_KEY is not set")
        try:
            from langchain_openai import OpenAIEmbeddings as LangChainOpenAIEmbeddings
        except ImportError as e:
            raise EmbeddingError("langchain-openai package is not installed") from e
        self._model = model or os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
        self._client = LangChainOpenAIEmbeddings(model=self._model, api_key=api_key)

    @property
    def model_name(self) -> str:
        return self._model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            with start_langfuse_span(
                "openai.embed_documents",
                input_data={"texts": len(texts)},
                metadata={"provider": "openai", "model": self._model, "component": "embeddings"},
            ):
                return await self._client.aembed_documents(list(texts))
        except Exception as e:  # noqa: BLE001
            raise EmbeddingError(f"OpenAI embed request failed: {e}") from e
