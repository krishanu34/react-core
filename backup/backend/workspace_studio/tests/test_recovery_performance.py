from __future__ import annotations

import time

from workspace_studio.schemas.recovery import WorkspaceRecoveryState


def test_recovery_state_for_500_files_serializes_under_three_seconds():
    state = WorkspaceRecoveryState(
        open_tabs=[{"path": f"src/file_{i}.py", "order": i} for i in range(20)],
        active_files=["src/file_1.py"],
        folder_tree=[{"path": f"src/file_{i}.py", "type": "file"} for i in range(500)],
        expanded_folders=["src"],
        layout={"left": 260, "bottom": 180},
        session={"id": 1},
        recent_files=[f"src/file_{i}.py" for i in range(25)],
    )

    start = time.perf_counter()
    payload = state.model_dump(mode="json")
    restored = WorkspaceRecoveryState.model_validate(payload)
    elapsed = time.perf_counter() - start

    assert len(restored.folder_tree) == 500
    assert elapsed < 3.0

