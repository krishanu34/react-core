"""Import the model currently configured in backend/.env into `model_configs`.

    python db/seed_models.py

Migration 005 leaves `model_configs` empty on purpose — the resolver falls back
to .env, so applying it changes nothing. This script promotes that .env model to
the first DB row so an admin has something to see, copy and assign, and so the
DB path is exercised end to end.

Also imports every LLM_MODEL_ALIASES entry as its own row, since those are
already alias -> deployment[:context_window] pairs.

Idempotent: re-running updates the rows it created rather than duplicating them.

This DOES copy the API key out of .env and into the row, because that is where
the backend now reads it from (db/migrations/006_model_api_key.sql). Treat the
database and its backups as secret-bearing afterwards.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from dotenv import load_dotenv  # noqa: E402
from sqlalchemy import text  # noqa: E402

load_dotenv(BACKEND_DIR / ".env", override=False)

from workspace_studio.repositories.database import get_session  # noqa: E402

UPSERT = text(
    """
    INSERT INTO model_configs (
        model_key, display_name, provider, model_name, endpoint_url,
        api_version, api_key, context_window, max_output_tokens,
        supports_temperature, tokens_param, tier, is_active, is_default
    ) VALUES (
        :model_key, :display_name, :provider, :model_name, :endpoint_url,
        :api_version, :api_key, :context_window, :max_output_tokens,
        :supports_temperature, :tokens_param, :tier, TRUE, :is_default
    )
    ON CONFLICT (model_key) DO UPDATE SET
        display_name      = EXCLUDED.display_name,
        provider          = EXCLUDED.provider,
        model_name        = EXCLUDED.model_name,
        endpoint_url      = EXCLUDED.endpoint_url,
        api_version       = EXCLUDED.api_version,
        api_key           = EXCLUDED.api_key,
        context_window    = EXCLUDED.context_window,
        max_output_tokens = EXCLUDED.max_output_tokens,
        updated_at        = NOW()
    """
)


def _capabilities(deployment: str) -> tuple[bool, str, int]:
    """Reuse the existing capability inference rather than restating the rules."""
    from llm.model_capabilities import capabilities_for

    caps = capabilities_for(deployment)
    return caps.supports_temperature, caps.tokens_param, caps.max_output_tokens


def _row(model_key: str, deployment: str, context_window: int, is_default: bool) -> dict:
    supports_temperature, tokens_param, max_output = _capabilities(deployment)
    return {
        "model_key": model_key,
        "display_name": deployment,
        "provider": os.getenv("LLM_PROVIDER", "azure").lower(),
        "model_name": deployment,
        "endpoint_url": os.getenv("AZURE_OPENAI_ENDPOINT"),
        "api_version": os.getenv("AZURE_OPENAI_API_VERSION", "2024-05-01-preview"),
        "api_key": os.getenv("AZURE_OPENAI_API_KEY"),
        "context_window": context_window,
        "max_output_tokens": int(os.getenv("LLM_MAX_OUTPUT_TOKENS") or max_output),
        "supports_temperature": supports_temperature,
        "tokens_param": tokens_param,
        # Unknown from .env alone; an admin sets the real tier in the UI. The
        # degrade path only ever picks a model an admin explicitly nominated,
        # so a wrong guess here costs nothing.
        "tier": "balanced",
        "is_default": is_default,
    }


def main() -> None:
    deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT")
    if not deployment:
        print("AZURE_OPENAI_DEPLOYMENT is not set in backend/.env — nothing to import.")
        return

    window = int(os.getenv("MODEL_CONTEXT_WINDOW", "128000"))
    rows = [_row("default", deployment, window, is_default=True)]

    # LLM_MODEL_ALIASES=fast=gpt-4o-mini:128000,deep=gpt-4.1
    from llm.factory import _aliases  # noqa: PLC2701 — the parser already exists

    for alias, (alias_deployment, alias_window) in _aliases().items():
        if alias == "default":
            continue
        rows.append(_row(alias, alias_deployment, alias_window or window, is_default=False))

    with get_session() as session:
        # A second is_default row would violate ux_model_configs_one_default.
        session.execute(text("UPDATE model_configs SET is_default = FALSE WHERE is_default"))
        for row in rows:
            session.execute(UPSERT, row)

    print(f"Imported {len(rows)} model(s): {', '.join(r['model_key'] for r in rows)}")
    print("Default:", rows[0]["model_name"])
    print("\nEvery user can now reach these models. Narrow that with "
          "model_access_policies, or from the admin UI.")


if __name__ == "__main__":
    main()
