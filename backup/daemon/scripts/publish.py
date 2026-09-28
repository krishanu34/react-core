#!/usr/bin/env python
"""
publish.py — upload the built daemon binaries to Blob storage.

Stores the installer binaries the same way the rest of the app stores artifacts:
via ``common_utils.blob_storage.upload_file`` (the helper legacy_modernization and
others already use) — no ``az`` CLI, no manual path juggling. The blob names come
from ``common_utils.daemon_assets``, the same source the download endpoint reads,
so the upload target always matches what the server serves.

Usage (from anywhere in the repo):
    python daemon/scripts/publish.py            # upload whatever is in daemon/dist/
    python daemon/scripts/publish.py --build    # run `npm run build` first (current OS)

Requires BLOB_STORAGE_ACCOUNT_NAME / BLOB_STORAGE_ACCOUNT_KEY (loaded from the
repo-root .env if present, same as the backends).
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path

DAEMON_DIR = Path(__file__).resolve().parents[1]        # .../daemon
REPO_ROOT = DAEMON_DIR.parent                            # repo root
DIST_DIR = DAEMON_DIR / "dist"

# Make repo-root packages (common_utils) importable.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _load_env() -> None:
    """Load repo-root .env into the environment (best-effort), like the backends."""
    env_path = REPO_ROOT / ".env"
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(env_path)
        return
    except Exception:
        pass
    # Minimal fallback parser if python-dotenv isn't installed.
    import os

    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def _npm_build() -> None:
    print("• running `npm run build` (current OS) …")
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    subprocess.run([npm, "run", "build"], cwd=DAEMON_DIR, check=True)


def _daemon_version() -> str:
    """The version being published, from daemon/package.json."""
    import json

    return json.loads((DAEMON_DIR / "package.json").read_text(encoding="utf-8"))["version"]


async def _publish(dry_run: bool = False) -> int:
    from common_utils.blob_storage import get_blob_url, is_blob_configured, upload_file
    from common_utils.daemon_assets import MANIFEST_ASSET, PLATFORM_ASSETS, blob_name_for

    configured = is_blob_configured()
    print(f"• blob storage configured: {configured}")
    if not configured and not dry_run:
        print("ERROR: Blob storage is not configured. Set BLOB_STORAGE_ACCOUNT_NAME and "
              "BLOB_STORAGE_ACCOUNT_KEY (in .env or the environment).", file=sys.stderr)
        return 1

    if dry_run:
        print("\n-- DRY RUN — nothing will be uploaded --")
        for asset in PLATFORM_ASSETS.values():
            local = DIST_DIR / asset
            mark = "found" if local.exists() else "missing"
            print(f"  {asset:28} [{mark:7}] → {blob_name_for(asset)}")
        print(f"  {MANIFEST_ASSET:28} [version {_daemon_version()}] → {blob_name_for(MANIFEST_ASSET)}")
        print("\nRe-run without --dry-run to upload the found binaries.")
        return 0

    uploaded, missing = [], []
    for asset in PLATFORM_ASSETS.values():
        local = DIST_DIR / asset
        if not local.exists():
            missing.append(asset)
            continue
        blob_name = blob_name_for(asset)
        print(f"• uploading {asset} → {blob_name}")
        url = await upload_file(
            blob_name,
            local,
            content_type="application/octet-stream",  # force download, don't render
            overwrite=True,
        )
        uploaded.append((asset, url))

    # Publish the version manifest so clients can detect updates and offer
    # one-click self-update (backend /api/daemon/latest-version reads this).
    if uploaded:
        import json

        manifest_path = DIST_DIR / MANIFEST_ASSET
        manifest_path.write_text(json.dumps({"version": _daemon_version()}), encoding="utf-8")
        manifest_blob = blob_name_for(MANIFEST_ASSET)
        print(f"• uploading {MANIFEST_ASSET} (version {_daemon_version()}) → {manifest_blob}")
        await upload_file(manifest_blob, manifest_path, content_type="application/json", overwrite=True)

    print()
    if uploaded:
        print(f"Uploaded {len(uploaded)} binary(ies):")
        for asset, url in uploaded:
            print(f"  ✔ {asset}\n     {url}")
    if missing:
        print(f"\nSkipped (not built on this machine): {', '.join(missing)}")
        print("  (SEA builds one OS at a time — run `npm run build` on each OS to produce the rest.)")
    if not uploaded:
        print("\nERROR: no binaries found in daemon/dist/. Build first: cd daemon && npm run build",
              file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload daemon binaries to Blob storage.")
    parser.add_argument("--build", action="store_true", help="run `npm run build` for the current OS first")
    parser.add_argument("--dry-run", action="store_true", help="show what would be uploaded, upload nothing")
    args = parser.parse_args()

    _load_env()
    if args.build and not args.dry_run:
        _npm_build()
    return asyncio.run(_publish(dry_run=args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
