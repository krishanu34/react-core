"""Workspace isolation: the OWNER is the tenancy boundary.

These tests replace a set that asserted *project* scoping. That model came from
the DevAccel monorepo, where a project was the tenancy unit and `/api/v1/projects`
existed to enumerate them. In this standalone product there is no projects table
and no such endpoint, so project scoping filtered on a column nothing populated —
workspaces vanished from the UI — while `owner_user_id` was written on create and
never read, leaving every workspace reachable by id from any account holding the
workspace_studio role.
"""

from __future__ import annotations

import pytest

from workspace_studio.models.exceptions import DuplicateError, NotFoundError
from workspace_studio.schemas.workspace import WorkspaceCreateRequest, WorkspaceUpdateRequest
from workspace_studio.services.workspace_service import WorkspaceService
from tests.fakes import FakeWorkspaceRepository


CREATOR = {"user_id": 7, "roles": ["workspace_studio"], "is_admin": False}
OTHER_USER = {"user_id": 8, "roles": ["workspace_studio"], "is_admin": False}
ADMIN = {"user_id": 9, "roles": ["workspace_studio"], "is_admin": True}


def _new(name: str, path: str = "C:/demo") -> WorkspaceCreateRequest:
    return WorkspaceCreateRequest(name=name, local_fs_path=path)


def test_create_assigns_the_authenticated_user_as_owner():
    repo = FakeWorkspaceRepository()
    created = WorkspaceService(repo).create(_new("Client App", "C:/demo/client-app"), CREATOR)

    assert created.owner_user_id == 7
    assert created.local_fs_path == "C:/demo/client-app"


def test_list_returns_only_the_callers_own_workspaces():
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    service.create(_new("Creator Workspace", "C:/creator"), CREATOR)
    service.create(_new("Other Workspace", "C:/other"), OTHER_USER)

    mine = {i.name for i in service.list(current_user=CREATOR, page=1, page_size=50).items}
    theirs = {i.name for i in service.list(current_user=OTHER_USER, page=1, page_size=50).items}

    assert "Creator Workspace" in mine and "Other Workspace" not in mine
    assert "Other Workspace" in theirs and "Creator Workspace" not in theirs


def test_list_requires_no_client_supplied_scope():
    """Scope comes from the JWT. A client can't widen it by passing a parameter."""
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    service.create(_new("Mine", "C:/mine"), CREATOR)

    result = service.list(current_user=CREATOR, page=1, page_size=50)

    assert result.items, "the caller's own workspaces must still be returned"
    assert all(i.owner_user_id == 7 for i in result.items)


def test_admin_sees_every_owners_workspaces():
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    service.create(_new("Creator Workspace", "C:/creator"), CREATOR)
    service.create(_new("Other Workspace", "C:/other"), OTHER_USER)

    result = service.list(current_user=ADMIN, page=1, page_size=50)

    assert {i.name for i in result.items} >= {"Creator Workspace", "Other Workspace"}


def test_reading_another_users_workspace_is_not_found():
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    mine = service.create(_new("Private", "C:/private"), CREATOR)

    with pytest.raises(NotFoundError):
        service.get(mine.id, OTHER_USER)


def test_mutating_another_users_workspace_is_not_found():
    """update/delete/archive/restore/set_active all went straight to the repo
    with no ownership gate — any id was writable by any role holder."""
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    mine = service.create(_new("Private", "C:/private"), CREATOR)

    with pytest.raises(NotFoundError):
        service.update(mine.id, WorkspaceUpdateRequest(name="hijacked"), OTHER_USER)
    with pytest.raises(NotFoundError):
        service.delete(mine.id, OTHER_USER)
    with pytest.raises(NotFoundError):
        service.archive(mine.id, OTHER_USER)
    with pytest.raises(NotFoundError):
        service.restore(mine.id, OTHER_USER)
    with pytest.raises(NotFoundError):
        service.set_active(mine.id, OTHER_USER, None)

    # Untouched.
    assert service.get(mine.id, CREATOR).name == "Private"


def test_a_missing_id_and_someone_elses_id_are_indistinguishable():
    """NotFound rather than Forbidden, so the sequential primary key can't be
    used to enumerate which workspace ids exist."""
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    mine = service.create(_new("Private", "C:/private"), CREATOR)

    with pytest.raises(NotFoundError) as taken:
        service.get(mine.id, OTHER_USER)
    with pytest.raises(NotFoundError) as absent:
        service.get(999_999, OTHER_USER)

    assert str(taken.value) == str(absent.value)


def test_ensure_access_gates_the_sibling_services():
    """sessions / sync / recovery / chat all authorise through this one call."""
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    mine = service.create(_new("Private", "C:/private"), CREATOR)

    service.ensure_access(mine.id, CREATOR)      # no raise
    service.ensure_access(mine.id, ADMIN)        # admins pass
    with pytest.raises(NotFoundError):
        service.ensure_access(mine.id, OTHER_USER)


def test_duplicate_active_names_conflict_per_owner_not_globally():
    repo = FakeWorkspaceRepository()
    service = WorkspaceService(repo)
    service.create(_new("Client App", "C:/one"), CREATOR)

    # Same name, different owner: allowed (ux_workspaces_owner_name_active).
    service.create(_new("Client App", "C:/two"), OTHER_USER)

    # Same name, same owner, case-insensitive: rejected.
    with pytest.raises(DuplicateError):
        service.create(_new("client app", "C:/three"), CREATOR)
