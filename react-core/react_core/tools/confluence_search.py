"""confluence_search tool (CQL)."""
from __future__ import annotations

from typing import Any

from ..connectors import Confluence, resolve_auth
from ..connectors.confluence import ConfluenceError
from .base import BaseTool


class ConfluenceSearchTool(BaseTool):
    name = "confluence_search"
    description = "Search Confluence by CQL. Returns compact page rows (id, title, space, updated)."

    def __init__(self, workspace: str, *, user_id: str = "admin"):
        super().__init__(workspace)
        self._user_id = user_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "cql": {"type": "string", "description": "CQL query, e.g. 'type = page AND text ~ \"checkout\"'."},
                "limit": {"type": "integer"},
            },
            "required": ["cql"],
        }

    async def run(self, cql: str, limit: int = 20, **_: Any) -> dict[str, Any]:
        auth = resolve_auth("confluence", user_id=self._user_id)
        if auth is None:
            return {"error": "Confluence not configured."}
        try:
            client = Confluence(auth)
            data = await client.search(cql, limit=limit)
        except ConfluenceError as e:
            return {"error": str(e)}
        results = data.get("results") or []
        return {
            "count": len(results),
            "results": [
                {
                    "id": (r.get("content") or {}).get("id") or r.get("id"),
                    "title": (r.get("content") or {}).get("title") or r.get("title"),
                    "type": (r.get("content") or {}).get("type") or r.get("type"),
                    "space": ((r.get("content") or {}).get("space") or {}).get("key"),
                    "url": r.get("url"),
                }
                for r in results
            ],
        }
