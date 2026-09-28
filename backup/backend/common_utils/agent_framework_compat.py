"""
Compatibility shim for ``agent_framework.azure.AzureOpenAIResponsesClient``.

Older versions of ``agent-framework`` exported a dedicated
``AzureOpenAIResponsesClient`` from ``agent_framework.azure``. Newer
versions (e.g. 1.3.0) removed that class; the same capability is
provided by ``agent_framework.openai.OpenAIChatClient`` when passed
``azure_endpoint=...``.

Use :func:`make_azure_responses_client` everywhere the code needs an
Azure-backed Responses-style chat client. It prefers the legacy class
when present and transparently falls back to ``OpenAIChatClient``.
"""
from __future__ import annotations

from typing import Any


def make_azure_responses_client(
    *,
    deployment_name: str | None,
    endpoint: str | None,
    api_key: str | None,
    api_version: str | None = "preview",
    **extra: Any,
) -> Any:
    """Return an Azure-OpenAI chat client compatible with both old and
    new ``agent-framework`` versions.

    Parameters mirror the original ``AzureOpenAIResponsesClient`` constructor.
    """
    # Prefer the legacy dedicated class when available.
    try:
        from agent_framework.azure import AzureOpenAIResponsesClient  # type: ignore
    except ImportError:
        AzureOpenAIResponsesClient = None  # type: ignore[assignment]

    if AzureOpenAIResponsesClient is not None:
        # The Responses route only accepts api_version="preview" regardless
        # of what the caller (which may target chat/completions) provided.
        return AzureOpenAIResponsesClient(
            deployment_name=deployment_name,
            endpoint=endpoint,
            api_key=api_key,
            api_version="preview",
            **extra,
        )

    # Fallback path for agent-framework >= 1.3 where the dedicated Azure
    # Responses client was removed.
    #
    # IMPORTANT: We deliberately use ``OpenAIChatCompletionClient`` (NOT
    # ``OpenAIChatClient``). ``OpenAIChatClient`` routes to Azure's
    # ``/openai/v1/responses`` endpoint, which is preview-only and not
    # enabled on every Azure OpenAI resource/region. Hitting it on a
    # resource that lacks it returns:
    #     openai.NotFoundError: 404 {'error': {'code': '404',
    #     'message': 'Resource not found'}}
    # ``OpenAIChatCompletionClient`` uses the universally-available
    # ``/openai/deployments/{deployment}/chat/completions`` route, which
    # works with any dated api-version (e.g. ``2024-05-01-preview``,
    # ``2024-10-21``) on any Azure OpenAI deployment.
    from agent_framework_openai import OpenAIChatCompletionClient  # type: ignore

    # Build an AsyncAzureOpenAI with generous timeouts + retries so slow
    # corporate links / occasional TLS reconnects don't blow up long
    # workflow steps (validate, plan, execute). Defaults via env:
    #   CB_OPENAI_CONNECT_TIMEOUT  (default 30)
    #   CB_OPENAI_READ_TIMEOUT     (default 600)
    #   CB_OPENAI_WRITE_TIMEOUT    (default 60)
    #   CB_OPENAI_POOL_TIMEOUT     (default 30)
    #   CB_OPENAI_MAX_RETRIES      (default 3)
    import os
    import httpx
    from openai import AsyncAzureOpenAI

    timeout = httpx.Timeout(
        connect=float(os.getenv("CB_OPENAI_CONNECT_TIMEOUT", "30")),
        read=float(os.getenv("CB_OPENAI_READ_TIMEOUT", "600")),
        write=float(os.getenv("CB_OPENAI_WRITE_TIMEOUT", "60")),
        pool=float(os.getenv("CB_OPENAI_POOL_TIMEOUT", "30")),
    )
    max_retries = int(os.getenv("CB_OPENAI_MAX_RETRIES", "3"))

    # /chat/completions requires a dated api-version. Honour whatever the
    # caller passed (DB rows typically store a valid one); only fall back
    # to a known-good default when nothing was supplied.
    effective_api_version = api_version or "2024-10-21"
    if effective_api_version == "preview":
        # "preview" is a Responses-only token; map it to a dated version
        # that the Chat-Completions route actually accepts.
        effective_api_version = "2024-10-21"

    async_client = AsyncAzureOpenAI(
        api_key=api_key,
        azure_endpoint=endpoint or "",
        api_version=effective_api_version,
        timeout=timeout,
        max_retries=max_retries,
    )

    return OpenAIChatCompletionClient(
        model=deployment_name,
        async_client=async_client,
        **extra,
    )
