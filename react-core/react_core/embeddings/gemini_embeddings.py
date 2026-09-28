"""Gemini embeddings client."""
from __future__ import annotations

import os

from ..ai_stack import start_langfuse_span
from .base import EmbeddingClient, EmbeddingError


class GeminiEmbeddings(EmbeddingClient):
    def __init__(self, api_key: str | None = None, model: str | None = None):
        api_key = api_key or os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise EmbeddingError("GEMINI_API_KEY is not set")
        try:
            from langchain_google_genai import GoogleGenerativeAIEmbeddings
        except ImportError as e:
            raise EmbeddingError(
                "langchain-google-genai package is not installed. Add it to "
                "requirements.txt and pip install."
            ) from e
        self._model = model or os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
        self._client = GoogleGenerativeAIEmbeddings(model=self._model, google_api_key=api_key)

    @property
    def model_name(self) -> str:
        return self._model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            with start_langfuse_span(
                "gemini.embed_documents",
                input_data={"texts": len(texts)},
                metadata={"provider": "gemini", "model": self._model, "component": "embeddings"},
            ):
                return await self._client.aembed_documents(list(texts))
        except Exception as e:  # noqa: BLE001
            raise EmbeddingError(f"Gemini embed request failed: {e}") from e
