"""OpenAI Chat Completions client."""
from __future__ import annotations

import os
from typing import Any

from ..ai_stack import extract_text_content, get_langchain_config
from .base import LLMClient, LLMError


class OpenAILLM(LLMClient):
    def __init__(self, api_key: str | None = None, model: str | None = None):
        api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            raise LLMError("OPENAI_API_KEY is not set")
        try:
            from langchain_openai import ChatOpenAI
        except ImportError as e:
            raise LLMError("langchain-openai package is not installed") from e
        self._model = model or os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self._client = ChatOpenAI(model=self._model, api_key=api_key)

    @property
    def model_name(self) -> str:
        return self._model

    async def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> str:
        kwargs: dict[str, Any] = {
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format is not None:
            kwargs["response_format"] = response_format
        try:
            resp = await self._client.ainvoke(
                list(messages),
                config=get_langchain_config(
                    run_name="openai.chat",
                    metadata={"provider": "openai", "model": self._model, "component": "llm"},
                ),
                **kwargs,
            )
        except Exception as e:  # noqa: BLE001 — surface provider error verbatim
            raise LLMError(f"OpenAI request failed: {e}") from e
        return extract_text_content(resp)
