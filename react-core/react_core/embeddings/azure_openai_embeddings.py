"""Azure OpenAI embeddings client backed by LangChain."""
from __future__ import annotations

import os

from ..ai_stack import start_langfuse_span
from .base import EmbeddingClient, EmbeddingError


class AzureOpenAIEmbeddings(EmbeddingClient):
    def __init__(
        self,
        api_key: str | None = None,
        endpoint: str | None = None,
        deployment: str | None = None,
        api_version: str | None = None,
    ):
        api_key = api_key or os.getenv("AZURE_OPENAI_API_KEY", "")
        endpoint = endpoint or os.getenv("AZURE_OPENAI_ENDPOINT", "")
        deployment = deployment or os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "")
        api_version = api_version or os.getenv(
            "AZURE_OPENAI_EMBEDDING_API_VERSION",
            os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview"),
        )
        missing = [
            name for name, value in (
                ("AZURE_OPENAI_API_KEY", api_key),
                ("AZURE_OPENAI_ENDPOINT", endpoint),
                ("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", deployment),
            ) if not value
        ]
        if missing:
            raise EmbeddingError(f"Azure OpenAI missing env vars: {', '.join(missing)}")
        try:
            from langchain_openai import OpenAIEmbeddings as LangChainOpenAIEmbeddings
        except ImportError as e:
            raise EmbeddingError("langchain-openai package is not installed") from e

        self._deployment = deployment
        self._api_version = api_version
        self._client = LangChainOpenAIEmbeddings(
            model=deployment,
            api_key=api_key,
            base_url=f"{endpoint.rstrip('/')}/openai/v1/",
            default_headers={"api-version": api_version},
        )

    @property
    def model_name(self) -> str:
        return self._deployment

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            with start_langfuse_span(
                "azure.embed_documents",
                input_data={"texts": len(texts)},
                metadata={
                    "provider": "azure",
                    "deployment": self._deployment,
                    "api_version": self._api_version,
                    "component": "embeddings",
                },
            ):
                return await self._client.aembed_documents(list(texts))
        except Exception as e:  # noqa: BLE001
            raise EmbeddingError(f"Azure OpenAI embed request failed: {e}") from e