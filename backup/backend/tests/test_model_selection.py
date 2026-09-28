"""
Per-agent model selection.

Wide mechanical work (searching, listing, summarising) doesn't need the same
model as work requiring judgement. Without this, every child in a fan-out ran on
the main model and a 10-agent investigation cost 10× the premium rate.

The rule that keeps it safe: aliases are OPERATOR config. An agent asks for
"fast"; only the operator decides which deployment that is. An unknown alias
falls back to the parent's model — it never reaches the API as a raw deployment
name, and it never fails the spawn.
"""

from __future__ import annotations

import pytest

from llm.factory import LLMFactory, context_window_for_alias
from tools.base_tool import BaseTool
from tools.registry import ToolRegistry
from tools.sub_agent_tool import SubAgentTool, reset_session_spawns


class _StubTool(BaseTool):
    def __init__(self, workspace, name="read_file"):
        super().__init__(workspace)
        self.name = name
        self.description = "stub"

    def parameters(self):
        return {"type": "object", "properties": {}, "required": []}

    async def run(self, **kwargs):
        return "ok"


class _FakeLLM:
    def __init__(self, deployment="main-model"):
        self.deployment = deployment

    async def stream_with_tools(self, messages, **kwargs):
        yield "content", '{"summary": "ok", "files_changed": []}'
        yield "usage", {"total_tokens": 1}

    async def invoke(self, messages, **kwargs):
        return "", {"total_tokens": 0}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """Isolate alias resolution from BOTH of its sources.

    Aliases now come from `model_configs` first and LLM_MODEL_ALIASES second
    (llm/model_registry.py). These tests are about the ENV half, so the
    catalogue is pinned empty — otherwise they assert against whatever models
    an admin happens to have configured in the shared database, and a test
    that reads production config isn't a unit test.

    `_db_models` overrides the pin where a test is about the DB half.
    """
    import llm.model_registry as registry

    monkeypatch.setattr(registry, "load_active", lambda: [])
    LLMFactory.reset_cache()
    reset_session_spawns()
    monkeypatch.delenv("LLM_MODEL_ALIASES", raising=False)
    yield
    LLMFactory.reset_cache()
    reset_session_spawns()


@pytest.fixture
def _db_models(monkeypatch):
    """Put a model catalogue in front of the resolver, without a database."""
    import llm.model_registry as registry

    def _install(*configs):
        monkeypatch.setattr(registry, "load_active", lambda: list(configs))
        LLMFactory.reset_cache()
        # reset_cache() clears the catalogue cache, which our stub bypasses —
        # but it also drops built clients, which is what we want between tests.
        monkeypatch.setattr(registry, "load_active", lambda: list(configs))

    return _install


def _model_config(**overrides):
    """A ModelConfig with sane defaults, for the DB-backed tests."""
    from decimal import Decimal

    from llm.model_registry import ModelConfig

    defaults = dict(
        id=1, model_key="deep", display_name="Deep", provider="azure",
        model_name="db-deployment", endpoint_url="https://example.invalid",
        api_version="2024-05-01-preview", api_key="row-key",
        context_window=64000, max_output_tokens=8192, supports_temperature=True,
        tokens_param="max_tokens", supports_vision=False, tier="deep",
        input_cost_per_1m=Decimal("2"), cached_input_cost_per_1m=Decimal("0.5"),
        output_cost_per_1m=Decimal("8"), is_active=True, is_default=True,
    )
    defaults.update(overrides)
    return ModelConfig(**defaults)


def _configure(monkeypatch, spec: str):
    monkeypatch.setenv("LLM_MODEL_ALIASES", spec)
    monkeypatch.setenv("LLM_PROVIDER", "azure")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key")
    LLMFactory.reset_cache()


# ── Alias parsing ────────────────────────────────────────────────────────

def test_aliases_are_listed_for_the_tool_schema(monkeypatch):
    _configure(monkeypatch, "fast=gpt-4o-mini:16000,deep=gpt-4.1")
    assert LLMFactory.available_aliases() == ["deep", "fast"]


def test_no_aliases_configured_is_not_an_error(monkeypatch):
    monkeypatch.delenv("LLM_MODEL_ALIASES", raising=False)
    assert LLMFactory.available_aliases() == []
    assert LLMFactory.for_alias("fast") is None


