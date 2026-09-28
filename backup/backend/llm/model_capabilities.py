"""
Model Capability Registry — one place that knows which request parameters
each model family accepts.

Why this exists: OpenAI's reasoning-class models (gpt-5 family, o1/o3/o4)
changed the chat-completions contract:

  - `temperature` is rejected (only the default 1 is allowed)
  - `max_tokens` is rejected — the parameter is `max_completion_tokens`

Sprinkling `if "gpt-5" in name` checks at every call site rots fast, so the
knowledge lives here as data, and `AzureOpenAI._body()` is the single place
that applies it.

Two layers of defense:
  1. capabilities_for(name) — name-based lookup. Covers the known families.
  2. adapt_from_error(caps, text) — runtime learner. Azure deployment names
     are user-chosen and don't always reveal the model; when a request still
     bounces with an "unsupported parameter/value" 400, this parses the
     error, flips the capability, and the caller retries once. Any future
     model works without a code change — worst case is one extra request
     on the first call of the process.

Env overrides (for deployments whose names lie about the model):
  LLM_SUPPORTS_TEMPERATURE=true|false
  LLM_TOKENS_PARAM=max_tokens|max_completion_tokens
  LLM_MAX_OUTPUT_TOKENS=<int>   — per-turn output ceiling (see below)
"""

import os
import re
from dataclasses import dataclass

from utils.logger import get_logger

log = get_logger(__name__)


# Sensible per-turn OUTPUT ceilings by family. This is a CEILING (billed only
# for tokens actually generated), so it's set generously — a large file_write /
# code-gen turn needs room, and for reasoning models the budget also covers
# hidden reasoning tokens, so a too-small cap can starve the visible answer and
# return empty. Kept well under the context window. Overridable per deployment
# via LLM_MAX_OUTPUT_TOKENS (e.g. gpt-5.6-sol supports 128000).
_DEFAULT_OUTPUT_TOKENS = 16384          # gpt-4.x class
_REASONING_OUTPUT_TOKENS = 65536        # gpt-5 / o-series get more headroom


@dataclass
class ModelCapabilities:
    supports_temperature: bool = True
    tokens_param: str = "max_tokens"
    # Max tokens the model may generate in one turn (see note above).
    max_output_tokens: int = _DEFAULT_OUTPUT_TOKENS
    # Whether image parts may appear in a user message. Defaults TRUE: every
    # GPT-4o / 4.1 / 5-class deployment accepts them, and the failure mode of
    # guessing wrong in the other direction (silently never showing the model
    # an attached screenshot) is invisible, whereas a real incapability
    # surfaces as an immediate, obvious 400 the operator can pin with
    # LLM_SUPPORTS_VISION=false.
    supports_vision: bool = True


# Reasoning-class families: gpt-5* (incl. gpt-5.3-chat) and o1/o3/o4 series.
# Matches the family token inside arbitrary deployment names ("my-o3-mini",
# "gpt-5.3-chat-eu") without false-positives like "solo4" or "gpt-4o".
_REASONING_NAME = re.compile(r"gpt-5|(?:^|[-_/])o[134](?:[-_.]|$)", re.IGNORECASE)

# Text-only families still in service. Sending an image part to one of these
# fails the entire request, so they are named explicitly rather than inferred.
# gpt-4o is excluded on purpose: the "o" is omni, and it is vision-capable.
_TEXT_ONLY_NAME = re.compile(
    r"(?:^|[-_/])(?:gpt-3\.5|gpt-35|text-embedding|davinci|babbage|"
    r"gpt-4-32k|gpt-4-0314|gpt-4-0613|o1-mini|o3-mini)",
    re.IGNORECASE,
)


