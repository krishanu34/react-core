"""jira_hierarchy — fetch a scope of Jira issues (PI/Epic/Feature/Sprint/
Assignee/raw JQL) with optional full details and recursive child expansion.

Bell SAFe patterns supported out of the box (with sensible JQL guesses;
override with scope='jql' if the field names differ):

  scope         JQL used
  --------      ------------------------------------------------------------
  epic          "Epic Link" = <value> OR parent = <value>
  feature       "Parent Link" = <value> OR parent = <value>
  sprint        sprint = "<value>"
  pi            fixVersion = "<value>" OR "Program Increment" = "<value>"
  assignee      assignee = "<value>"
  jql           <value>   (raw pass-through)

Recursion walks `parent = <key>` from each returned issue, deduplicating and
capped by `max_depth` and `max_issues`. Fetches full details when
`with_details=True`.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from ..connectors import Jira, resolve_auth
from ..connectors.jira import JiraError
from .base import BaseTool
from .jira_fetch_issue import _flatten  # reuse ADF flattener

log = logging.getLogger(__name__)

_DEFAULT_FIELDS = [
    "summary", "status", "issuetype", "priority", "labels", "assignee",
    "reporter", "created", "updated", "components", "fixVersions",
    "parent", "subtasks", "customfield_10008",  # common Epic Link on Server/DC
]


class JiraHierarchyTool(BaseTool):
    name = "jira_hierarchy"
    description = (
        "Fetch a set of Jira issues by scope (epic/feature/sprint/pi/"
        "assignee/jql), optionally with full details and recursive "
        "child expansion. Use this to enumerate stories under an epic, "
        "features under a PI, or a user's current-sprint queue."
    )

    def __init__(self, workspace: str, *, user_id: str = "admin"):
        super().__init__(workspace)
        self._user_id = user_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "description": "epic | feature | sprint | pi | assignee | jql",
                },
                "value": {
                    "type": "string",
                    "description": "Scope value: e.g. 'PROJ-123' (epic/feature), 'Sprint 24' (sprint), 'PI-25.1' (pi), 'krishanu.ganguli' (assignee), or raw JQL when scope='jql'.",
                },
                "assignee_filter": {
                    "type": "string",
                    "description": "Optional additional assignee filter (username). Ignored when scope='assignee'.",
                },
                "with_details": {
                    "type": "boolean",
                    "description": "Fetch full issue details (summary, description, ACs, comments count). Default false.",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Follow parent → child relationships. Default true.",
                },
                "max_depth": {"type": "integer", "description": "Recursion cap. Default 3."},
                "max_issues": {"type": "integer", "description": "Hard cap across the whole traversal. Default 200."},
            },
            "required": ["scope", "value"],
        }

    async def run(
        self,
        scope: str,
        value: str,
        assignee_filter: Optional[str] = None,
        with_details: bool = False,
        recursive: bool = True,
        max_depth: int = 3,
        max_issues: int = 200,
        **_: Any,
    ) -> dict[str, Any]:
        auth = resolve_auth("jira", user_id=self._user_id)
        if auth is None:
            return {"error": "Jira not configured. Open the UI Settings panel and add your Jira base URL + PAT."}

        client = Jira(auth)
        base_jql = _scope_to_jql(scope.strip().lower(), value)
        if base_jql is None:
            return {"error": f"unknown scope: {scope!r}. Use one of: epic, feature, sprint, pi, assignee, jql."}
        if assignee_filter and scope != "assignee":
            base_jql = f"({base_jql}) AND assignee = \"{assignee_filter}\""

        visited: set[str] = set()
        warnings: list[str] = []
        try:
            roots = await client.search_all(
                base_jql, fields=_DEFAULT_FIELDS,
                max_total=min(max_issues, 200),
            )
        except JiraError as e:
            return {"error": str(e), "jql_used": base_jql}

        results: list[dict[str, Any]] = []
        for issue in roots:
            if len(visited) >= max_issues:
                warnings.append(f"max_issues={max_issues} reached; some results omitted.")
                break
            node = await _walk(
                client, issue, visited, warnings,
                depth=0, max_depth=max_depth, max_issues=max_issues,
                recursive=recursive, with_details=with_details,
            )
            if node is not None:
                results.append(node)

        return {
            "scope": scope,
            "value": value,
            "jql_used": base_jql,
            "flavor": client.flavor,
            "total": len(visited),
            "issues": results,
            "warnings": warnings,
        }


def _scope_to_jql(scope: str, value: str) -> Optional[str]:
    v = value.strip()
    if not v:
        return None
    if scope == "epic":
        return f'"Epic Link" = {v} OR parent = {v}'
    if scope == "feature":
        return f'"Parent Link" = {v} OR parent = {v}'
    if scope == "sprint":
        return f'sprint = "{v}"'
    if scope == "pi":
        return f'fixVersion = "{v}" OR "Program Increment" = "{v}"'
    if scope == "assignee":
        return f'assignee = "{v}"'
    if scope == "jql":
        return v
    return None


async def _walk(
    client: Jira,
    issue: dict[str, Any],
    visited: set[str],
    warnings: list[str],
    *,
    depth: int,
    max_depth: int,
    max_issues: int,
    recursive: bool,
    with_details: bool,
) -> Optional[dict[str, Any]]:
    key = issue.get("key")
    if not key or key in visited:
        return None
    visited.add(key)
    node = _summarise(issue)

    if with_details:
        try:
            full = await client.fetch_issue(key)
            node["details"] = _extract_details(full)
        except JiraError as e:
            warnings.append(f"details fetch failed for {key}: {e}")

    node["children"] = []
    if not recursive or depth >= max_depth or len(visited) >= max_issues:
        return node

    try:
        children = await client.search_all(
            f'parent = "{key}"',
            fields=_DEFAULT_FIELDS,
            max_total=min(50, max_issues - len(visited)),
        )
    except JiraError as e:
        warnings.append(f"children fetch failed for {key}: {e}")
        return node

    for child in children:
        if len(visited) >= max_issues:
            warnings.append(f"max_issues={max_issues} reached during recursion at {key}.")
            break
        child_node = await _walk(
            client, child, visited, warnings,
            depth=depth + 1, max_depth=max_depth, max_issues=max_issues,
            recursive=True, with_details=with_details,
        )
        if child_node is not None:
            node["children"].append(child_node)
    return node


def _summarise(issue: dict[str, Any]) -> dict[str, Any]:
    f = issue.get("fields") or {}
    return {
        "key": issue.get("key"),
        "type": (f.get("issuetype") or {}).get("name"),
        "summary": f.get("summary"),
        "status": (f.get("status") or {}).get("name"),
        "priority": (f.get("priority") or {}).get("name"),
        "assignee": (f.get("assignee") or {}).get("name")
                    or (f.get("assignee") or {}).get("displayName"),
        "labels": f.get("labels") or [],
        "updated": f.get("updated"),
    }


def _extract_details(issue: dict[str, Any]) -> dict[str, Any]:
    f = issue.get("fields") or {}
    subtasks = [
        {"key": s.get("key"), "summary": (s.get("fields") or {}).get("summary")}
        for s in f.get("subtasks") or []
    ]
    return {
        "description": _flatten(f.get("description")),
        "components": [c.get("name") for c in f.get("components") or []],
        "fix_versions": [v.get("name") for v in f.get("fixVersions") or []],
        "reporter": (f.get("reporter") or {}).get("displayName")
                    or (f.get("reporter") or {}).get("name"),
        "created": f.get("created"),
        "parent_key": (f.get("parent") or {}).get("key"),
        "subtask_count": len(subtasks),
        "subtasks": subtasks,
    }
