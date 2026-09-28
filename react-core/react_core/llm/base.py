"""Common interface every LLM client implements."""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class LLMClient(Protocol):
    async def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> str: ...

    @property
    def model_name(self) -> str: ...


class LLMError(Exception):
    """Wraps provider errors so the loop can surface a friendly message."""
