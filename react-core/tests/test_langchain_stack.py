from __future__ import annotations

import asyncio
import sys
import types


def test_openai_llm_uses_langchain_and_returns_text(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-test")

    class _FakeChatOpenAI:
        def __init__(self, **kwargs):
            self.init_kwargs = kwargs

        async def ainvoke(self, messages, config=None, **kwargs):
            assert messages == [{"role": "user", "content": "hello"}]
            assert kwargs["temperature"] == 0.4
            assert kwargs["max_tokens"] == 32
            assert kwargs["response_format"] == {"type": "json_object"}
            assert config["run_name"] == "openai.chat"
            return types.SimpleNamespace(content="  world  ")

    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(ChatOpenAI=_FakeChatOpenAI))

    from react_core.llm.openai_client import OpenAILLM

    client = OpenAILLM()
    result = asyncio.run(
        client.complete(
            [{"role": "user", "content": "hello"}],
            temperature=0.4,
            max_tokens=32,
            response_format={"type": "json_object"},
        )
    )
    assert result == "world"


def test_azure_llm_retries_without_temperature_when_model_rejects_it(monkeypatch):
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5.6-terra")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "gpt-5.6-terra")

    class _FakeAzureChatOpenAI:
        def __init__(self, **kwargs):
            self.init_kwargs = kwargs
            self.calls = []

        async def ainvoke(self, messages, config=None, **kwargs):
            self.calls.append(kwargs)
            if "temperature" in kwargs:
                raise Exception(
                    "Error code: 400 - {'error': {'message': \"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.\"}}"
                )
            return types.SimpleNamespace(content="  retried ok  ")

    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(AzureChatOpenAI=_FakeAzureChatOpenAI))

    from react_core.llm.azure_openai import AzureOpenAILLM

    client = AzureOpenAILLM()
    result = asyncio.run(client.complete([{"role": "user", "content": "hello"}], temperature=0.2))
    assert result == "retried ok"
    assert len(client._client.calls) == 2
    assert client._client.calls[0]["temperature"] == 0.2
    assert "temperature" not in client._client.calls[1]


def test_openai_embeddings_use_langchain(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-test")

    class _FakeEmbeddings:
        def __init__(self, **kwargs):
            self.init_kwargs = kwargs

        async def aembed_documents(self, texts):
            assert texts == ["alpha", "beta"]
            return [[1.0, 2.0], [3.0, 4.0]]

    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(OpenAIEmbeddings=_FakeEmbeddings))

    from react_core.embeddings.openai_embeddings import OpenAIEmbeddings

    client = OpenAIEmbeddings()
    result = asyncio.run(client.embed(["alpha", "beta"]))
    assert result == [[1.0, 2.0], [3.0, 4.0]]


def test_gemini_embeddings_use_langchain(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-test")

    class _FakeEmbeddings:
        def __init__(self, **kwargs):
            self.init_kwargs = kwargs

        async def aembed_documents(self, texts):
            assert texts == ["alpha", "beta"]
            return [[5.0, 6.0], [7.0, 8.0]]

    monkeypatch.setitem(
        sys.modules,
        "langchain_google_genai",
        types.SimpleNamespace(GoogleGenerativeAIEmbeddings=_FakeEmbeddings),
    )

    from react_core.embeddings.gemini_embeddings import GeminiEmbeddings

    client = GeminiEmbeddings()
    result = asyncio.run(client.embed(["alpha", "beta"]))
    assert result == [[5.0, 6.0], [7.0, 8.0]]


def test_embedding_factory_supports_azure(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "azure")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-test")
    monkeypatch.setenv("AZURE_OPENAI_EMBEDDING_API_VERSION", "2024-05-01-preview")

    class _FakeEmbeddings:
        def __init__(self, **kwargs):
            self.init_kwargs = kwargs

        async def aembed_documents(self, texts):
            return [[0.1] for _ in texts]

    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(OpenAIEmbeddings=_FakeEmbeddings))

    from react_core.embeddings.factory import create_embeddings

    client = create_embeddings()
    assert client.model_name == "text-embedding-test"
    assert client._client.init_kwargs["default_headers"] == {"api-version": "2024-05-01-preview"}