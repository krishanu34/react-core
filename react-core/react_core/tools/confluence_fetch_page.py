"""confluence_fetch_page tool."""
from __future__ import annotations

from typing import Any

from ..attachments.extractors import render_html_to_text
from ..connectors import Confluence, resolve_auth
from ..connectors.confluence import ConfluenceError
from .base import BaseTool


class ConfluenceFetchPageTool(BaseTool):
    name = "confluence_fetch_page"
    description = (
        "Fetch a Confluence page by ID. Returns title, plain-text body, "
        "space, version, and children (if requested). Auto-detects Cloud "
        "vs Server/DC."
    )

    def __init__(self, workspace: str, *, user_id: str = "admin"):
        super().__init__(workspace)
        self._user_id = user_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "page_id": {"type": "string"},
                "include_children": {"type": "boolean"},
            },
            "required": ["page_id"],
        }

    async def run(
        self, page_id: str, include_children: bool = False, **_: Any
    ) -> dict[str, Any]:
        auth = resolve_auth("confluence", user_id=self._user_id)
        if auth is None:
            return {"error": "Confluence not configured."}
        try:
            client = Confluence(auth)
            page = await client.fetch_page(page_id, include_children=include_children)
        except ConfluenceError as e:
            return {"error": str(e)}

        html = ((page.get("body") or {}).get("view") or {}).get("value", "")
        text = render_html_to_text(html)

        return {
            "id": page.get("id"),
            "flavor": client.flavor,
            "title": page.get("title"),
            "space": (page.get("space") or {}).get("key"),
            "version": (page.get("version") or {}).get("number"),
            "text": text,
        }
