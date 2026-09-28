"""jira_fetch_issue tool."""
from __future__ import annotations

from typing import Any, Optional

from ..connectors import Jira, resolve_auth
from ..connectors.jira import JiraError
from .base import BaseTool


class JiraFetchIssueTool(BaseTool):
    name = "jira_fetch_issue"
    description = (
        "Fetch a Jira issue by key (e.g. PROJ-123). Returns summary, "
        "description, acceptance criteria, comments, status, issue type. "
        "Auto-detects Cloud vs Server/DC from the configured base URL."
    )

    def __init__(self, workspace: str, *, user_id: str = "admin"):
        super().__init__(workspace)
        self._user_id = user_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Issue key like PROJ-123."},
                "expand": {
                    "type": "string",
                    "description": "Optional Jira `expand` string (e.g. 'renderedFields,changelog').",
                },
            },
            "required": ["key"],
        }

    async def run(
        self, key: str, expand: Optional[str] = None, **_: Any
    ) -> dict[str, Any]:
        auth = resolve_auth("jira", user_id=self._user_id)
        if auth is None:
            return {"error": "Jira not configured. Ask the user to add credentials."}
        try:
            client = Jira(auth)
            issue = await client.fetch_issue(key, expand=expand)
        except JiraError as e:
            return {"error": str(e)}
        # Return a compact envelope for the LLM.
        fields = issue.get("fields", {}) or {}
        return {
            "key": issue.get("key"),
            "flavor": client.flavor,
            "summary": fields.get("summary"),
            "description": _flatten(fields.get("description")),
            "status": (fields.get("status") or {}).get("name"),
            "issuetype": (fields.get("issuetype") or {}).get("name"),
            "priority": (fields.get("priority") or {}).get("name"),
            "labels": fields.get("labels") or [],
            "components": [c.get("name") for c in fields.get("components") or []],
            "assignee": (fields.get("assignee") or {}).get("displayName"),
            "reporter": (fields.get("reporter") or {}).get("displayName"),
            "created": fields.get("created"),
            "updated": fields.get("updated"),
        }


def _flatten(v: Any) -> Any:
    """Jira Cloud stores description as ADF (nested dict). Extract text."""
    if v is None or isinstance(v, str):
        return v
    if isinstance(v, dict):
        if v.get("type") == "text":
            return v.get("text", "")
        parts: list[str] = []
        for k in ("content", "children"):
            if k in v and isinstance(v[k], list):
                for c in v[k]:
                    r = _flatten(c)
                    if r:
                        parts.append(str(r))
        return " ".join(parts).strip()
    if isinstance(v, list):
        return " ".join(str(_flatten(x)) for x in v).strip()
    return str(v)