def test_context_window_is_read_from_the_alias(monkeypatch):
    _configure(monkeypatch, "fast=gpt-4o-mini:16000,deep=gpt-4.1")
    assert context_window_for_alias("fast") == 16000
    # Omitted → inherit the spawner's, signalled by None.
    assert context_window_for_alias("deep") is None
    assert context_window_for_alias("nonexistent") is None


@pytest.mark.parametrize("spec", [
    "  FAST = gpt-4o-mini : 16000 ",   # whitespace and case
    "fast=gpt-4o-mini:16000,,",        # trailing empties
    "garbage,fast=gpt-4o-mini:16000",  # a malformed entry alongside a good one
])
def test_malformed_alias_config_still_yields_the_valid_entries(monkeypatch, spec):
    _configure(monkeypatch, spec)
    assert "fast" in LLMFactory.available_aliases()


def test_an_alias_without_a_deployment_is_ignored(monkeypatch):
    _configure(monkeypatch, "broken=,fine=gpt-4o-mini")
    assert LLMFactory.available_aliases() == ["fine"]


# ── The security property ────────────────────────────────────────────────

def test_an_unconfigured_alias_is_refused_not_passed_through(monkeypatch):
    """
    The important one. If an unknown name fell through as a raw deployment, a
    hallucinated model would hit the Azure API — and an agent could name a
    deployment the operator never meant to expose.
    """
    _configure(monkeypatch, "fast=gpt-4o-mini")
    assert LLMFactory.for_alias("some-expensive-deployment") is None
    assert LLMFactory.for_alias("gpt-4o-mini") is None, (
        "a raw deployment name must not resolve — only configured aliases do"
    )


# ── End to end through a spawn ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_child_runs_on_the_aliased_model(tmp_path, monkeypatch):
    _configure(monkeypatch, "fast=cheap-deployment:16000")
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM("main-model"),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id="root", context_window=128000,
    )
    result = await tool.run(task="cheap work", role="w", model="fast",
                            on_event=on_event)

    # The child gets a REAL client for the aliased deployment, so against a
    # fake endpoint the call fails — that failure is the proof it was actually
    # routed there rather than quietly reusing the parent's working fake.
    assert seen["model"] == "cheap-deployment"
    assert result["status"] != "done", (
        "the child appears to have used the parent's LLM, not the alias"
    )


@pytest.mark.asyncio
async def test_omitting_model_inherits_the_parents(tmp_path, monkeypatch):
    _configure(monkeypatch, "fast=cheap-deployment")
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM("main-model"),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id="root",
    )
    await tool.run(task="work", role="w", on_event=on_event)
    assert seen["model"] == "main-model"


@pytest.mark.asyncio
async def test_an_unknown_alias_falls_back_without_failing_the_spawn(tmp_path, monkeypatch):
    """A model-chosen alias that doesn't exist must not break the run."""
    _configure(monkeypatch, "fast=cheap-deployment")
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM("main-model"),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id="root",
    )
    result = await tool.run(task="work", role="w", model="haiku-3-5-turbo-max",
                            on_event=on_event)

    assert result["status"] in ("done", "unverified"), "spawn failed over a bad alias"
    assert seen["model"] == "main-model", "did not fall back to the parent's model"


@pytest.mark.asyncio
async def test_the_reported_model_is_the_one_actually_used(tmp_path, monkeypatch):
    """The event carries the resolved deployment, not the requested alias — a
    silent fallback must be visible, not hidden behind the alias name."""
    _configure(monkeypatch, "fast=cheap-deployment")
    seen = {}

    async def on_event(kind, data):
        if kind == "subagent_start":
            seen.update(data)

    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM("main-model"),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]),
        thread_id="root",
    )
    await tool.run(task="w", role="w", model="not-configured", on_event=on_event)
    assert seen["model"] != "not-configured"


@pytest.mark.asyncio
async def test_schema_mentions_the_configured_aliases(tmp_path, monkeypatch):
    """The model can only pick an alias it's told about."""
    _configure(monkeypatch, "fast=a,deep=b")
    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM(),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]), thread_id="root",
    )
    desc = tool.parameters()["properties"]["model"]["description"]
    assert "fast" in desc and "deep" in desc


