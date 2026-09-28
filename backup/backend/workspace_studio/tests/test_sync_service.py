from __future__ import annotations

import pytest
from pydantic import ValidationError as PydanticValidationError

from workspace_studio.schemas.sync import SyncOperation, SyncRequest
from workspace_studio.services.sync_service import SyncService
from tests.fakes import FakeWorkspaceRepository


USER = {"user_id": 7, "roles": ["workspace_studio"], "is_admin": False}


def test_sync_applies_metadata_and_replays_idempotently():
    repo = FakeWorkspaceRepository()
    service = SyncService(repo)
    body = SyncRequest(
        client_id="browser-1",
        batch_id="batch-1",
        operations=[
            SyncOperation(
                op_id="op-1",
                op="metadata",
                payload={"id": 1, "name": "Client Workspace", "localPathLabel": "C:/client"},
            )
        ],
    )

    first = service.apply(1, body, USER)
    second = service.apply(1, body, USER)

    assert first.status == "synced"
    assert first.applied[0].status == "applied"
    assert repo.metadata[1]["name"] == "Client Workspace"
    assert second.idempotent_replay is True


def test_sync_schema_rejects_file_operations():
    with pytest.raises(PydanticValidationError):
        SyncOperation(
            op_id="op-1",
            op="create",
            path="src/main.py",
            type="file",
            payload={"content": "print('hello')"},
        )
