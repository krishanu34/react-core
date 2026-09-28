"""
Contract test: the exact snapshot payload the browser sync engine sends
(ui/src/hooks/useSyncEngine.ts::buildSnapshot + ui/src/lib/workspace-sync-api.ts
::pushWorkspaceSync) must be accepted and fully applied by the real SyncService.

This mirrors, field-for-field, the JSON body pushWorkspaceSync() POSTs to
/api/workspaces/{id}/sync so a drift in either side fails here.
"""
from __future__ import annotations

from workspace_studio.schemas.sync import SyncRequest
from workspace_studio.services.sync_service import SyncService
from tests.fakes import FakeWorkspaceRepository


USER = {"user_id": 7, "roles": ["workspace_studio"], "is_admin": False}


def _frontend_body() -> dict:
    """The literal shape produced by the TypeScript sync engine for workspace 1."""
    return {
        "client_id": "c_1720000000000_abc123",          # getSyncClientId()
        "batch_id": "c_1720000000000_abc123-1720000001",  # `${clientId}-${Date.now()}`
        "local_fs_path": "C:/Users/me/projects/auth-service",
        "base_sync_version": 0,
        # state BEFORE metadata — matches ui/src/hooks/useSyncEngine.ts::buildSnapshot.
        # This order is required so the "state" op does not clobber the metadata
        # (the backend stores metadata nested inside the same session_state row).
        "operations": [
            {
                "op_id": "state-1",
                "op": "state",
                "payload": {
                    "open_tabs": [
                        {"path": "src/app.ts", "active": True, "order": 0},
                        {"path": "src/db.ts", "active": False, "order": 1},
                    ],
                    "active_files": ["src/app.ts"],
                    "recent_files": ["src/app.ts", "src/db.ts"],
                    "layout": {"showExplorer": True, "showChat": False, "explorerW": 264},
                    "version": 1,
                },
            },
            {
                "op_id": "meta-1",
                "op": "metadata",
                "payload": {
                    "id": 1,
                    "name": "Auth Service",
                    "description": None,
                    "localPathLabel": "C:/Users/me/projects/auth-service",
                    "createdAt": 1720000000000,
                    "fileCount": 42,
                },
            },
        ],
    }


def test_frontend_snapshot_applies_metadata_state_and_bumps_version():
    repo = FakeWorkspaceRepository()
    service = SyncService(repo)

    body = SyncRequest.model_validate(_frontend_body())
    result = service.apply(1, body, USER)

    # Both ops applied, no conflicts, version advanced past the client's base.
    assert result.status == "synced"
    assert [op.status for op in result.applied] == ["applied", "applied"]
    assert result.sync_version > body.base_sync_version

    # metadata op → recovery metadata saved with the browser's fields.
    assert repo.metadata[1]["name"] == "Auth Service"
    assert repo.metadata[1]["fileCount"] == 42
    assert repo.metadata[1]["localPathLabel"] == "C:/Users/me/projects/auth-service"

    # state op → recovery state persisted (tabs / active file / layout).
    saved_state = repo.get_recovery_state(1)
    assert saved_state is not None
    assert saved_state["active_files"] == ["src/app.ts"]
    assert len(saved_state["open_tabs"]) == 2
    assert saved_state["layout"]["showExplorer"] is True

    # local_fs_path on the request is written through to the workspace row.
    assert repo.get_workspace(1).local_fs_path == "C:/Users/me/projects/auth-service"

    # An audit/sync log row was recorded for this (client_id, batch_id).
    assert repo.get_sync_log(1, body.client_id, body.batch_id) is not None


def test_frontend_snapshot_is_idempotent_on_retry():
    """pushWorkspaceSync retries reuse the same batch_id → server must dedupe."""
    repo = FakeWorkspaceRepository()
    service = SyncService(repo)
    body = SyncRequest.model_validate(_frontend_body())

    first = service.apply(1, body, USER)
    second = service.apply(1, body, USER)

    assert first.idempotent_replay is False
    assert second.idempotent_replay is True
    # Version must NOT advance twice for the same batch.
    assert first.sync_version == second.sync_version


def test_repeated_syncs_do_not_conflict():
    """Reproduces the live 409: the client sends a constant state `version` on
    every drain, but the server's recovery-state version keeps advancing. Each
    fresh-batch snapshot must still apply (last-writer-wins), never raising a
    recovery-state version conflict (which the API surfaces as HTTP 409)."""
    repo = FakeWorkspaceRepository()
    service = SyncService(repo)

    # Simulate several successive drains, each with a new batch_id (as the real
    # client does) but the same hardcoded state version — as happens whenever a
    # user makes repeated edits in one session.
    for i in range(5):
        body = _frontend_body()
        body["batch_id"] = f"drain-{i}"
        result = service.apply(1, SyncRequest.model_validate(body), USER)
        assert result.status == "synced", f"sync #{i} did not apply: {result.status}"
        assert [op.status for op in result.applied] == ["applied", "applied"]
