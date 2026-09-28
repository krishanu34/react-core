"""jira_search tool (JQL)."""
from __future__ import annotations

from typing import Any, Optional

from ..connectors import Jira, resolve_auth
from ..connectors.jira import JiraError
from .base import BaseTool


class JiraSearchTool(BaseTool):
    name = "jira_search"
    description = "Search Jira issues by JQL. Returns compact issue rows (key, summary, status, updated)."

    def __init__(self, workspace: str, *, user_id: str = "admin"):
        super().__init__(workspace)
        self._user_id = user_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "jql": {"type": "string", "description": "JQL query, e.g. 'project = ACME AND status = Open'."},
                "limit": {"type": "integer", "description": "Max results (1-100)."},
                "fields": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["jql"],
        }

    async def run(
        self, jql: str, limit: int = 20, fields: Optional[list[str]] = None, **_: Any
    ) -> dict[str, Any]:
        auth = resolve_auth("jira", user_id=self._user_id)
        if auth is None:
            return {"error": "Jira not configured."}
        try:
            client = Jira(auth)
            data = await client.search(jql, limit=limit, fields=fields)
        except JiraError as e:
            return {"error": str(e)}
        issues = data.get("issues") or []
        return {
            "total": data.get("total"),
            "returned": len(issues),
            "issues": [
                {
                    "key": i.get("key"),
                    "summary": (i.get("fields") or {}).get("summary"),
                    "status": ((i.get("fields") or {}).get("status") or {}).get("name"),
                    "updated": (i.get("fields") or {}).get("updated"),
                }
                for i in issues
            ],
        }
