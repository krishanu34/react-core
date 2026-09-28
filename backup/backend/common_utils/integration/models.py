"""Pydantic models for the DevAccel integration API response."""

from __future__ import annotations

from pydantic import BaseModel


class AuthContext(BaseModel):
    user_id: int
    username: str
    roles: list[str] = []
    permissions: list[str] = []


class ProjectContext(BaseModel):
    project_id: int
    project_name: str
    environment: dict[str, str] = {}


class ModelConfig(BaseModel):
    model_id: str
    provider: str  # "azure_openai", "openai", etc.
    deployment_name: str
    endpoint: str
    api_version: str | None = None
    capabilities: list[str] = []  # "chat", "embedding", "code"


class ConnectorConfig(BaseModel):
    connector_type: str  # "jira", "ado", "git"
    base_url: str
    auth_method: str  # "token", "oauth", "pat"
    credentials: dict[str, str] = {}


class ConnectorBundle(BaseModel):
    jira: ConnectorConfig | None = None
    ado: ConnectorConfig | None = None
    git: ConnectorConfig | None = None


class DevAccelIntegrationResponse(BaseModel):
    auth_context: AuthContext
    project_context: ProjectContext
    models: list[ModelConfig] = []
    connectors: ConnectorBundle = ConnectorBundle()
