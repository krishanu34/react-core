"""Atomic JSON + Markdown pair writer.

Enforces the QA-layer invariant I3: every deliverable exists in two shapes,
always on disk together, always recorded in the App DB. Path-guarded by
`permissions.path_guard.resolve_in_root` so an LLM cannot escape the
workspace via a crafted `rel_path`.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from ..app_db import Artefact, get_app_db
from ..permissions.path_guard import PathEscape, resolve_in_root

log = logging.getLogger(__name__)


class ArtefactWriteError(RuntimeError):
    pass


def write_artefact(
    workspace: str | Path,
    rel_path: str,
    data: Any,
    markdown: str,
    *,
    org_id: str,
    thread_id: str,
    kind: str,
    project_id: Optional[str] = None,
) -> tuple[Path, Path]:
    """Write `<rel_path>.json` and `<rel_path>.md` inside `workspace`.

    - `data` must be a dataclass exposing `to_dict()` OR a JSON-serialisable
      dict / list. Anything else raises `ArtefactWriteError`.
    - Both files are recorded in the App DB as artefacts under `kind`
      (JSON) and `<kind>_md` (Markdown).
    - Returns absolute paths for both files.
    """
    rel_path = _normalise_rel_path(rel_path)
    try:
        json_target = resolve_in_root(workspace, f"{rel_path}.json")
        md_target = resolve_in_root(workspace, f"{rel_path}.md")
    except PathEscape as e:
        raise ArtefactWriteError(f"path escape rejected: {e}") from e

    payload = _serialise(data)

    json_target.parent.mkdir(parents=True, exist_ok=True)
    json_target.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    md_target.write_text(markdown, encoding="utf-8")

    _register(
        thread_id=thread_id, org_id=org_id, project_id=project_id,
        rel_path=rel_path, kind=kind,
        json_size=json_target.stat().st_size,
        md_size=md_target.stat().st_size,
    )
    return json_target, md_target


def write_text_artefact(
    workspace: str | Path,
    rel_path: str,
    text: str,
    *,
    org_id: str,
    thread_id: str,
    kind: str,
    project_id: Optional[str] = None,
) -> Path:
    """Write ONE plain-text file. Used for `.feature` files where the "logical
    layer" JSON side is written separately (via `write_artefact`)."""
    rel_path = _normalise_rel_path(rel_path)
    try:
        target = resolve_in_root(workspace, rel_path)
    except PathEscape as e:
        raise ArtefactWriteError(f"path escape rejected: {e}") from e

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    _register_single(
        thread_id=thread_id, org_id=org_id, project_id=project_id,
        rel_path=rel_path, kind=kind, size=target.stat().st_size,
    )
    return target


def _normalise_rel_path(rel_path: str) -> str:
    r = (rel_path or "").strip()
    if not r:
        raise ArtefactWriteError("rel_path is required")
    # Drop trailing .json/.md so callers can pass either "artefacts/analysis"
    # or "artefacts/analysis.json" and get consistent behaviour.
    for suffix in (".json", ".md"):
        if r.endswith(suffix):
            r = r[: -len(suffix)]
            break
    return r.replace("\\", "/").lstrip("/")


def _serialise(data: Any) -> Any:
    if hasattr(data, "to_dict") and callable(data.to_dict):
        return data.to_dict()
    if isinstance(data, (dict, list)):
        return data
    raise ArtefactWriteError(f"cannot serialise {type(data).__name__}: needs to_dict() or be a dict/list")


def _register(
    *, thread_id: str, org_id: str, project_id: Optional[str],
    rel_path: str, kind: str, json_size: int, md_size: int,
) -> None:
    db = get_app_db()
    try:
        db.add_artefact(Artefact(
            id="", thread_id=thread_id, org_id=org_id, project_id=project_id,
            kind=kind, name=Path(rel_path).name, path=f"{rel_path}.json",
            size=json_size, approved_by=None, approved_at=None, created_at="",
        ))
        db.add_artefact(Artefact(
            id="", thread_id=thread_id, org_id=org_id, project_id=project_id,
            kind=f"{kind}_md", name=Path(rel_path).name, path=f"{rel_path}.md",
            size=md_size, approved_by=None, approved_at=None, created_at="",
        ))
    except Exception as e:  # noqa: BLE001 — DB failure must not corrupt on-disk output
        log.warning("artefact DB registration failed for %s: %s", rel_path, e)


def _register_single(
    *, thread_id: str, org_id: str, project_id: Optional[str],
    rel_path: str, kind: str, size: int,
) -> None:
    db = get_app_db()
    try:
        db.add_artefact(Artefact(
            id="", thread_id=thread_id, org_id=org_id, project_id=project_id,
            kind=kind, name=Path(rel_path).name, path=rel_path,
            size=size, approved_by=None, approved_at=None, created_at="",
        ))
    except Exception as e:  # noqa: BLE001
        log.warning("artefact DB registration failed for %s: %s", rel_path, e)
