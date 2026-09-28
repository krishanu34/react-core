"""Application settings for the Workspace Studio backend."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEVSPHERE_DIR = Path(__file__).resolve().parents[2]
ROOT = DEVSPHERE_DIR.parent
load_dotenv(DEVSPHERE_DIR / ".env", override=False)
load_dotenv(ROOT / ".env", override=False)
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)


class Settings(BaseSettings):
    """Validated environment-backed settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "Workspace Studio Backend"
    app_version: str = "1.0.0"
    api_host: str = Field(default="0.0.0.0", validation_alias="WORKSPACE_STUDIO_HOST")
    api_port: int = Field(default=8003, validation_alias="WORKSPACE_STUDIO_PORT")
    cors_origins: str = Field(default="*", validation_alias="WORKSPACE_STUDIO_CORS_ORIGINS")

    db_host: str = Field(default="localhost", validation_alias="DB_HOST")
    db_port: int = Field(default=5432, validation_alias="DB_PORT")
    db_name: str = Field(default="ai_copilot_platform", validation_alias="DB_NAME")
    db_user: str = Field(default="postgres", validation_alias="DB_USER")
    db_password: str = Field(default="postgres", validation_alias="DB_PASSWORD")
    db_ssl_mode: Optional[str] = Field(default=None, validation_alias="DB_SSL_MODE")

    secret_key: str = Field(default="", validation_alias="SECRET_KEY")
    jwt_algorithm: str = Field(default="HS256", validation_alias="JWT_ALGORITHM")

    max_page_size: int = Field(default=200, ge=1, le=1000, validation_alias="WORKSPACE_STUDIO_MAX_PAGE_SIZE")
    max_sync_operations: int = Field(default=1000, ge=1, le=5000, validation_alias="WORKSPACE_STUDIO_MAX_SYNC_OPERATIONS")
    max_file_content_bytes: int = Field(
        default=5 * 1024 * 1024,
        ge=1,
        validation_alias="WORKSPACE_STUDIO_MAX_FILE_CONTENT_BYTES",
    )

    # DevAccel Integration
    devaccel_api_url: str = Field(default="", validation_alias="DEVACCEL_API_URL")
    devaccel_public_key: str = Field(default="", validation_alias="DEVACCEL_PUBLIC_KEY")
    devaccel_token_audience: str = Field(default="workspace-studio", validation_alias="DEVACCEL_TOKEN_AUDIENCE")
    devaccel_handoff_token_ttl_seconds: int = Field(default=300, validation_alias="DEVACCEL_HANDOFF_TOKEN_TTL")

    @field_validator("devaccel_public_key", mode="before")
    @classmethod
    def _normalize_pem_newlines(cls, v: str) -> str:
        if isinstance(v, str) and "\\n" in v:
            return v.replace("\\n", "\n")
        return v

    @property
    def database_url(self) -> str:
        return f"postgresql://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

    @property
    def connect_args(self) -> dict[str, str]:
        """libpq options for every connection.

        A managed Postgres (Azure, RDS) is reached through a gateway that drops
        a TCP connection it believes is idle, and says nothing — the socket is
        gone but this side still thinks it holds a live connection. The next
        statement then fails with "server closed the connection unexpectedly",
        which reads like a database fault and is really a dead socket.

        TCP keepalives make the kernel probe the peer while the connection sits
        idle, so a dead path is discovered and the connection is torn down and
        replaced before a query lands on it. Local Postgres has no gateway in
        between and needs neither this nor SSL.
        """
        is_remote = self.db_host not in ("localhost", "127.0.0.1")

        ssl_mode = self.db_ssl_mode
        if ssl_mode is None and is_remote:
            ssl_mode = "require"

        args: dict[str, str] = {}
        if ssl_mode:
            args["sslmode"] = ssl_mode
        if is_remote:
            args.update(
                keepalives="1",
                keepalives_idle="30",      # start probing after 30 s idle
                keepalives_interval="10",  # then every 10 s
                keepalives_count="5",      # 5 failures (~80 s) = drop it
            )
        return args

    @property
    def cors_origins_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

