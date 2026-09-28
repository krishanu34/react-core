"""
common_utils/config.py
═══════════════════════════════════════════════════════════════════════════════
Unified configuration loader for all DevAccel backend services.

Resolution order (highest priority first):
1. Environment variables (set by ConfigMaps/deployment or shell)
2. Local .env file (discovered automatically for dev environments)
3. Hardcoded defaults (where safe)

Missing required values cause a clear startup error.

Quick start
~~~~~~~~~~~
    from common_utils.config import get_config

    config = get_config()
    print(config.db_host)       # "localhost" from .env or env var
    print(config.secret_key)    # fails fast if not set anywhere

Per-service override
~~~~~~~~~~~~~~~~~~~~
    # In your service's main.py, before any other imports:
    from common_utils.config import load_env

    load_env()  # Ensures .env is loaded early

    # Then use get_config() anywhere
    from common_utils.config import get_config
    config = get_config()
"""

from __future__ import annotations

import os
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import Field, ConfigDict, model_validator
from pydantic_settings import BaseSettings


# ─── .env file discovery ─────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parent.parent

_ENV_SEARCH_PATHS: list[Path] = [
    # Service-local .env (e.g. user-story-generator/.env)
    # Populated dynamically by load_env(service_dir=...)
]


def load_env(service_dir: Optional[Path] = None) -> None:
    """
    Load .env files using python-dotenv with override=False semantics.

    This means environment variables already set (e.g. by ConfigMaps or
    the shell) always take precedence over .env file values.

    Search order:
    1. service_dir/.env (if provided and exists)
    2. <repo_root>/.env

    Call this once at the top of your service's entrypoint before importing
    modules that read config.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        return

    candidates: list[Path] = []
    if service_dir is not None:
        candidates.append(Path(service_dir) / ".env")
    candidates.append(_REPO_ROOT / ".env")

    for candidate in candidates:
        if candidate.exists():
            load_dotenv(candidate, override=False)


# ─── Forbidden secret patterns ──────────────────────────────────────────────

_FORBIDDEN_SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"change.?(?:me|in|this).?(?:in|for)?.?production", re.IGNORECASE),
    re.compile(r"^dev[\-_]?secret", re.IGNORECASE),
    re.compile(r"^(?:secret|password|changeme|replace.?me|your.?secret|example|test|dummy)", re.IGNORECASE),
    re.compile(r"^xxxx", re.IGNORECASE),
]


# ─── Settings class ─────────────────────────────────────────────────────────

class AppConfig(BaseSettings):
    """
    Application configuration loaded from environment variables with .env fallback.

    All settings are validated at startup. Missing required values produce
    clear error messages indicating which variable needs to be set.
    """

    model_config = ConfigDict(
        env_file=str(_REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Database ─────────────────────────────────────────────────────────────
    db_host: str = Field(
        default="localhost",
        description="PostgreSQL host",
        validation_alias="DB_HOST",
    )
    db_port: int = Field(
        default=5432,
        ge=1,
        le=65535,
        description="PostgreSQL port",
        validation_alias="DB_PORT",
    )
    db_name: str = Field(
        default="devaccelv2",
        description="PostgreSQL database name",
        validation_alias="DB_NAME",
    )
    db_user: str = Field(
        default="devacceluser",
        description="PostgreSQL user",
        validation_alias="DB_USER",
    )
    db_password: str = Field(
        default="",
        description="PostgreSQL password",
        validation_alias="DB_PASSWORD",
    )

    # ── Vector Store (optional, falls back to main DB) ───────────────────────
    vector_store_postgres_db_connection_string: Optional[str] = Field(
        default=None,
        description="Separate connection string for the vector store. Falls back to main DB.",
        validation_alias="VECTOR_STORE_POSTGRES_DB_CONNECTION_STRING",
    )

    # ── LLM Provider ─────────────────────────────────────────────────────────
    llm_provider: str = Field(
        default="azure",
        description="LLM provider: azure | openai | anthropic | llama",
        validation_alias="LLM_PROVIDER",
    )

    # ── Azure OpenAI ─────────────────────────────────────────────────────────
    azure_openai_endpoint: Optional[str] = Field(
        default=None,
        description="Azure OpenAI endpoint URL",
        validation_alias="AZURE_OPENAI_ENDPOINT",
    )
    azure_openai_api_key: Optional[str] = Field(
        default=None,
        description="Azure OpenAI API key",
        validation_alias="AZURE_OPENAI_API_KEY",
    )
    azure_openai_deployment: str = Field(
        default="gpt-4.1",
        description="Azure OpenAI deployment name",
        validation_alias="AZURE_OPENAI_DEPLOYMENT",
    )
    azure_openai_embedding_deployment: str = Field(
        default="text-embedding-ada-002",
        description="Azure OpenAI embedding deployment name",
        validation_alias="AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
    )
    azure_openai_api_version: str = Field(
        default="2024-05-01-preview",
        description="Azure OpenAI API version",
        validation_alias="AZURE_OPENAI_API_VERSION",
    )

    # ── OpenAI (alternative) ─────────────────────────────────────────────────
    openai_api_key: Optional[str] = Field(
        default=None,
        description="OpenAI API key",
        validation_alias="OPENAI_API_KEY",
    )

    # ── Anthropic (alternative) ──────────────────────────────────────────────
    anthropic_api_key: Optional[str] = Field(
        default=None,
        description="Anthropic API key for Claude models",
        validation_alias="ANTHROPIC_API_KEY",
    )

    # ── Auth / JWT ───────────────────────────────────────────────────────────
    secret_key: str = Field(
        ...,
        min_length=32,
        description=(
            "Secret key for JWT token signing/validation (min 32 chars). "
            "Must be set via SECRET_KEY env var or .env file."
        ),
        validation_alias="SECRET_KEY",
    )
    jwt_algorithm: str = Field(
        default="HS256",
        validation_alias="JWT_ALGORITHM",
    )
    access_token_expire_minutes: int = Field(
        default=480,
        validation_alias="ACCESS_TOKEN_EXPIRE_MINUTES",
    )

    # ── Blob Storage (optional) ──────────────────────────────────────────────
    blob_storage_account_name: Optional[str] = Field(
        default=None,
        validation_alias="BLOB_STORAGE_ACCOUNT_NAME",
    )
    blob_storage_account_key: Optional[str] = Field(
        default=None,
        validation_alias="BLOB_STORAGE_ACCOUNT_KEY",
    )
    blob_storage_container_name: Optional[str] = Field(
        default=None,
        validation_alias="BLOB_STORAGE_CONTAINER_NAME",
    )

    # ── Logging ──────────────────────────────────────────────────────────────
    log_level: str = Field(
        default="INFO",
        description="Logging level: DEBUG, INFO, WARNING, ERROR, CRITICAL",
        validation_alias="LOG_LEVEL",
    )

    # ── LLM Tuning ──────────────────────────────────────────────────────────
    llm_temperature: float = Field(
        default=0.7,
        ge=0.0,
        le=2.0,
        validation_alias="LLM_TEMPERATURE",
    )
    model_context_window: int = Field(
        default=128000,
        description="Maximum context window size in tokens",
        validation_alias="MODEL_CONTEXT_WINDOW",
    )

    # ── Code Builder Limits ──────────────────────────────────────────────────
    cb_max_upload_bytes: int = Field(
        default=50_000_000,
        description="Max upload size in bytes for Code Builder",
        validation_alias="CB_MAX_UPLOAD_BYTES",
    )

    # ── SSL / Proxy ──────────────────────────────────────────────────────────
    requests_ca_bundle: Optional[str] = Field(
        default=None,
        description="Path to CA bundle for corporate proxy",
        validation_alias="REQUESTS_CA_BUNDLE",
    )

    # ── Validators ───────────────────────────────────────────────────────────

    @model_validator(mode="after")
    def _reject_placeholder_secret(self) -> "AppConfig":
        """Fail startup if secret_key looks like a well-known placeholder."""
        for pattern in _FORBIDDEN_SECRET_PATTERNS:
            if pattern.search(self.secret_key):
                raise ValueError(
                    f"SECRET_KEY contains forbidden placeholder text "
                    f"(matched /{pattern.pattern}/). "
                    f"Set a strong, random secret of >= 32 characters."
                )
        return self

    @model_validator(mode="after")
    def _validate_llm_credentials(self) -> "AppConfig":
        """Warn (don't fail) if the chosen LLM provider has no credentials."""
        provider = self.llm_provider.lower()
        if provider == "azure" and not self.azure_openai_api_key:
            import warnings
            warnings.warn(
                "LLM_PROVIDER=azure but AZURE_OPENAI_API_KEY is not set. "
                "LLM calls will fail at runtime — set it in backend/.env.",
                stacklevel=2,
            )
        elif provider == "openai" and not self.openai_api_key:
            import warnings
            warnings.warn(
                "LLM_PROVIDER=openai but OPENAI_API_KEY is not set.",
                stacklevel=2,
            )
        elif provider == "anthropic" and not self.anthropic_api_key:
            import warnings
            warnings.warn(
                "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.",
                stacklevel=2,
            )
        return self

    # ── Convenience properties ───────────────────────────────────────────────

    @property
    def database_url(self) -> str:
        """Build a PostgreSQL connection string from individual fields."""
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def async_database_url(self) -> str:
        """Build an asyncpg connection string."""
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


# ─── Singleton accessor ─────────────────────────────────────────────────────

@lru_cache()
def get_config() -> AppConfig:
    """
    Get the validated application config singleton.

    Raises pydantic ValidationError with a clear message if required
    values are missing from both environment variables and .env files.
    """
    try:
        return AppConfig()  # type: ignore[call-arg]
    except Exception as e:
        # Re-raise with a developer-friendly message
        msg = (
            "\n╔══════════════════════════════════════════════════════════════╗\n"
            "║  CONFIGURATION ERROR — Application cannot start             ║\n"
            "╠══════════════════════════════════════════════════════════════╣\n"
            f"║  {e}\n"
            "╠══════════════════════════════════════════════════════════════╣\n"
            "║  Resolution:                                                ║\n"
            "║  1. Copy .env.example to .env at the repo root             ║\n"
            "║  2. Fill in the required values                            ║\n"
            "║  OR set the variables as environment variables              ║\n"
            "╚══════════════════════════════════════════════════════════════╝\n"
        )
        print(msg, file=sys.stderr)
        raise


def reset_config() -> None:
    """Clear the cached config. Useful for testing."""
    get_config.cache_clear()
