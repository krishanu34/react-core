"""Web fetch with SSRF guard + html-to-text extraction."""
from __future__ import annotations

import ipaddress
import logging
import os
import socket
from typing import Optional
from urllib.parse import urlparse

import httpx

from ..attachments.extractors import render_html_to_text

log = logging.getLogger(__name__)

_TIMEOUT = float(os.getenv("WEB_FETCH_TIMEOUT_S", "15"))
_MAX_MB = float(os.getenv("WEB_FETCH_MAX_MB", "5"))
_ALLOW_PRIVATE = (os.getenv("WEB_FETCH_ALLOW_PRIVATE") or "").lower() in {"1", "true", "yes"}


class WebFetchError(RuntimeError):
    pass


async def web_fetch(
    url: str,
    *,
    method: str = "GET",
    timeout: Optional[float] = None,
) -> dict:
    """Fetch `url` and return `{status, headers, content_type, text}`."""
    _guard_ssrf(url)
    method = method.upper()
    if method not in {"GET", "HEAD"}:
        raise WebFetchError(f"method not allowed: {method}")
    try:
        async with httpx.AsyncClient(
            timeout=timeout or _TIMEOUT,
            follow_redirects=True,
            max_redirects=5,
        ) as client:
            res = await client.request(method, url)
    except httpx.HTTPError as e:
        raise WebFetchError(f"network error: {e}") from e

    if len(res.content) > _MAX_MB * 1024 * 1024:
        raise WebFetchError(f"body exceeds {_MAX_MB} MB cap")

    ct = res.headers.get("content-type", "") or ""
    body_text = ""
    if method == "GET":
        if "text/html" in ct or "application/xhtml" in ct:
            body_text = render_html_to_text(res.text)
        elif ct.startswith("text/") or "json" in ct or "xml" in ct:
            body_text = res.text
        else:
            body_text = f"[binary content: {ct or 'unknown'}, {len(res.content)} bytes]"

    return {
        "status": int(res.status_code),
        "url": str(res.url),
        "content_type": ct,
        "text": body_text[:200_000],       # hard cap on returned text
    }


def _guard_ssrf(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise WebFetchError(f"scheme not allowed: {parsed.scheme}")
    host = parsed.hostname
    if not host:
        raise WebFetchError("host missing")
    if _ALLOW_PRIVATE:
        return
    # DNS-resolve — check every A/AAAA record.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise WebFetchError(f"DNS lookup failed: {e}") from e
    for _, _, _, _, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast:
            raise WebFetchError(f"host resolves to private/loopback IP: {ip}")
