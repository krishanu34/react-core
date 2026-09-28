"""Smoke tests for the two Bell-oriented tools.

Credential flow is: **UI Settings modal → App DB → `resolve_auth`**.
There is no bell_defaults.py, and env-vars are a fallback for CI only.
"""
from __future__ import annotations

import asyncio


def _fresh_state(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("CONFLUENCE_BASE_URL", raising=False)
    monkeypatch.delenv("CONFLUENCE_API_TOKEN", raising=False)
    monkeypatch.delenv("CONFLUENCE_EMAIL", raising=False)
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


# ------------------------------------------------------------ auth flow ----

def test_resolve_auth_reads_from_app_db(tmp_path, monkeypatch):
    """Simulate the UI Settings modal writing to the App DB, then resolve."""
    _fresh_state(tmp_path, monkeypatch)

    from react_core.app_db import Credential, get_app_db
    db = get_app_db()
    db.upsert_credential(Credential(
        id="", user_id="admin", team_id=None,
        provider="jira",
        base_url="https://jira.bell.corp.bce.ca",
        token="db-token-xyz",
        refresh_token=None, expires_at=None,
        auth_type="pat", email=None,
        created_at="", updated_at="",
    ))

    from react_core.connectors.auth import resolve_auth
    cred = resolve_auth("jira")
    assert cred is not None
    assert cred.token == "db-token-xyz"
    assert cred.base_url == "https://jira.bell.corp.bce.ca"
    assert cred.auth_type == "pat"


def test_resolve_auth_ignores_env_vars(tmp_path, monkeypatch):
    """Env vars must never be a fallback — only the App DB counts."""
    _fresh_state(tmp_path, monkeypatch)
    monkeypatch.setenv("JIRA_BASE_URL", "https://tempting-env-var.example")
    monkeypatch.setenv("JIRA_API_TOKEN", "env-token-should-be-ignored")

    from react_core.connectors.auth import resolve_auth
    assert resolve_auth("jira") is None
    assert resolve_auth("confluence") is None


def test_resolve_auth_returns_none_when_unconfigured(tmp_path, monkeypatch):
    _fresh_state(tmp_path, monkeypatch)
    from react_core.connectors.auth import resolve_auth
    assert resolve_auth("jira") is None
    assert resolve_auth("confluence") is None


# ------------------------------------------------------------ tool wiring --

def test_jira_hierarchy_registered_in_qa_profile():
    from react_core.tools.registry import ToolRegistry
    reg = ToolRegistry.build_for_workspace(".", thread_id="tid1")
    assert "jira_hierarchy" in reg.names()
    assert "confluence_page_extract" in reg.names()


def test_jira_hierarchy_scope_to_jql():
    from react_core.tools.jira_hierarchy import _scope_to_jql
    assert _scope_to_jql("epic", "PROJ-1") == '"Epic Link" = PROJ-1 OR parent = PROJ-1'
    assert _scope_to_jql("feature", "PROJ-2") == '"Parent Link" = PROJ-2 OR parent = PROJ-2'
    assert _scope_to_jql("sprint", "Sprint 24") == 'sprint = "Sprint 24"'
    assert _scope_to_jql("pi", "PI-25.1") == 'fixVersion = "PI-25.1" OR "Program Increment" = "PI-25.1"'
    assert _scope_to_jql("assignee", "krishanu.ganguli") == 'assignee = "krishanu.ganguli"'
    assert _scope_to_jql("jql", "project = PROJ AND status = Open") == "project = PROJ AND status = Open"
    assert _scope_to_jql("nonsense", "x") is None


def test_jira_hierarchy_errors_when_unconfigured(tmp_path, monkeypatch):
    _fresh_state(tmp_path, monkeypatch)
    from react_core.tools.jira_hierarchy import JiraHierarchyTool
    tool = JiraHierarchyTool(".")
    result = asyncio.run(tool.run(scope="assignee", value="krishanu.ganguli"))
    assert "error" in result
    assert "Settings" in result["error"]


def test_confluence_extract_errors_when_unconfigured(tmp_path, monkeypatch):
    _fresh_state(tmp_path, monkeypatch)
    from react_core.tools.confluence_page_extract import ConfluencePageExtractTool
    tool = ConfluencePageExtractTool(".")
    result = asyncio.run(tool.run(page_id="12345"))
    assert "error" in result
    assert "Settings" in result["error"]


# ------------------------------------------------------------- integration -

def test_jira_hierarchy_e2e_with_mock_transport(tmp_path, monkeypatch):
    """Seed a credential in the App DB, patch httpx, exercise the walker."""
    _fresh_state(tmp_path, monkeypatch)

    from react_core.app_db import Credential, get_app_db
    db = get_app_db()
    db.upsert_credential(Credential(
        id="", user_id="admin", team_id=None,
        provider="jira",
        base_url="https://jira.mock.example",
        token="fake-pat-for-mock",
        refresh_token=None, expires_at=None,
        auth_type="pat", email=None,
        created_at="", updated_at="",
    ))

    import httpx
    calls: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((str(request.url), dict(request.headers)))
        path = request.url.path
        if path.endswith("/search"):
            jql = request.url.params.get("jql", "")
            if 'assignee = "krishanu.ganguli"' in jql:
                return httpx.Response(200, json={
                    "startAt": 0, "total": 1, "maxResults": 100,
                    "issues": [{
                        "key": "PROJ-1",
                        "fields": {
                            "summary": "Root story",
                            "status": {"name": "In Progress"},
                            "issuetype": {"name": "Story"},
                            "priority": {"name": "High"},
                            "assignee": {"name": "krishanu.ganguli"},
                            "labels": ["billing"],
                            "updated": "2026-09-17T00:00:00.000+0000",
                        },
                    }],
                })
            if 'parent = "PROJ-1"' in jql:
                return httpx.Response(200, json={
                    "startAt": 0, "total": 1, "maxResults": 50,
                    "issues": [{
                        "key": "PROJ-2",
                        "fields": {
                            "summary": "Sub-task under PROJ-1",
                            "status": {"name": "To Do"},
                            "issuetype": {"name": "Sub-task"},
                            "priority": None,
                            "assignee": None,
                            "labels": [],
                            "updated": "2026-09-17T00:00:00.000+0000",
                        },
                    }],
                })
            return httpx.Response(200, json={"startAt": 0, "total": 0, "maxResults": 0, "issues": []})
        return httpx.Response(404, json={"error": "not-mocked"})

    real_async_client = httpx.AsyncClient
    class PatchedClient(real_async_client):
        def __init__(self, *a, **kw):
            kw.pop("transport", None)
            super().__init__(*a, transport=httpx.MockTransport(handler), **kw)
    monkeypatch.setattr("react_core.connectors.jira.httpx.AsyncClient", PatchedClient)

    from react_core.tools.jira_hierarchy import JiraHierarchyTool
    tool = JiraHierarchyTool(".")
    result = asyncio.run(tool.run(
        scope="assignee", value="krishanu.ganguli",
        recursive=True, max_depth=2, with_details=False,
    ))

    assert "error" not in result
    assert result["total"] == 2
    assert len(result["issues"]) == 1
    assert result["issues"][0]["key"] == "PROJ-1"
    assert result["issues"][0]["children"][0]["key"] == "PROJ-2"
    assert all(
        "bearer fake-pat-for-mock" in (headers.get("authorization") or "").lower()
        for _, headers in calls
    )
