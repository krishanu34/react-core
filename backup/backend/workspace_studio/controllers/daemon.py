"""
Local daemon support endpoints.

Two thin, stateless endpoints that keep the server light while enabling the
client-side local daemon (which does all file I/O on the user's machine):

  • GET /api/daemon/verify        — introspection: the daemon calls this with the
                                    user's DevAccel session token to confirm a
                                    live login before issuing its own token
                                    (Story 4 — session-bound auth).
  • GET /api/daemon/download-url  — returns a short-lived SAS link to the daemon
                                    installer binary in Blob storage, per OS
                                    (Story 1 — download/install).
  • GET /api/daemon/latest-version — the newest published daemon version (from
                                    the manifest publish.py uploads next to the
                                    binaries), so any client (web/CLI/IDE) can
                                    offer one-click self-update.

None of these endpoints touch user files or the workspace index — those stay on
the client. The server only verifies a session and hands out links/metadata.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Query

from common_utils.daemon_assets import MANIFEST_ASSET, PLATFORM_ASSETS, blob_name_for
from workspace_studio.security.auth import get_current_user


router = APIRouter(prefix="/api/daemon", tags=["Local Daemon"])

_SAS_EXPIRY_MINUTES = 15

# latest-version cache: the manifest changes only on publish, so avoid hitting
# Blob storage on every poll. (version, fetched_at_monotonic)
_LATEST_CACHE_TTL_SECONDS = 300
_latest_cache: tuple[str, float] | None = None


@router.get("/verify")
def verify_session(current_user: dict = Depends(get_current_user)) -> dict:
    """
    Confirm the caller holds a valid DevAccel session.

    The local daemon calls this (via the app's /workspace-api proxy) with the
    browser's session token in the Authorization header. A 200 here means the
    session is live, so the daemon may issue a pairing token bound to it.
    """
    return {
        "ok": True,
        "user_id": current_user["user_id"],
        "username": current_user.get("username", ""),
    }


@router.get("/download-url")
def daemon_download_url(
    platform: str = Query(..., description="Target OS: win | mac | linux"),
    _current_user: dict = Depends(get_current_user),
) -> dict:
    """Return a short-lived SAS download URL for the daemon installer for `platform`."""
    if platform not in PLATFORM_ASSETS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported platform '{platform}'. Use one of: {', '.join(PLATFORM_ASSETS)}.",
        )

    from common_utils.blob_storage import generate_download_sas_url, is_blob_configured

    if not is_blob_configured():
        raise HTTPException(status_code=503, detail="Daemon download is not configured on this server.")

    blob_name = blob_name_for(PLATFORM_ASSETS[platform])
    try:
        url = generate_download_sas_url(blob_name, expiry_minutes=_SAS_EXPIRY_MINUTES)
    except Exception as exc:  # noqa: BLE001 — surface a clean 503 to the client
        raise HTTPException(status_code=503, detail=f"Could not generate download link: {exc}") from exc

    return {"url": url, "filename": PLATFORM_ASSETS[platform], "expires_in": _SAS_EXPIRY_MINUTES * 60}


@router.get("/latest-version")
def daemon_latest_version(_current_user: dict = Depends(get_current_user)) -> dict:
    """
    Return the newest published daemon version, read from the manifest that
    daemon/scripts/publish.py uploads alongside the binaries. Cached in-process
    for a few minutes — clients poll this to decide whether to show an
    "Update daemon" action.
    """
    global _latest_cache

    if _latest_cache is not None and time.monotonic() - _latest_cache[1] < _LATEST_CACHE_TTL_SECONDS:
        return {"version": _latest_cache[0]}

    from common_utils.blob_storage import generate_download_sas_url, is_blob_configured

    if not is_blob_configured():
        raise HTTPException(status_code=503, detail="Daemon distribution is not configured on this server.")

    import httpx

    try:
        manifest_url = generate_download_sas_url(blob_name_for(MANIFEST_ASSET), expiry_minutes=5)
        resp = httpx.get(manifest_url, timeout=5.0)
        resp.raise_for_status()
        version = str(resp.json()["version"])
    except Exception as exc:  # noqa: BLE001 — surface a clean 503 to the client
        raise HTTPException(status_code=503, detail=f"Could not read the daemon version manifest: {exc}") from exc

    _latest_cache = (version, time.monotonic())
    return {"version": version}
