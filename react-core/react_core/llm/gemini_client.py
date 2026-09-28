"""Google Gemini LLM client."""
from __future__ import annotations

import os
from typing import Any

from ..ai_stack import extract_text_content, get_langchain_config
from .base import LLMClient, LLMError


class GeminiLLM(LLMClient):
    def __init__(self, api_key: str | None = None, model: str | None = None):
        api_key = api_key or os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise LLMError("GEMINI_API_KEY is not set")
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError as e:
            raise LLMError(
                "langchain-google-genai package is not installed. Add it to "
                "requirements.txt and pip install."
            ) from e
        self._model = model or os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self._client = ChatGoogleGenerativeAI(model=self._model, api_key=api_key)

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
        kwargs: dict[str, Any] = {"temperature": temperature}
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format and response_format.get("type") == "json_object":
            kwargs["response_mime_type"] = "application/json"

        try:
            resp = await self._client.ainvoke(
                list(messages),
                config=get_langchain_config(
                    run_name="gemini.chat",
                    metadata={"provider": "gemini", "model": self._model, "component": "llm"},
                ),
                **kwargs,
            )
        except Exception as e:  # noqa: BLE001
            raise LLMError(f"Gemini request failed: {e}") from e

        return extract_text_content(resp)


def convert_messages(
    messages: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    """OpenAI-style chat messages → (system_instruction, gemini contents).

    - `system` messages are joined into a single system_instruction.
    - `assistant` maps to Gemini's `model` role.
    - `user` stays `user`.
    - Empty messages are dropped.
    """
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []
    for msg in messages or []:
        role = str(msg.get("role", "user")).lower()
        content = msg.get("content", "")
        if isinstance(content, list):
            text_parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
            content = "\n".join(text_parts)
        content = str(content or "").strip()
        if not content:
            continue
        if role == "system":
            system_parts.append(content)
            continue
        gemini_role = "model" if role == "assistant" else "user"
        contents.append({"role": gemini_role, "parts": [{"text": content}]})
    return "\n\n".join(system_parts), contents
