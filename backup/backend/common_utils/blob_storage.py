"""
common_utils/blob_storage.py
═══════════════════════════════════════════════════════════════════════════════
Generic Azure Blob Storage client for the DevAccel platform.

Any module (code_builder, story_builder, doc_builder) can use this to
upload / download / list artefacts in Azure Blob Storage.

Environment variables (from .env):
    BLOB_STORAGE_ACCOUNT_NAME   — Azure Storage account name
    BLOB_STORAGE_ACCOUNT_KEY    — Azure Storage account key
    BLOB_STORAGE_CONTAINER_NAME — Default container (e.g. "dxc-root-v2")

Quick start::

    from common_utils.blob_storage import get_blob_client, upload_file, upload_directory

    # Upload a single file
    url = await upload_file("code_builder/runs/abc-123/src/main.py", local_path)

    # Upload an entire directory (returns list of urls)
    results = await upload_directory("code_builder/runs/abc-123", "/local/output/dir")

    # Upload bytes directly
    url = await upload_bytes("exports/report.zip", zip_bytes, content_type="application/zip")
"""

from __future__ import annotations

import asyncio
import io
import os
from pathlib import Path
from typing import Any, Optional

from common_utils.logging_config import get_logger

logger = get_logger(__name__)

# ════════════════════════════════════════════════════════════════════════════
#  LAZY CLIENT — initialised on first use
# ════════════════════════════════════════════════════════════════════════════

_container_client: Any = None
_account_name: str | None = None


def _get_settings() -> tuple[str, str, str]:
    """Read blob storage settings from environment."""
    account = os.getenv("BLOB_STORAGE_ACCOUNT_NAME", "")
    key = os.getenv("BLOB_STORAGE_ACCOUNT_KEY", "")
    container = os.getenv("BLOB_STORAGE_CONTAINER_NAME", "dxc-root-v2")
    return account, key, container


def is_blob_configured() -> bool:
    """Return True if blob storage credentials are present in the environment."""
    account, key, _ = _get_settings()
    return bool(account and key)


def get_container_client():
    """
    Return a shared ``ContainerClient``.  Created lazily on first call.
    Thread-safe — the Azure SDK client is safe for concurrent use.
    """
    global _container_client, _account_name

    if _container_client is not None:
        return _container_client

    account, key, container = _get_settings()
    if not account or not key:
        raise RuntimeError(
            "Blob storage is not configured. "
            "Set BLOB_STORAGE_ACCOUNT_NAME and BLOB_STORAGE_ACCOUNT_KEY in .env"
        )

    from azure.storage.blob import ContainerClient

    _account_name = account
    conn_str = (
        f"DefaultEndpointsProtocol=https;"
        f"AccountName={account};"
        f"AccountKey={key};"
        f"EndpointSuffix=core.windows.net"
    )
    _container_client = ContainerClient.from_connection_string(
        conn_str, container_name=container
    )
    logger.info("blob_client_initialised", account=account, container=container)
    return _container_client


def get_blob_url(blob_name: str) -> str:
    """Build the public URL for a blob (without SAS — for DB storage)."""
    account, _, container = _get_settings()
    return f"https://{account}.blob.core.windows.net/{container}/{blob_name}"


def generate_download_sas_url(blob_name: str, *, expiry_minutes: int = 15) -> str:
    """
    Build a short-lived, read-only SAS download URL for a blob.

    Used to hand out time-limited download links (e.g. the local daemon
    installer) without exposing the account key or making the blob public.
    """
    from datetime import datetime, timedelta, timezone

    from azure.storage.blob import BlobSasPermissions, generate_blob_sas

    account, key, container = _get_settings()
    if not account or not key:
        raise RuntimeError(
            "Blob storage is not configured. "
            "Set BLOB_STORAGE_ACCOUNT_NAME and BLOB_STORAGE_ACCOUNT_KEY in .env"
        )

    sas = generate_blob_sas(
        account_name=account,
        container_name=container,
        blob_name=blob_name,
        account_key=key,
        permission=BlobSasPermissions(read=True),
        expiry=datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes),
    )
    return f"{get_blob_url(blob_name)}?{sas}"


# ════════════════════════════════════════════════════════════════════════════
#  UPLOAD HELPERS  (all async — run synchronous SDK in executor)
# ════════════════════════════════════════════════════════════════════════════

async def upload_bytes(
    blob_name: str,
    data: bytes | io.BytesIO,
    *,
    content_type: str = "application/octet-stream",
    overwrite: bool = True,
    metadata: dict[str, str] | None = None,
) -> str:
    """
    Upload raw bytes to blob storage.

    Parameters
    ----------
    blob_name : str
        Full blob path inside the container, e.g. ``"code_builder/runs/abc/app.zip"``.
    data : bytes | BytesIO
        The content to upload.
    content_type : str
        MIME type for the blob.
    overwrite : bool
        Whether to overwrite if blob already exists.
    metadata : dict
        Optional key-value metadata attached to the blob.

    Returns
    -------
    str
        The blob URL.
    """
    from azure.storage.blob import ContentSettings

    container = get_container_client()
    content_settings = ContentSettings(content_type=content_type)

    raw = data if isinstance(data, bytes) else data.read()

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: container.upload_blob(
            name=blob_name,
            data=raw,
            overwrite=overwrite,
            content_settings=content_settings,
            metadata=metadata or {},
        ),
    )
    url = get_blob_url(blob_name)
    logger.info("blob_uploaded", blob_name=blob_name, size=len(raw), content_type=content_type)
    return url


