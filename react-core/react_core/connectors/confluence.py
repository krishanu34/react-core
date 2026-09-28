"""Confluence connector with adaptive Cloud vs Server/DC detection."""
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


class ConfluenceError(RuntimeError):
    pass


class Confluence:
    def __init__(self, auth: AuthCredential, *, timeout: float = 15.0):
        self._auth = auth
        self._timeout = timeout
        self._is_cloud = bool(_CLOUD_HOST.search(auth.base_url or ""))
        # Cloud REST v2 lives under /wiki/api/v2; classic v1 is /wiki/rest/api.
        # We stick to v1 for both flavors — supported everywhere.
        self._api = "/wiki/rest/api" if self._is_cloud else "/rest/api"

    @property
    def flavor(self) -> str:
        return "cloud" if self._is_cloud else "server"

    async def fetch_page(
        self, page_id: str, include_children: bool = False
    ) -> dict[str, Any]:
        # Request both body representations: view (rendered HTML) may go
        # macro-thin for some pages, storage carries the raw content.
        expand = "body.view,body.storage,version,space"
        if include_children:
            expand += ",children.page"
        return await self._get(f"{self._api}/content/{page_id}", {"expand": expand})

    async def search(self, cql: str, limit: int = 50) -> dict[str, Any]:
        params = {
            "cql": cql,
            "limit": min(max(int(limit), 1), 100),
            "expand": "content.space,content.version",
        }
        return await self._get(f"{self._api}/search", params)

    async def child_pages(self, page_id: str, limit: int = 100) -> list[dict[str, Any]]:
        """Return direct child pages of `page_id` (id, title, version)."""
        params = {"limit": min(max(int(limit), 1), 200), "expand": "version"}
        data = await self._get(f"{self._api}/content/{page_id}/child/page", params)
        return list(data.get("results") or [])

    async def attachments(self, page_id: str, limit: int = 50) -> list[dict[str, Any]]:
        """Return attachment metadata for a page (filename, media type, size, download URL)."""
        params = {"limit": min(max(int(limit), 1), 200)}
        data = await self._get(f"{self._api}/content/{page_id}/child/attachment", params)
        return list(data.get("results") or [])

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
            raise ConfluenceError(f"network error: {e}") from e
        if res.status_code == 401 or res.status_code == 403:
            raise ConfluenceError(f"auth failed: {res.status_code}")
        if res.status_code >= 400:
            raise ConfluenceError(f"confluence returned {res.status_code}: {res.text[:200]}")
        try:
            return res.json()
        except ValueError as e:
            raise ConfluenceError(f"invalid JSON: {e}") from e

    def _auth_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._auth.auth_type == "basic" and self._auth.email:
            raw = f"{self._auth.email}:{self._auth.token}".encode()
            headers["Authorization"] = f"Basic {base64.b64encode(raw).decode()}"
        else:
            headers["Authorization"] = f"Bearer {self._auth.token}"
        return headers