@pytest.mark.asyncio
async def test_schema_says_so_when_no_aliases_exist(tmp_path, monkeypatch):
    monkeypatch.delenv("LLM_MODEL_ALIASES", raising=False)
    tool = SubAgentTool(
        str(tmp_path), llm=_FakeLLM(),
        tool_registry=ToolRegistry([_StubTool(str(tmp_path))]), thread_id="root",
    )
    desc = tool.parameters()["properties"]["model"]["description"]
    assert "leave this unset" in desc.lower()


def test_instances_are_cached_per_deployment(monkeypatch):
    """Rebuilding a client per spawn would re-resolve capabilities every time."""
    _configure(monkeypatch, "fast=cheap-deployment")
    first = LLMFactory.for_alias("fast")
    second = LLMFactory.for_alias("fast")
    assert first is second


# ── The DB catalogue (llm/model_registry.py) ─────────────────────────────────
#
# A `model_configs` row is an alias an ADMIN configured, so it must behave
# exactly like an LLM_MODEL_ALIASES entry — same refusal of unknown names, same
# per-model context window — and it must WIN when both define the same name,
# because the database is the surface an admin can actually change.

def test_db_models_are_offered_as_aliases(monkeypatch, _db_models):
    _db_models(_model_config(model_key="deep"), _model_config(id=2, model_key="fast"))
    assert LLMFactory.available_aliases() == ["deep", "fast"]


def test_db_and_env_aliases_are_merged(monkeypatch, _db_models):
    _configure(monkeypatch, "env-only=gpt-4o-mini")
    _db_models(_model_config(model_key="from-db"))
    assert LLMFactory.available_aliases() == ["env-only", "from-db"]


def test_db_context_window_is_used(monkeypatch, _db_models):
    """A cheaper model usually has a SMALLER window; a child sized by its
    parent's would fill past its own limit before compaction ever triggered."""
    _db_models(_model_config(model_key="deep", context_window=64000))
    assert context_window_for_alias("deep") == 64000


def test_db_model_wins_over_an_env_alias_of_the_same_name(monkeypatch, _db_models):
    _configure(monkeypatch, "deep=env-deployment:16000")
    _db_models(_model_config(model_key="deep", model_name="db-deployment", context_window=64000))
    assert context_window_for_alias("deep") == 64000


def test_an_unknown_alias_is_still_refused_with_a_catalogue(monkeypatch, _db_models):
    """The security property from above, restated for the DB path: a name that
    is not configured must not reach the API as a raw deployment."""
    _db_models(_model_config(model_key="deep"))
    assert LLMFactory.for_alias("some-expensive-deployment") is None
    assert LLMFactory.for_alias("db-deployment") is None, (
        "a raw deployment name must not resolve — only configured keys do"
    )


def test_an_incomplete_model_row_falls_back_instead_of_failing(monkeypatch, _db_models):
    """A row with no key, on a host with no provider key either, must degrade to
    the caller's own model rather than raise — model choice never fails a run."""
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    _db_models(_model_config(model_key="deep", api_key=None))
    assert LLMFactory.from_config(_model_config(api_key=None)) is None


def test_the_rows_own_key_is_used_over_the_environment(monkeypatch):
    """The whole point of storing the key on the row: adding a model in the
    admin UI works without touching .env or restarting."""
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "env-key")
    cfg = _model_config(api_key="row-key")
    assert cfg.resolved_api_key == "row-key"


def test_a_row_without_a_key_falls_back_to_the_provider_env_var(monkeypatch):
    """Blank means "use .env", so a deployment that keeps keys out of the
    database keeps working."""
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "env-key")
    cfg = _model_config(api_key=None)
    assert cfg.resolved_api_key == "env-key"
    assert cfg.api_key_from_env is True


def test_the_key_is_never_exposed_in_the_wire_shape(monkeypatch):
    """to_dict() feeds the model picker every signed-in user can call."""
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "env-key")
    cfg = _model_config(api_key="super-secret-row-key")
    assert "super-secret-row-key" not in repr(cfg.to_dict())
    assert not any("key" in k and k != "key" for k in cfg.to_dict())
    # The mask identifies a key without revealing it.
    assert cfg.api_key_masked == "…-key"
