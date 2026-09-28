"""web_fetch tool."""
from __future__ import annotations

from typing import Any

from ..connectors.web import WebFetchError, web_fetch
from .base import BaseTool


class WebFetchTool(BaseTool):
    name = "web_fetch"
    description = (
        "Fetch a public web page or JSON endpoint over HTTPS. HTML is "
        "converted to plain text. SSRF-guarded: private / loopback / "
        "link-local IPs are blocked by default."
    )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "method": {"type": "string", "description": "GET or HEAD."},
            },
            "required": ["url"],
        }

    async def run(self, url: str, method: str = "GET", **_: Any) -> dict[str, Any]:
        try:
            return await web_fetch(url, method=method)
        except WebFetchError as e:
            return {"error": str(e)}
