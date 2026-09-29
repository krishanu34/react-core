"""Project CRUD tests (App DB) + registry project scoping."""
from __future__ import annotations

import asyncio


def _db(tmp_path, monkeypatch):
    monkeypatch.setenv("REACT_CORE_STATE_DIR", str(tmp_path))
    from react_core.app_db import reset_app_db_for_tests, get_app_db
    reset_app_db_for_tests(None)
    return get_app_db()


def test_default_project_is_seeded(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    default = db.get_default_project()
    assert default.id == "1"
    assert db.get_project("1") is not None


def test_create_list_get_delete_project(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    from react_core.app_db import Project
    org = db.get_default_org()

    created = db.create_project(Project(
        id="", org_id=org.id, name="Checkout", description="billing flows",
        created_at="", updated_at="",
    ))
    assert created.id
    assert created.name == "Checkout"

    fetched = db.get_project(created.id)
    assert fetched is not None and fetched.description == "billing flows"

    listed = db.list_projects(org.id)
    assert any(p.id == created.id for p in listed)

    assert db.delete_project(created.id) is True
    assert db.get_project(created.id) is None


def test_registry_threads_project_id_to_tools(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    from react_core.tools.registry import ToolRegistry
    reg = ToolRegistry.build_for_workspace(
        str(tmp_path), thread_id="t-1", org_id="org-default",
        user_id="admin", project_id="proj-1",
    )
    # Vector-store and QA tools that carry project scope should have received it.
    search = reg.get("search_semantic")
    assert search is not None
    assert getattr(search, "_project_id", None) == "proj-1"
    rtm = reg.get("build_traceability_matrix")
    assert rtm is not None
    assert getattr(rtm, "_project_id", None) == "proj-1"
