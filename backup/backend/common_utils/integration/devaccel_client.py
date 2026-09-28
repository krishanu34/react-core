"""HTTP client for calling DevAccel's integration API."""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from common_utils.integration.models import (
    AuthContext,
    ConnectorBundle,
    DevAccelIntegrationResponse,
    ModelConfig,
    ProjectContext,
)


class DevAccelClientError(Exception):
    """Raised when the DevAccel API call fails."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"DevAccel API error {status_code}: {detail}")


@dataclass(slots=True)
class DevAccelContext:
    """Typed payload returned after successfully fetching DevAccel context."""

    auth_context: AuthContext
    project_context: ProjectContext
    models: list[ModelConfig] = field(default_factory=list)
    connectors: ConnectorBundle = field(default_factory=ConnectorBundle)


class DevAccelClient:
    """HTTP client to consume DevAccel's integration endpoints.

    Parameters
    ----------
    base_url : str
        The DevAccel backend base URL (e.g. ``http://localhost:8000``).
    """

    CONTEXT_PATH = "/api/v1/integration/workspace-studio/context"
    CONNECT_TIMEOUT = 10.0
    READ_TIMEOUT = 30.0

    def __init__(self, base_url: str) -> None:
        if not base_url:
            raise ValueError("DEVACCEL_API_URL is not configured")
        self._base_url = base_url.rstrip("/")

    async def fetch_context(self, bearer_token: str) -> DevAccelContext:
        """Call DevAccel's context endpoint and return a typed payload.

        Raises
        ------
        DevAccelClientError
            On any non-2xx response or network failure.
        """
        url = f"{self._base_url}{self.CONTEXT_PATH}"
        timeout = httpx.Timeout(
            connect=self.CONNECT_TIMEOUT,
            read=self.READ_TIMEOUT,
            write=self.CONNECT_TIMEOUT,
            pool=self.CONNECT_TIMEOUT,
        )
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {bearer_token}"},
                )
            except httpx.RequestError as exc:
                raise DevAccelClientError(502, f"Unable to reach DevAccel: {exc}") from exc

        if resp.status_code != 200:
            raise DevAccelClientError(resp.status_code, resp.text)

        payload = DevAccelIntegrationResponse.model_validate_json(resp.content)
        return DevAccelContext(
            auth_context=payload.auth_context,
            project_context=payload.project_context,
            models=payload.models,
            connectors=payload.connectors,
        )
