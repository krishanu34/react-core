"""Common interface every embedding client implements."""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class EmbeddingClient(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

    @property
    def model_name(self) -> str: ...


class EmbeddingError(Exception):
    """Wraps provider errors so callers can surface a friendly message."""
