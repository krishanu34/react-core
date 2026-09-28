"""Jira connector with adaptive Cloud vs Server/DC detection."""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from typing import Any, Optional

import httpx

from .auth import AuthCredential

log = logging.getLogger(__name__)

_CLOUD_HOST = re.compile(r"\.atlassian\.net($|/)", re.IGNORECASE)


class JiraError(RuntimeError):
    pass


class Jira:
    """Thin async wrapper around Jira REST API."""

    def __init__(self, auth: AuthCredential, *, timeout: float = 15.0):
        self._auth = auth
        self._timeout = timeout
        self._is_cloud = _looks_like_cloud(auth.base_url)
        self._api = "/rest/api/3" if self._is_cloud else "/rest/api/2"

    @property
    def flavor(self) -> str:
        return "cloud" if self._is_cloud else "server"

    async def fetch_issue(self, key: str, expand: Optional[str] = None) -> dict[str, Any]:
        path = f"{self._api}/issue/{key}"
        params: dict[str, Any] = {}
        if expand:
            params["expand"] = expand
        return await self._get(path, params)

    async def search(
        self, jql: str, limit: int = 50, fields: Optional[list[str]] = None
    ) -> dict[str, Any]:
        path = f"{self._api}/search"
        params: dict[str, Any] = {
            "jql": jql,
            "maxResults": min(max(int(limit), 1), 100),
        }
        if fields:
            params["fields"] = ",".join(fields)
        return await self._get(path, params)

    async def search_all(
        self,
        jql: str,
        *,
        fields: Optional[list[str]] = None,
        max_total: int = 500,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        """Paginate a JQL search up to `max_total` issues."""
        collected: list[dict[str, Any]] = []
        start = 0
        while len(collected) < max_total:
            path = f"{self._api}/search"
            params: dict[str, Any] = {
                "jql": jql,
                "startAt": start,
                "maxResults": min(page_size, max_total - len(collected)),
            }
            if fields:
                params["fields"] = ",".join(fields)
            data = await self._get(path, params)
            issues = data.get("issues") or []
            if not issues:
                break
            collected.extend(issues)
            total = int(data.get("total") or 0)
            start += len(issues)
            if start >= total:
                break
        return collected

    # ---- internals -------------------------------------------------------
    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        headers = self._auth_headers()
        url = self._auth.base_url.rstrip("/") + path
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                res = await client.get(url, headers=headers, params=params)
                if res.status_code == 429:
                    retry_after = float(res.headers.get("Retry-After", "1"))
                    await asyncio.sleep(min(retry_after, 5.0))
                    res = await client.get(url, headers=headers, params=params)
        except httpx.HTTPError as e:
            raise JiraError(f"network error: {e}") from e
        if res.status_code == 401 or res.status_code == 403:
            raise JiraError(f"auth failed: {res.status_code}")
        if res.status_code >= 400:
            raise JiraError(f"jira returned {res.status_code}: {res.text[:200]}")
        try:
            return res.json()
        except ValueError as e:
            raise JiraError(f"invalid JSON: {e}") from e

    def _auth_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._auth.auth_type == "basic" and self._auth.email:
            raw = f"{self._auth.email}:{self._auth.token}".encode()
            headers["Authorization"] = f"Basic {base64.b64encode(raw).decode()}"
        else:
            headers["Authorization"] = f"Bearer {self._auth.token}"
        return headers


def _looks_like_cloud(base_url: str) -> bool:
    return bool(_CLOUD_HOST.search(base_url or ""))
