"""Shared LangChain and Langfuse helpers for model and embedding calls."""
from __future__ import annotations

import os
from contextlib import nullcontext
from typing import Any


def is_langfuse_enabled() -> bool:
    return bool(os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"))


def get_langchain_config(*, run_name: str, metadata: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Return a LangChain config with Langfuse callbacks when configured."""
    config: dict[str, Any] = {"run_name": run_name}
    if metadata:
        config["metadata"] = metadata

    if not is_langfuse_enabled():
        return config

    try:
        from langfuse.langchain import CallbackHandler
    except ImportError:
        return config

    config["callbacks"] = [CallbackHandler()]
    return config


def start_langfuse_span(name: str, *, input_data: Any | None = None, metadata: dict[str, Any] | None = None):
    """Create a best-effort Langfuse span for non-callback code paths."""
    if not is_langfuse_enabled():
        return nullcontext(None)

    try:
        from langfuse import get_client
    except ImportError:
        return nullcontext(None)

    try:
        observation = get_client().start_as_current_observation(as_type="span", name=name)
    except Exception:
        return nullcontext(None)

    class _ObservationContext:
        def __enter__(self):
            span = observation.__enter__()
            if span is not None:
                try:
                    span.update(input=input_data, metadata=metadata)
                except Exception:
                    pass
            return span

        def __exit__(self, exc_type, exc, tb):
            return observation.__exit__(exc_type, exc, tb)

    return _ObservationContext()


def extract_text_content(response: Any) -> str:
    text = getattr(response, "text", None)
    if isinstance(text, str):
        return text.strip()

    content = getattr(response, "content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(part.strip() for part in parts if part and part.strip()).strip()
    return str(content or "").strip()