async def upload_file(
    blob_name: str,
    local_path: str | Path,
    *,
    content_type: str | None = None,
    overwrite: bool = True,
    metadata: dict[str, str] | None = None,
) -> str:
    """
    Upload a local file to blob storage.

    Returns the blob URL.
    """
    local_path = Path(local_path)
    if not local_path.exists():
        raise FileNotFoundError(f"Local file not found: {local_path}")

    ct = content_type or _guess_content_type(local_path.name)
    data = local_path.read_bytes()
    return await upload_bytes(blob_name, data, content_type=ct, overwrite=overwrite, metadata=metadata)


async def upload_directory(
    blob_prefix: str,
    local_dir: str | Path,
    *,
    overwrite: bool = True,
    metadata: dict[str, str] | None = None,
) -> list[dict[str, str]]:
    """
    Upload every file in *local_dir* (recursively) to blob storage.

    Each file is stored at ``{blob_prefix}/{relative_path}``.

    Returns a list of dicts: ``[{"path": "src/main.py", "blob_name": "...", "url": "..."}, ...]``
    """
    local_dir = Path(local_dir)
    if not local_dir.is_dir():
        raise NotADirectoryError(f"Not a directory: {local_dir}")

    files = [f for f in local_dir.rglob("*") if f.is_file()]
    logger.info("blob_upload_directory_start", prefix=blob_prefix, file_count=len(files))

    results: list[dict[str, str]] = []
    for file_path in files:
        rel = file_path.relative_to(local_dir).as_posix()
        blob_name = f"{blob_prefix}/{rel}"
        url = await upload_file(blob_name, file_path, overwrite=overwrite, metadata=metadata)
        results.append({"path": rel, "blob_name": blob_name, "url": url})

    logger.info("blob_upload_directory_done", prefix=blob_prefix, uploaded=len(results))
    return results


async def upload_zip(
    blob_name: str,
    local_dir: str | Path,
    *,
    overwrite: bool = True,
    metadata: dict[str, str] | None = None,
) -> str:
    """
    Create a ZIP of *local_dir* in-memory and upload it as a single blob.

    Returns the blob URL.
    """
    import zipfile

    local_dir = Path(local_dir)
    if not local_dir.is_dir():
        raise NotADirectoryError(f"Not a directory: {local_dir}")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in local_dir.rglob("*"):
            if file_path.is_file():
                arcname = file_path.relative_to(local_dir).as_posix()
                zf.write(file_path, arcname)
    buf.seek(0)
    size_kb = len(buf.getvalue()) // 1024
    logger.info("blob_zip_created", blob_name=blob_name, size_kb=size_kb)

    return await upload_bytes(
        blob_name, buf, content_type="application/zip", overwrite=overwrite, metadata=metadata,
    )


# ════════════════════════════════════════════════════════════════════════════
#  DOWNLOAD / LIST HELPERS
# ════════════════════════════════════════════════════════════════════════════

async def download_blob(blob_name: str) -> bytes:
    """Download a blob and return its content as bytes."""
    container = get_container_client()
    loop = asyncio.get_event_loop()
    blob_data = await loop.run_in_executor(
        None,
        lambda: container.download_blob(blob_name).readall(),
    )
    return blob_data


async def list_blobs(prefix: str, *, max_results: int = 1000) -> list[dict[str, Any]]:
    """
    List blobs under a prefix.

    Returns a list of dicts with ``name``, ``size``, ``last_modified``.
    """
    container = get_container_client()
    loop = asyncio.get_event_loop()

    def _list():
        results = []
        for blob in container.list_blobs(name_starts_with=prefix):
            results.append({
                "name": blob.name,
                "size": blob.size,
                "last_modified": blob.last_modified,
                "content_type": blob.content_settings.content_type if blob.content_settings else None,
            })
            if len(results) >= max_results:
                break
        return results

    return await loop.run_in_executor(None, _list)


async def delete_blob(blob_name: str) -> bool:
    """Delete a blob. Returns True if deleted, False if not found."""
    container = get_container_client()
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(
            None, lambda: container.delete_blob(blob_name),
        )
        return True
    except Exception:
        return False


# ════════════════════════════════════════════════════════════════════════════
#  CONTENT TYPE GUESSING  (technology-agnostic)
# ════════════════════════════════════════════════════════════════════════════

import mimetypes as _mimetypes

# Seed stdlib registry with types it doesn't know out-of-the-box
_EXTRA_TYPES: dict[str, str] = {
    ".ts":   "text/typescript",
    ".tsx":  "text/typescript",
    ".jsx":  "text/javascript",
    ".yaml": "text/yaml",
    ".yml":  "text/yaml",
    ".md":   "text/markdown",
    ".toml": "text/toml",
    ".rs":   "text/x-rust",
    ".go":   "text/x-go",
    ".kt":   "text/x-kotlin",
    ".swift": "text/x-swift",
    ".dart": "text/x-dart",
    ".vue":  "text/x-vue",
    ".svelte": "text/x-svelte",
    ".env":  "text/plain",
}
for _ext, _ct in _EXTRA_TYPES.items():
    _mimetypes.add_type(_ct, _ext)


def _guess_content_type(filename: str) -> str:
    ct, _ = _mimetypes.guess_type(filename, strict=False)
    return ct or "application/octet-stream"
