"""Path normalization and traversal protection for workspace files."""

from __future__ import annotations

from pathlib import PurePosixPath

from workspace_studio.models.exceptions import ValidationError


def normalize_workspace_path(raw_path: str) -> str:
    text = str(raw_path or "").replace("\\", "/").strip()
    text = text.lstrip("/")
    if not text:
        raise ValidationError("File path is required")

    parts: list[str] = []
    for part in PurePosixPath(text).parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise ValidationError("Invalid path traversal")
        if "\x00" in part:
            raise ValidationError("Invalid path")
        parts.append(part)

    if not parts:
        raise ValidationError("File path is required")
    return "/".join(parts)


def split_parent(path: str) -> tuple[str, str]:
    normalized = normalize_workspace_path(path)
    if "/" not in normalized:
        return "", normalized
    parent, name = normalized.rsplit("/", 1)
    return parent, name

