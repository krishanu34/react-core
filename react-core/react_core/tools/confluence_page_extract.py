"""confluence_page_extract — deep extraction of a Confluence page.

Beyond `confluence_fetch_page`:
- Extracts full HTML body to clean text (reuses the attachment extractor).
- Optionally lists attachment metadata.
- Optionally recurses into child pages up to `max_depth`, returning a
  structured tree with text at every node.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..attachments.extractors import render_html_to_text
from ..connectors import Confluence, resolve_auth
from ..connectors.confluence import ConfluenceError
from .base import BaseTool

log = logging.getLogger(__name__)


class ConfluencePageExtractTool(BaseTool):
    name = "confluence_page_extract"
    description = (
        "Deep-extract a Confluence page: clean plain text, optional "
        "attachment metadata, and optional recursive descent into child "
        "pages. Prefer this over confluence_fetch_page when you need the "
        "full sub-tree or attachments."
    )

    def __init__(self, workspace: str, *, user_id: str = "admin"):
        super().__init__(workspace)
        self._user_id = user_id

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "page_id": {"type": "string"},
                "recursive": {
                    "type": "boolean",
                    "description": "Follow child pages. Default false.",
                },
                "max_depth": {
                    "type": "integer",
                    "description": "Recursion cap. Default 2.",
                },
                "max_pages": {
                    "type": "integer",
                    "description": "Hard cap across the whole traversal. Default 50.",
                },
                "include_attachments": {
                    "type": "boolean",
                    "description": "Include attachment metadata. Default true.",
                },
            },
            "required": ["page_id"],
        }

    async def run(
        self,
        page_id: str,
        recursive: bool = False,
        max_depth: int = 2,
        max_pages: int = 50,
        include_attachments: bool = True,
        **_: Any,
    ) -> dict[str, Any]:
        auth = resolve_auth("confluence", user_id=self._user_id)
        if auth is None:
            return {"error": "Confluence not configured. Open the UI Settings panel and add your Confluence base URL + PAT."}

        client = Confluence(auth)
        visited: set[str] = set()
        warnings: list[str] = []
        try:
            root = await _walk_page(
                client, page_id,
                visited=visited, warnings=warnings,
                depth=0, max_depth=max_depth, max_pages=max_pages,
                recursive=recursive, include_attachments=include_attachments,
            )
        except ConfluenceError as e:
            return {"error": str(e), "page_id": page_id}

        return {
            "flavor": client.flavor,
            "total_pages": len(visited),
            "page": root,
            "warnings": warnings,
        }


async def _walk_page(
    client: Confluence,
    page_id: str,
    *,
    visited: set[str],
    warnings: list[str],
    depth: int,
    max_depth: int,
    max_pages: int,
    recursive: bool,
    include_attachments: bool,
) -> dict[str, Any]:
    visited.add(page_id)
    page = await client.fetch_page(page_id, include_children=False)

    body = page.get("body") or {}
    view_html = (body.get("view") or {}).get("value", "") or ""
    storage_html = (body.get("storage") or {}).get("value", "") or ""
    view_text = render_html_to_text(view_html)
    storage_text = render_html_to_text(storage_html)
    # Pick whichever body actually rendered more text — view_html can be
    # macro-thin while storage carries the actual content.
    if len(storage_text) > len(view_text):
        text = storage_text
        body_source = "storage"
    else:
        text = view_text
        body_source = "view"

    node: dict[str, Any] = {
        "id": page.get("id"),
        "title": page.get("title"),
        "space": (page.get("space") or {}).get("key"),
        "version": (page.get("version") or {}).get("number"),
        "text": text,
        "text_chars": len(text),
        "body_source": body_source,
        "body_chars": {"view": len(view_text), "storage": len(storage_text)},
        "children": [],
    }

    if include_attachments:
        try:
            atts = await client.attachments(page_id)
            node["attachments"] = [
                {
                    "id": a.get("id"),
                    "title": a.get("title"),
                    "media_type": ((a.get("metadata") or {}).get("mediaType"))
                                   or (a.get("extensions") or {}).get("mediaType"),
                    "size": (a.get("extensions") or {}).get("fileSize"),
                    "download_url": (a.get("_links") or {}).get("download"),
                }
                for a in atts
            ]
        except ConfluenceError as e:
            warnings.append(f"attachments fetch failed for {page_id}: {e}")

    if not recursive or depth >= max_depth or len(visited) >= max_pages:
        return node

    try:
        children = await client.child_pages(page_id)
    except ConfluenceError as e:
        warnings.append(f"child fetch failed for {page_id}: {e}")
        return node

    for child in children:
        cid = child.get("id")
        if not cid or cid in visited:
            continue
        if len(visited) >= max_pages:
            warnings.append(f"max_pages={max_pages} reached at {page_id}.")
            break
        try:
            child_node = await _walk_page(
                client, cid,
                visited=visited, warnings=warnings,
                depth=depth + 1, max_depth=max_depth, max_pages=max_pages,
                recursive=True, include_attachments=include_attachments,
            )
            node["children"].append(child_node)
        except ConfluenceError as e:
            warnings.append(f"walk failed for {cid}: {e}")
    return node
