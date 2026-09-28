import os
from pathlib import Path

from dotenv import load_dotenv

DEVSPHERE_ENV = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(DEVSPHERE_ENV, override=True)

from .azure_openai import AzureOpenAI
from .model_capabilities import capabilities_from_config
from utils.logger import get_logger

log = get_logger(__name__)


# Alias → (deployment, context_window), from LLM_MODEL_ALIASES:
#
#   LLM_MODEL_ALIASES=fast=gpt-4o-mini:128000,deep=gpt-4.1
#
# The ":context_window" suffix is optional but matters when it differs from the
# main model's: a cheaper deployment usually has a SMALLER window, and a child
# sized by its parent's window would fill past its own limit before compaction
# ever triggered. Omitted → inherit the spawner's window.
#
# Aliases are OPERATOR config, not model-controlled: an agent may ask for "fast",
# but only the operator decides which deployment that is. A name that isn't a
# configured alias is refused rather than passed through as a raw deployment —
# otherwise a hallucinated model name would reach the Azure API, and worse, an
# agent could name a deployment the operator never meant to expose.
def _aliases() -> dict[str, tuple[str, int | None]]:
    raw = os.getenv("LLM_MODEL_ALIASES", "")
    out: dict[str, tuple[str, int | None]] = {}
    for pair in raw.split(","):
        if "=" not in pair:
            continue
        alias, _, spec = pair.partition("=")
        alias, spec = alias.strip().lower(), spec.strip()
        if not alias or not spec:
            continue
        deployment, _, window = spec.partition(":")
        deployment = deployment.strip()
        if not deployment:
            continue
        ctx: int | None = None
        if window.strip().isdigit():
            ctx = int(window.strip())
        out[alias] = (deployment, ctx)
    return out


def context_window_for_alias(alias: str) -> int | None:
    """The alias's own context window, or None to inherit the spawner's.

    Checks the model catalogue first, for the same reason `for_alias` does:
    every `model_configs` row carries its real window, so a child sized by its
    parent's larger window can't fill past its own limit before compaction
    would ever trigger.
    """
    name = (alias or "").strip().lower()
    if not name:
        return None

    try:
        from llm.model_registry import by_key

        cfg = by_key(name)
        if cfg is not None:
            return cfg.context_window
    except Exception as e:  # noqa: BLE001
        log.debug(f"Model catalogue unavailable for '{name}' window: {e}")

    entry = _aliases().get(name)
    return entry[1] if entry else None


# One LLM instance per deployment, reused across agents. Each holds only config
# plus an httpx client, so sharing is safe and avoids re-resolving capabilities
# on every spawn.
_by_deployment: dict[str, object] = {}


