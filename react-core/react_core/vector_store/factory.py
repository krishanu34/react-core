"""VectorStore singleton getter — swap via `VECTOR_STORE_PROVIDER`."""
from __future__ import annotations

import os
import threading
from pathlib import Path

from ..app_db import get_app_db
from ..embeddings.factory import create_embeddings
from .base import VectorStoreProtocol

_LOCK = threading.Lock()
_INSTANCE: VectorStoreProtocol | None = None


def get_vector_store() -> VectorStoreProtocol:
    """Return the process-wide vector store singleton, creating it if needed."""
    global _INSTANCE
    if _INSTANCE is not None:
        return _INSTANCE
    with _LOCK:
        if _INSTANCE is not None:
            return _INSTANCE
        _INSTANCE = _create_vector_store()
        return _INSTANCE


def reset_vector_store_for_tests(new_instance: VectorStoreProtocol | None = None) -> None:
    """Test-only reset (do not call in production)."""
    global _INSTANCE
    with _LOCK:
        if _INSTANCE is not None and new_instance is None:
            try:
                _INSTANCE.close()
            except Exception:  # noqa: BLE001
                pass
        _INSTANCE = new_instance


def _create_vector_store() -> VectorStoreProtocol:
    provider = (os.getenv("VECTOR_STORE_PROVIDER") or "faiss").strip().lower()
    if provider == "faiss":
        from .faiss_backend import FaissVectorStore
        state_dir = Path(os.getenv("REACT_CORE_STATE_DIR", "./.react-core")).resolve()
        index_dir = state_dir / "vectors"
        return FaissVectorStore(
            index_dir=index_dir,
            embeddings=create_embeddings(),
            app_db=get_app_db(),
        )
    if provider == "pgvector":  # future
        raise NotImplementedError("pgvector backend not implemented yet.")
    raise ValueError(f"Unknown VECTOR_STORE_PROVIDER: {provider!r}")
