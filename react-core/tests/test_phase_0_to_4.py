"""Smoke tests for phases 0-4 additions.

Kept deliberately narrow: only tests that do NOT need a live LLM / embedding
provider. FAISS + embeddings-driven code is exercised via a stub embedding
client below.
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import pytest


# ------------------------------------------------------------------ AppDB ---

def _fresh_state_dir(tmp_path):
    os.environ["REACT_CORE_STATE_DIR"] = str(tmp_path)
    from react_core.app_db import reset_app_db_for_tests
    reset_app_db_for_tests(None)


def test_app_db_singleton_and_seed(tmp_path):
    _fresh_state_dir(tmp_path)
    from react_core.app_db import get_app_db

    db1 = get_app_db()
    db2 = get_app_db()
    assert db1 is db2, "get_app_db must return a process-wide singleton"

    org = db1.get_default_org()
    user = db1.get_default_user()
    assert org.id == "org-default"
    assert user.id == "admin"
    assert user.org_id == org.id
    assert db1.ping() is True


def test_app_db_crud_roundtrip(tmp_path):
    _fresh_state_dir(tmp_path)
    from react_core.app_db import (
        Attachment,
        Credential,
        IndexedSource,
        Message,
        Thread,
        VectorChunk,
        get_app_db,
    )
    db = get_app_db()

    # Thread + message
    t = db.upsert_thread(Thread(
        id="t-1", org_id="org-default", user_id="admin",
        project_id=None, workspace_path="/tmp", title="hello",
        created_at="", updated_at="",
    ))
    assert t.id == "t-1"
    db.add_message(Message(id="", thread_id="t-1", role="user", content="hi", created_at=""))
    msgs = db.get_messages("t-1")
    assert len(msgs) == 1

    # Credential upsert + read
    c = db.upsert_credential(Credential(
        id="", user_id="admin", team_id=None, provider="jira",
        base_url="https://acme.atlassian.net", token="tok", refresh_token=None,
        expires_at=None, auth_type="basic", email="me@acme.com",
        created_at="", updated_at="",
    ))
    got = db.get_credential("admin", "jira")
    assert got is not None
    assert got.token == "tok"
    assert got.auth_type == "basic"

    # Attachment fingerprint dedup
    a1 = db.upsert_attachment(Attachment(
        id="", org_id="org-default", thread_id="t-1",
        filename="a.pdf", mime="application/pdf", size=10, path="/tmp/a.pdf",
        pages=None, indexed=False, fingerprint="abc", created_at="",
    ))
    a2 = db.upsert_attachment(Attachment(
        id="", org_id="org-default", thread_id="t-1",
        filename="a-copy.pdf", mime="application/pdf", size=10, path="/tmp/a2.pdf",
        pages=None, indexed=False, fingerprint="abc", created_at="",
    ))
    assert a1.id == a2.id, "same fingerprint under same org → same row"

    # Vector chunk + indexed source
    ids = db.add_vector_chunks([VectorChunk(
        id=0, source="attachment:x", org_id="org-default",
        project_id=None, collection_id=None, page=1, chunk_index=0,
        text="hello world", metadata={"k": "v"},
    )])
    assert len(ids) == 1
    rows = db.get_vector_chunks_by_ids(ids)
    assert rows[0].metadata == {"k": "v"}
    db.upsert_indexed_source(IndexedSource(
        source="attachment:x", org_id="org-default",
        project_id=None, collection_id=None, fingerprint="abc",
        chunk_count=1, indexed_at="",
    ))
    assert db.get_indexed_source("attachment:x", "org-default") is not None


# ---------------------------------------------------------------- chunker ---

def test_chunker_paragraph_and_overlap(tmp_path):
    from react_core.vector_store import chunk_text
    text = ("Para one.\n\nPara two is a bit longer than para one, "
            "with several sentences. Second sentence.\n\n"
            "Para three.\n\nPara four.")
    chunks = chunk_text(text, max_chars=60, overlap=10)
    assert len(chunks) >= 2
    for c in chunks:
        # Each chunk should not blow past max_chars + overlap.
        assert len(c) <= 60 + 20


# ------------------------------------------------------------ extractors ---

def test_extractor_txt(tmp_path):
    from react_core.attachments.extractors import extract
    f = tmp_path / "note.txt"
    f.write_text("hello world\nline 2", encoding="utf-8")
    doc = extract(f)
    assert "hello world" in doc.text
    assert doc.mime == "text/plain"


def test_extractor_html_strips_tags(tmp_path):
    from react_core.attachments.extractors import extract
    f = tmp_path / "page.html"
    f.write_text(
        "<html><body><script>bad()</script><p>hello</p><p>world</p></body></html>",
        encoding="utf-8",
    )
    doc = extract(f)
    assert "bad()" not in doc.text
    assert "hello" in doc.text
    assert "world" in doc.text


def test_extractor_rejects_unknown(tmp_path):
    from react_core.attachments.extractors import extract
    f = tmp_path / "mystery.xyz"
    f.write_bytes(b"\x00\x01\x02")
    with pytest.raises(ValueError):
        extract(f)


# --------------------------------------------------------------- SSRF -----

@pytest.mark.parametrize("url", [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
])
def test_web_fetch_blocks_private_ips(url):
    from react_core.connectors.web import WebFetchError, web_fetch

    with pytest.raises(WebFetchError):
        asyncio.run(web_fetch(url))


def test_web_fetch_rejects_bad_scheme():
    from react_core.connectors.web import WebFetchError, web_fetch

    with pytest.raises(WebFetchError):
        asyncio.run(web_fetch("file:///etc/passwd"))


# -------------------------------------------------- Jira flavor detection ---

def test_jira_flavor_cloud_vs_server():
    from react_core.connectors.auth import AuthCredential
    from react_core.connectors.jira import Jira

    cloud = Jira(AuthCredential(base_url="https://acme.atlassian.net", token="x", auth_type="pat"))
    server = Jira(AuthCredential(base_url="https://jira.acme.internal", token="x", auth_type="pat"))
    assert cloud.flavor == "cloud"
    assert server.flavor == "server"


# ------------------------------------------------ Vector store (FAISS) ----

class _FakeEmbeddings:
    """Deterministic 8-dim embedding based on char frequencies — LLM-free."""
    model_name = "fake-8d"

    async def embed(self, texts):
        vecs = []
        for t in texts:
            v = [0.0] * 8
            for c in t.lower():
                v[ord(c) % 8] += 1.0
            vecs.append(v)
        return vecs


def test_faiss_upsert_search_delete(tmp_path):
    _fresh_state_dir(tmp_path)
    from react_core.app_db import get_app_db
    from react_core.vector_store.faiss_backend import FaissVectorStore
    from react_core.vector_store.models import VectorDoc

    db = get_app_db()
    store = FaissVectorStore(
        index_dir=tmp_path / "vec",
        embeddings=_FakeEmbeddings(),
        app_db=db,
    )
    docs = [
        VectorDoc(text="cats are furry animals", org_id="org-default", source="s1", chunk_index=0),
        VectorDoc(text="dogs are loyal companions", org_id="org-default", source="s2", chunk_index=0),
        VectorDoc(text="python is a programming language", org_id="org-other", source="s3", chunk_index=0),
    ]
    ids = asyncio.run(store.upsert(docs))
    assert len(ids) == 3

    hits = asyncio.run(store.search("dog loyalty", k=5, org_id="org-default"))
    assert any(h.source == "s2" for h in hits)
    # Metadata isolation: s3 belongs to another org and must be filtered out.
    assert all(h.org_id == "org-default" for h in hits)

    removed = asyncio.run(store.delete_source("s2", "org-default"))
    assert removed == 1
