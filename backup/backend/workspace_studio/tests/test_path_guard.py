from __future__ import annotations

import pytest

from workspace_studio.filesystem.path_guard import normalize_workspace_path, split_parent
from workspace_studio.models.exceptions import ValidationError


def test_normalize_workspace_path_accepts_nested_relative_paths():
    assert normalize_workspace_path("/src\\app/main.py") == "src/app/main.py"
    assert split_parent("src/app/main.py") == ("src/app", "main.py")


@pytest.mark.parametrize("path", ["../secret.txt", "src/../../secret.txt", "", "/"])
def test_normalize_workspace_path_rejects_unsafe_paths(path: str):
    with pytest.raises(ValidationError):
        normalize_workspace_path(path)

