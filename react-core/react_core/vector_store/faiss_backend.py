"""FAISS backend for the vector store.

Isolation
---------
This is the ONLY module that imports `faiss`. Callers depend on
`VectorStoreProtocol` — swapping to pgvector / Pinecone later is a peer
file wired in `factory.py`.

Metadata isolation
------------------
FAISS itself is metadata-blind. We store per-chunk metadata in the App DB
(`vector_chunks` table) and use the chunk's row ID as the FAISS vector ID
(via `IndexIDMap2`). At query time we:

  1. Ask FAISS for `k * OVERFETCH` nearest neighbours.
  2. Load their metadata from the App DB.
  3. Filter by `org_id` / `project_id` / `collection_id` in Python.
  4. Return the first `k` survivors.

For MVP scale this is fine. When we outgrow it, pgvector's `WHERE` clause
runs the filter server-side and this file is retired.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..app_db import AppDBProtocol, VectorChunk
from ..embeddings.base import EmbeddingClient
from .base import VectorStoreProtocol
from .models import VectorDoc, VectorHit

log = logging.getLogger(__name__)

_OVERFETCH = 5  # fetch k*OVERFETCH before metadata filtering


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class FaissVectorStore(VectorStoreProtocol):
    """FAISS + App DB backend. Cosine similarity via L2-normalised vectors."""

    def __init__(
        self,
        *,
        index_dir: Path,
        embeddings: EmbeddingClient,
        app_db: AppDBProtocol,
    ):
        self._index_dir = index_dir
        self._embeddings = embeddings
        self._app_db = app_db
        self._lock = threading.RLock()

        self._index_path = self._index_dir / "faiss.index"
        self._meta_path = self._index_dir / "faiss.meta.json"
        self._index_dir.mkdir(parents=True, exist_ok=True)

        self._faiss = None
        self._index = None
        self._dim: Optional[int] = None
        self._load_or_create()

    # ---- VectorStoreProtocol --------------------------------------------
    async def upsert(self, docs: list[VectorDoc]) -> list[int]:
        if not docs:
            return []
        vectors = await self._embeddings.embed([d.text for d in docs])
        if not vectors:
            return []
        dim = len(vectors[0])
        self._ensure_index(dim)

        chunks_meta = [
            VectorChunk(
                id=0,  # SQLite assigns
                source=d.source,
                org_id=d.org_id,
                project_id=d.project_id,
                collection_id=d.collection_id,
                page=d.page,
                chunk_index=d.chunk_index,
                text=d.text,
                metadata=d.metadata,
            )
            for d in docs
        ]
        chunk_ids = self._app_db.add_vector_chunks(chunks_meta)
        await asyncio.to_thread(self._add_to_index, chunk_ids, vectors)
        await asyncio.to_thread(self._persist_index)
        return chunk_ids

    async def search(
        self,
        query: str,
        k: int = 5,
        *,
        org_id: Optional[str] = None,
        project_id: Optional[str] = None,
        collection_id: Optional[str] = None,
        source_filter: Optional[str] = None,
    ) -> list[VectorHit]:
        if not query.strip() or self._index is None or int(self._index.ntotal) == 0:
            return []
        query_vec = (await self._embeddings.embed([query]))[0]

        want = max(k * _OVERFETCH, k + 1)
        ids, scores = await asyncio.to_thread(self._search_index, query_vec, want)
        if not ids:
            return []
        chunks = self._app_db.get_vector_chunks_by_ids(ids)
        by_id = {c.id: c for c in chunks}

        hits: list[VectorHit] = []
        for i, score in zip(ids, scores):
            c = by_id.get(i)
            if c is None:
                continue
            if org_id is not None and c.org_id != org_id:
                continue
            if project_id is not None and c.project_id != project_id:
                continue
            if collection_id is not None and c.collection_id != collection_id:
                continue
            if source_filter is not None and source_filter not in c.source:
                continue
            hits.append(
                VectorHit(
                    chunk_id=c.id,
                    text=c.text,
                    score=float(score),
                    source=c.source,
                    org_id=c.org_id,
                    project_id=c.project_id,
                    collection_id=c.collection_id,
                    page=c.page,
                    chunk_index=c.chunk_index,
                    metadata=c.metadata,
                )
            )
            if len(hits) >= k:
                break
        return hits

    async def delete_source(self, source: str, org_id: str) -> int:
        chunks = await asyncio.to_thread(self._list_chunks_for_source, source, org_id)
        if not chunks:
            return 0
        ids = [c.id for c in chunks]
        removed = self._app_db.delete_vector_chunks_by_source(source, org_id)
        await asyncio.to_thread(self._remove_from_index, ids)
        await asyncio.to_thread(self._persist_index)
        return removed

    async def list_sources(
        self, org_id: str, project_id: Optional[str] = None
    ) -> list[str]:
        sources = self._app_db.list_indexed_sources(org_id, project_id)
        return [s.source for s in sources]

    def close(self) -> None:
        self._persist_index()

    # ---- internals -------------------------------------------------------
    def _load_or_create(self) -> None:
        try:
            import faiss  # type: ignore
        except ImportError as e:  # pragma: no cover
            raise RuntimeError(
                "faiss is not installed. Install with `pip install faiss-cpu`."
            ) from e
        self._faiss = faiss

        if self._index_path.exists() and self._meta_path.exists():
            try:
                self._index = faiss.read_index(str(self._index_path))
                meta = json.loads(self._meta_path.read_text())
                self._dim = int(meta.get("dim") or 0) or None
                log.info(
                    "FAISS index loaded: path=%s dim=%s ntotal=%d",
                    self._index_path, self._dim, int(self._index.ntotal),
                )
                return
            except Exception as e:  # noqa: BLE001
                log.warning("failed to read FAISS index (%s); starting empty", e)
        self._index = None
        self._dim = None

    def _ensure_index(self, dim: int) -> None:
        with self._lock:
            if self._index is None:
                base = self._faiss.IndexFlatIP(dim)
                self._index = self._faiss.IndexIDMap2(base)
                self._dim = dim
            elif self._dim != dim:
                raise RuntimeError(
                    f"embedding dim mismatch: index built at dim={self._dim}, got dim={dim}"
                )

    def _add_to_index(self, ids: list[int], vectors: list[list[float]]) -> None:
        import numpy as np

        arr = np.asarray(vectors, dtype="float32")
        _l2_normalise(arr)
        id_arr = np.asarray(ids, dtype="int64")
        with self._lock:
            assert self._index is not None
            self._index.add_with_ids(arr, id_arr)

    def _search_index(self, query_vec: list[float], want: int) -> tuple[list[int], list[float]]:
        import numpy as np

        arr = np.asarray([query_vec], dtype="float32")
        _l2_normalise(arr)
        with self._lock:
            assert self._index is not None
            scores, ids = self._index.search(arr, want)
        out_ids: list[int] = []
        out_scores: list[float] = []
        for i, s in zip(ids[0].tolist(), scores[0].tolist()):
            if i == -1:
                continue
            out_ids.append(int(i))
            out_scores.append(float(s))
        return out_ids, out_scores

    def _remove_from_index(self, ids: list[int]) -> None:
        import numpy as np

        if not ids:
            return
        id_arr = np.asarray(ids, dtype="int64")
        with self._lock:
            if self._index is None:
                return
            selector = self._faiss.IDSelectorBatch(id_arr)
            try:
                self._index.remove_ids(selector)
            except Exception as e:  # noqa: BLE001
                log.warning("faiss remove_ids failed (%s); leaving orphan vectors", e)

    def _persist_index(self) -> None:
        with self._lock:
            if self._index is None:
                return
            self._faiss.write_index(self._index, str(self._index_path))
            self._meta_path.write_text(json.dumps({
                "dim": self._dim,
                "ntotal": int(self._index.ntotal),
                "updated_at": _utcnow(),
            }))

    def _list_chunks_for_source(self, source: str, org_id: str) -> list[VectorChunk]:
        # Depends on knowing the SQLite backend; a future non-SQLite backend
        # would add a native method to AppDBProtocol.
        from ..app_db.sqlite_backend import SqliteAppDB
        db = self._app_db
        if isinstance(db, SqliteAppDB):
            rows = db._all(  # noqa: SLF001 — same-package helper
                "SELECT id FROM vector_chunks WHERE source = ? AND org_id = ?",
                (source, org_id),
            )
            ids = [int(r["id"]) for r in rows]
            return db.get_vector_chunks_by_ids(ids)
        return []


def _l2_normalise(arr) -> None:
    import numpy as np

    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    arr /= norms