def capabilities_for(model_or_deployment: str) -> ModelCapabilities:
    """Best-guess capabilities from the model/deployment name, then env."""
    name = (model_or_deployment or "").lower()
    caps = ModelCapabilities()

    if _REASONING_NAME.search(name):
        caps.supports_temperature = False
        caps.tokens_param = "max_completion_tokens"
        caps.max_output_tokens = _REASONING_OUTPUT_TOKENS

    if _TEXT_ONLY_NAME.search(name):
        caps.supports_vision = False

    env_vision = os.getenv("LLM_SUPPORTS_VISION")
    if env_vision is not None:
        caps.supports_vision = env_vision.strip().lower() in ("1", "true", "yes")

    env_temp = os.getenv("LLM_SUPPORTS_TEMPERATURE")
    if env_temp is not None:
        caps.supports_temperature = env_temp.strip().lower() in ("1", "true", "yes")
    env_tokens = os.getenv("LLM_TOKENS_PARAM")
    if env_tokens:
        caps.tokens_param = env_tokens.strip()
    # Explicit .env override wins — set this to your deployment's real output
    # limit (gpt-5.6-sol: 128000). Bad values fall back to the family default.
    env_out = os.getenv("LLM_MAX_OUTPUT_TOKENS")
    if env_out:
        try:
            caps.max_output_tokens = int(env_out)
        except ValueError:
            log.warning("LLM_MAX_OUTPUT_TOKENS=%r is not an int — using default", env_out)

    return caps


def capabilities_from_config(cfg) -> ModelCapabilities:
    """Capabilities stated by a `model_configs` row (see llm/model_registry.py).

    The row supplies the values a name can't reveal — context window, output
    ceiling, pricing — because Azure deployment names are user-chosen and don't
    identify the underlying model.

    But the reasoning-family constraints are NOT taken from the row. Those two
    (`temperature` is rejected; the token limit is `max_completion_tokens`) are
    hard facts about the API: no database row can make a gpt-5 deployment
    accept `temperature`. And in practice a row's values for them are column
    DEFAULTS far more often than deliberate choices — a row inserted by hand
    carries `supports_temperature = TRUE` simply because nobody set it, which
    is enough to break every call to a reasoning model with:

        Unsupported value: 'temperature' does not support 0.0 with this model.

    So when the deployment name identifies a reasoning family, that wins.
    `adapt_from_error()` remains the runtime backstop for deployment names that
    reveal nothing at all.
    """
    inferred = capabilities_for(cfg.model_name)

    caps = ModelCapabilities(
        supports_temperature=bool(cfg.supports_temperature),
        tokens_param=cfg.tokens_param or "max_tokens",
        max_output_tokens=int(cfg.max_output_tokens),
        # Vision is not a column on model_configs, so it stays name-derived —
        # the row cannot contradict what the deployment name says it is.
        supports_vision=inferred.supports_vision,
    )

    if caps.tokens_param not in ("max_tokens", "max_completion_tokens"):
        log.warning(
            "Model '%s' has tokens_param=%r — falling back to a name-based guess",
            getattr(cfg, "model_key", "?"), caps.tokens_param,
        )
        caps.tokens_param = inferred.tokens_param

    # `capabilities_for` only clears supports_temperature for the reasoning
    # families, so this is the signal that the NAME matched one of them.
    if not inferred.supports_temperature:
        if caps.supports_temperature or caps.tokens_param != inferred.tokens_param:
            log.info(
                "Model '%s' (%s) is a reasoning-class deployment — ignoring the row's "
                "temperature/token-param values, which that family's API rejects.",
                getattr(cfg, "model_key", "?"), cfg.model_name,
            )
        caps.supports_temperature = False
        caps.tokens_param = inferred.tokens_param

    return caps


def adapt_from_error(caps: ModelCapabilities, error_text: str) -> bool:
    """
    Learn from an Azure/OpenAI 400 that rejects a parameter. Returns True
    if a capability was changed (caller should rebuild the body and retry
    once); False means the error is something else — handle it normally.

    Real Azure error shapes this matches:
      "Unsupported parameter: 'max_tokens' is not supported with this
       model. Use 'max_completion_tokens' instead."
      "Unsupported value: 'temperature' does not support 0.0 with this
       model. Only the default (1) value is supported."
    """
    text = (error_text or "").lower()
    if not any(k in text for k in ("unsupported", "not supported", "does not support")):
        return False

    changed = False
    if "temperature" in text and caps.supports_temperature:
        caps.supports_temperature = False
        changed = True
        log.warning("Model rejected `temperature` — omitting it from now on")
    if "max_tokens" in text and caps.tokens_param == "max_tokens":
        caps.tokens_param = "max_completion_tokens"
        changed = True
        log.warning("Model rejected `max_tokens` — switching to `max_completion_tokens`")
    return changed
