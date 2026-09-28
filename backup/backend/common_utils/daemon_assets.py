"""
Canonical mapping of daemon installer assets to their Blob storage locations.

Single source of truth shared by:
  • the download endpoint (devsphere_ai/workspace_studio/controllers/daemon.py),
    which hands out SAS links, and
  • the publish script (daemon/scripts/publish.py), which uploads the binaries.

Keeping the prefix + filenames here means the "where it's uploaded" and "where
it's served from" can never drift.
"""

from __future__ import annotations

import os

# Folder (prefix) inside the Blob container where daemon binaries live.
# Override with the DAEMON_BLOB_PREFIX env var if needed.
DAEMON_BLOB_PREFIX = os.getenv("DAEMON_BLOB_PREFIX", "devaccel-daemon")

# platform keyword (as sent by the client) -> binary filename
PLATFORM_ASSETS: dict[str, str] = {
    "win": "devaccel-daemon-win.exe",
    "mac": "devaccel-daemon-macos",
    "linux": "devaccel-daemon-linux",
}

# Version manifest published alongside the binaries ({"version": "x.y.z"}).
# Read by the latest-version endpoint so clients can offer one-click self-update.
MANIFEST_ASSET = "manifest.json"


def blob_name_for(asset: str) -> str:
    """Full blob name (prefix + filename) for a given asset filename."""
    return f"{DAEMON_BLOB_PREFIX}/{asset}"


def blob_name_for_platform(platform: str) -> str | None:
    """Full blob name for a platform keyword, or None if unsupported."""
    asset = PLATFORM_ASSETS.get(platform)
    return blob_name_for(asset) if asset else None