class LLMFactory:

    @staticmethod
    def create():
        provider = os.getenv("LLM_PROVIDER", "azure").lower()

        if provider == "azure":
            endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
            api_key = os.getenv("AZURE_OPENAI_API_KEY")
            deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT")
            api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-05-01-preview")

            if not all([endpoint, api_key, deployment]):
                raise ValueError("Missing Azure OpenAI configuration in environment variables.")

            return AzureOpenAI(endpoint, api_key, deployment, api_version)

        raise ValueError(f"Unsupported LLM provider: {provider}")

    @staticmethod
    def from_config(cfg):
        """
        An LLM for a `model_configs` row (llm/model_registry.ModelConfig).

        Returns None rather than raising when the row can't be used — a model
        whose endpoint or API key env var was never filled in must degrade to
        the .env model, not fail the run. Clients are cached per deployment in
        the same dict `for_alias` uses, so repeated turns don't rebuild them.
        """
        if cfg is None:
            return None
        if cfg.provider != "azure":
            log.warning(
                f"Model '{cfg.model_key}' has provider '{cfg.provider}', which has no "
                f"client implementation yet — falling back to the default model."
            )
            return None

        endpoint = cfg.endpoint_url or os.getenv("AZURE_OPENAI_ENDPOINT")
        api_key = cfg.resolved_api_key
        api_version = cfg.api_version or os.getenv("AZURE_OPENAI_API_VERSION", "2024-05-01-preview")
        if not all([endpoint, api_key, cfg.model_name]):
            # Reports only WHETHER a key resolved, never any part of it. An
            # earlier version interpolated the key field and wrote a live
            # secret into app.log in plaintext.
            log.warning(
                f"Model '{cfg.model_key}' is incomplete "
                f"(endpoint={'set' if endpoint else 'missing'}, "
                f"deployment={'set' if cfg.model_name else 'missing'}, "
                f"api key={'set' if api_key else 'missing — add one on the model, '
                                              'or set the provider env var'}) "
                f"— falling back to the default model."
            )
            return None

        # Keyed by the row id, not the deployment: two rows can point at the
        # same deployment with different stated capabilities or pricing.
        cache_key = f"cfg:{cfg.id}"
        if cache_key in _by_deployment:
            return _by_deployment[cache_key]

        try:
            llm = AzureOpenAI(
                endpoint, api_key, cfg.model_name, api_version,
                caps=capabilities_from_config(cfg),
            )
        except Exception as e:  # noqa: BLE001 — degrade, never break the run
            log.warning(f"Could not build LLM for model '{cfg.model_key}': {e}")
            return None

        _by_deployment[cache_key] = llm
        return llm

    @staticmethod
    def available_aliases() -> list[str]:
        """Alias names a sub-agent may ask for, for the sub_agent tool's own
        description. DB models first (an admin's catalogue is the real answer
        once one exists), then the .env aliases."""
        db_keys = []
        try:
            from llm.model_registry import load_active

            db_keys = [c.model_key for c in load_active()]
        except Exception as e:  # noqa: BLE001
            log.debug(f"Model catalogue unavailable for alias list: {e}")
        return sorted(set(db_keys) | set(_aliases()))

    @staticmethod
    def for_alias(alias: str):
        """
        An LLM for a named alias, or None to mean "use the caller's own".

        None is the correct answer for every failure here — an unconfigured
        alias, a typo, a provider that doesn't support this — because a spawn
        must never fail over model selection. The child just runs on the
        parent's model, which is exactly today's behaviour.

        A `model_configs` row wins over an LLM_MODEL_ALIASES entry of the same
        name: the DB is the surface an admin can actually change.
        """
        name = (alias or "").strip().lower()
        if not name:
            return None

        try:
            from llm.model_registry import by_key

            cfg = by_key(name)
            if cfg is not None:
                llm = LLMFactory.from_config(cfg)
                if llm is not None:
                    return llm
        except Exception as e:  # noqa: BLE001
            log.debug(f"DB lookup for alias '{name}' failed ({e}) — trying .env aliases")

        table = _aliases()
        entry = table.get(name)
        if entry is None:
            log.info(
                f"Model alias '{alias}' is not configured "
                f"(available: {sorted(table) or 'none'}) — inheriting the "
                f"parent's model."
            )
            return None
        deployment = entry[0]

        if deployment in _by_deployment:
            return _by_deployment[deployment]

        provider = os.getenv("LLM_PROVIDER", "azure").lower()
        if provider != "azure":
            return None

        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        api_key = os.getenv("AZURE_OPENAI_API_KEY")
        api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-05-01-preview")
        if not all([endpoint, api_key]):
            return None

        try:
            llm = AzureOpenAI(endpoint, api_key, deployment, api_version)
        except Exception as e:  # noqa: BLE001 — degrade, never break the spawn
            log.warning(f"Could not build LLM for alias '{name}' ({deployment}): {e}")
            return None

        _by_deployment[deployment] = llm
        log.info(f"Model alias '{name}' → deployment '{deployment}'")
        return llm

    @staticmethod
    def reset_cache() -> None:
        """Drop cached per-deployment clients (tests, or after a config change).

        Also drops the model catalogue: a cached client built from a row an
        admin has since edited is exactly the stale state this clears.
        """
        _by_deployment.clear()
        try:
            from llm.model_registry import invalidate

            invalidate()
        except Exception as e:  # noqa: BLE001
            log.debug(f"Model catalogue cache not cleared: {e}")
