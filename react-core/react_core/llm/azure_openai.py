"""Azure OpenAI Chat Completions client."""
from __future__ import annotations

import os
from typing import Any

from ..ai_stack import extract_text_content, get_langchain_config
from .base import LLMClient, LLMError


def _is_unsupported_temperature_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "unsupported value" in message
        and "temperature" in message
        and "default (1) value is supported" in message
    )


class AzureOpenAILLM(LLMClient):
    def __init__(
        self,
        api_key: str | None = None,
        endpoint: str | None = None,
        deployment: str | None = None,
        model: str | None = None,
        api_version: str | None = None,
    ):
        api_key = api_key or os.getenv("AZURE_OPENAI_API_KEY", "")
        endpoint = endpoint or os.getenv("AZURE_OPENAI_ENDPOINT", "")
        deployment = deployment or os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
        model = model or os.getenv("AZURE_OPENAI_MODEL", deployment)
        api_version = api_version or os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview")
        missing = [
            n for n, v in (
                ("AZURE_OPENAI_API_KEY", api_key),
                ("AZURE_OPENAI_ENDPOINT", endpoint),
                ("AZURE_OPENAI_DEPLOYMENT", deployment),
            ) if not v
        ]
        if missing:
            raise LLMError(f"Azure OpenAI missing env vars: {', '.join(missing)}")
        try:
            from langchain_openai import AzureChatOpenAI
        except ImportError as e:
            raise LLMError("langchain-openai package is not installed") from e
        self._client = AzureChatOpenAI(
            api_key=api_key,
            azure_endpoint=endpoint,
            api_version=api_version,
            azure_deployment=deployment,
            model=model,
        )
        self._deployment = deployment
        self._model = model

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
        config = get_langchain_config(
            run_name="azure.chat",
            metadata={"provider": "azure", "model": self._model, "deployment": self._deployment, "component": "llm"},
        )
        try:
            resp = await self._client.ainvoke(list(messages), config=config, **kwargs)
        except Exception as e:  # noqa: BLE001
            if "temperature" in kwargs and _is_unsupported_temperature_error(e):
                try:
                    retry_kwargs = dict(kwargs)
                    retry_kwargs.pop("temperature", None)
                    resp = await self._client.ainvoke(list(messages), config=config, **retry_kwargs)
                except Exception as retry_error:  # noqa: BLE001
                    raise LLMError(f"Azure OpenAI request failed: {retry_error}") from retry_error
            else:
                raise LLMError(f"Azure OpenAI request failed: {e}") from e
        return extract_text_content(resp)
