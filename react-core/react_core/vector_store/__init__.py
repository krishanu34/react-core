"""Vector store — semantic knowledge base for ingested content.

Design principles
-----------------
1. **Interface first**: callers depend on `VectorStoreProtocol` only. Backend
   swap (FAISS → pgvector → Pinecone) is one factory line.
2. **Metadata isolation**: every doc carries `{org_id, project_id,
   collection_id, ...}`. Search filters happen at the store layer.
3. **Fingerprint caching**: `IndexedSource` tracks source SHA-256; unchanged
   sources are skipped by the ingestion pipeline (not re-embedded).
4. **Singleton**: `get_vector_store()` returns a process-wide instance.
"""
from .base import VectorStoreProtocol
from .chunker import chunk_text
from .factory import get_vector_store, reset_vector_store_for_tests
from .models import VectorDoc, VectorHit

__all__ = [
    "VectorStoreProtocol",
    "VectorDoc",
    "VectorHit",
    "chunk_text",
    "get_vector_store",
    "reset_vector_store_for_tests",
]
