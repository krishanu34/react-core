"""Embeddings — provider-agnostic interface + client implementations."""

from .base import EmbeddingClient, EmbeddingError
from .factory import create_embeddings

__all__ = ["EmbeddingClient", "EmbeddingError", "create_embeddings"]
