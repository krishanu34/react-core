from __future__ import annotations

import pytest
from fastapi import HTTPException

from workspace_studio.security.auth import WORKSPACE_STUDIO_ROLE, require_role


@pytest.mark.asyncio
async def test_workspace_studio_role_required_for_non_admin_users():
    guard = require_role(WORKSPACE_STUDIO_ROLE)

    with pytest.raises(HTTPException) as exc:
        await guard({"user_id": 7, "roles": ["developer"], "is_admin": False})

    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_workspace_studio_role_allows_role_user_and_admin():
    guard = require_role(WORKSPACE_STUDIO_ROLE)
    role_user = {"user_id": 7, "roles": [WORKSPACE_STUDIO_ROLE], "is_admin": False}
    admin_user = {"user_id": 1, "roles": [], "is_admin": True}

    assert await guard(role_user) == role_user
    assert await guard(admin_user) == admin_user
