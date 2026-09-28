"""FastAPI entrypoint.

Endpoints
---------
GET  /health                                  — liveness probe
POST /api/agent/stream                        — start/continue a ReAct run (multipart form, SSE response)
POST /api/agent/stop                          — cancel an in-flight run for a thread
POST /api/agent/answer                        — deliver an `ask_user` answer back to the agent
GET  /api/agent/history/{thread_id}           — full message history for a thread
GET  /api/agent/artifacts/{thread_id}/{path}  — download a generated file (raw)
GET  /api/agent/files/{thread_id}             — flat file tree of the thread's workspace
GET  /api/agent/files/{thread_id}/content     — read one file (UTF-8) for the web IDE
PUT  /api/agent/files/{thread_id}/content     — save an edit (schema-validated)
"""
from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

load_dotenv()

from ..agent.events import sse_event
from ..agent.react_agent import ReActAgent
from ..app_db import get_app_db
from ..attachments import AttachmentIn, save_upload
from ..attachments.ingest import ingest_attachment
from ..debug_recorder import DebugRecorder
from ..llm.factory import create_llm
from ..memory.conversation import ConversationMemory
from ..memory.long_term import LongTermMemory
from ..memory.stop_registry import stop_registry
from ..memory.summarizer import ConversationSummarizer
from ..memory.thread_memory import ThreadMemory
from ..permissions.path_guard import PathEscape, resolve_in_root
from ..tools.ask_user import ask_user_broker
from ..tools.registry import ToolRegistry
from ..utils.logger import get_logger, setup_logging
from .config import settings

setup_logging()
log = get_logger(__name__)

app = FastAPI(title="react-core", version="0.1.0")

# Permissive CORS by default; tighten via REACT_CORE_ALLOWED_ORIGINS (comma list).
_allowed = os.getenv("REACT_CORE_ALLOWED_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _allowed == "*" else [o.strip() for o in _allowed.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


memory = ConversationMemory(state_dir=settings.state_dir)
# App DB — singleton. Instantiate eagerly so we fail fast on startup rather
# than mid-request if the SQLite file can't be opened.
_app_db = get_app_db()
_ = _app_db.get_default_org()
_ = _app_db.get_default_user()
# One summarizer per process — its cache is keyed on thread_id so cross-thread
# invalidation is impossible and the LLM cost is at most one call per user turn.
_summarizer: ConversationSummarizer | None = None


def _get_summarizer() -> ConversationSummarizer | None:
    global _summarizer
    if _summarizer is not None:
        return _summarizer
    try:
        _summarizer = ConversationSummarizer(create_llm())
    except Exception as e:  # noqa: BLE001 — summariser is optional
        log.warning("summarizer disabled: %s", e)
        _summarizer = None
    return _summarizer


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": "0.1.0"}


@app.post("/api/agent/stream")
async def agent_stream(
    message: str = Form(..., description="The user instruction."),
    thread_id: Optional[str] = Form(default=None),
    workspace_path: Optional[str] = Form(default=None),
    max_steps: Optional[int] = Form(default=None),
    files: list[UploadFile] = File(default=[]),
):
    tid = thread_id or uuid.uuid4().hex

    # Resolve workspace: if omitted, auto-create a per-thread scratch dir
    # under state_dir. Required for the agent's file tools; the client
    # never has to know about it.
    user_supplied = bool(workspace_path)
    ws = workspace_path or memory.get_workspace(tid) or str(
        settings.state_dir / "threads" / tid / "workspace"
    )
    ws_abs = str(Path(ws).expanduser().resolve())
    if not Path(ws_abs).is_dir():
        if user_supplied:
            raise HTTPException(
                status_code=422,
                detail=f"workspace_path does not exist or is not a directory: {ws_abs}",
            )
        # Server-owned scratch dir — (re)create if the previous run's folder was cleaned up.
        Path(ws_abs).mkdir(parents=True, exist_ok=True)
    memory.set_workspace(tid, ws_abs)

    # ---- Phase 1: real attachment ingestion ---------------------------------
    ingested_meta: list[dict] = []
    if files:
        org = _app_db.get_default_org()
        for f in files:
            try:
                data = await f.read()
                if not data:
                    continue
                if len(data) > int(_max_attachment_mb() * 1024 * 1024):
                    log.warning("thread=%s attachment %s exceeds %.0f MB cap — skipped",
                                tid, f.filename, _max_attachment_mb())
                    continue
                att = save_upload(
                    org_id=org.id,
                    thread_id=tid,
                    upload=AttachmentIn(
                        filename=f.filename or "attachment",
                        content_type=f.content_type,
                        data=data,
                    ),
                    state_dir=settings.state_dir,
                )
                chunks = 0
                try:
                    chunks = await ingest_attachment(att, org_id=org.id)
                except Exception as e:  # noqa: BLE001
                    log.warning("thread=%s attachment %s indexing failed: %s",
                                tid, att.filename, e)
                ingested_meta.append({
                    "id": att.id,
                    "name": att.filename,
                    "size": att.size,
                    "pages": att.pages,
                    "indexed": chunks > 0 or att.indexed,
                })
            except Exception as e:  # noqa: BLE001
                log.error("thread=%s upload %s failed: %s", tid, f.filename, e)

    try:
        llm = create_llm()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"LLM not configured: {e}") from e

    long_term = LongTermMemory(state_dir=settings.state_dir, thread_id=tid)
    org = _app_db.get_default_org()
    user = _app_db.get_default_user()
    registry = ToolRegistry.build_for_workspace(
        ws_abs, thread_id=tid, long_term=long_term,
        org_id=org.id, user_id=user.id,
    )
    thread_memory = ThreadMemory(
        thread_id=tid,
        conversation=memory,
        long_term=long_term,
        summarizer=_get_summarizer(),
    )
    agent = ReActAgent(
        llm=llm,
        tool_registry=registry,
        memory=thread_memory,
        thread_id=tid,
        max_steps=max_steps or settings.max_steps,
        temperature=settings.temperature,
    )

    queue: asyncio.Queue = asyncio.Queue()
    done = asyncio.Event()

    recorder = DebugRecorder(settings.state_dir, tid)
    recorder.record("user_turn", {
        "message": message,
        "attachments": ingested_meta,
        "workspace_path": ws_abs,
    })

    async def on_event(event_type: str, data: dict) -> None:
        try:
            recorder.record(event_type, dict(data or {}))
        except Exception as e:  # noqa: BLE001 — debug must never break the loop
            log.warning("debug recorder failed on %s: %s", event_type, e)
        await queue.put((event_type, data))

    async def _drive() -> None:
        try:
            await queue.put(("thread_id", {"thread_id": tid}))
            if ingested_meta:
                await queue.put(("attachments", {"files": ingested_meta}))
                recorder.record("attachments", {"files": ingested_meta})
            await agent.run(message, on_event=on_event)
        finally:
            done.set()
            await queue.put(None)

    driver_task = asyncio.create_task(_drive())

    async def event_source():
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                event_type, data = item
                yield sse_event(event_type, data)
            yield sse_event("done", {})
        finally:
            if not driver_task.done():
                driver_task.cancel()
                try:
                    await driver_task
                except (asyncio.CancelledError, Exception):
                    pass
            ask_user_broker.cancel_thread(tid)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class StopRequest(BaseModel):
    thread_id: str


@app.post("/api/agent/stop")
def agent_stop(req: StopRequest) -> dict:
    stop_registry.request_stop(req.thread_id)
    ask_user_broker.cancel_thread(req.thread_id)
    try:
        DebugRecorder(settings.state_dir, req.thread_id).record(
            "stop_requested", {}
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "thread_id": req.thread_id, "stopping": True}


class AnswerRequest(BaseModel):
    thread_id: str
    call_id: str = Field(description="The call_id from the matching `user_question` event.")
    answer: str


@app.post("/api/agent/answer")
def agent_answer(req: AnswerRequest) -> dict:
    ok = ask_user_broker.resolve(req.thread_id, req.call_id, req.answer)
    if not ok:
        raise HTTPException(status_code=404, detail="No pending question for that thread_id/call_id.")
    try:
        DebugRecorder(settings.state_dir, req.thread_id).record(
            "user_answer",
            {"call_id": req.call_id, "answer": req.answer},
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


@app.get("/api/agent/debug/{thread_id}")
def agent_debug(thread_id: str) -> JSONResponse:
    """Return the raw per-thread debug JSON (all events, oldest first)."""
    snap = DebugRecorder(settings.state_dir, thread_id).read_snapshot()
    if snap is None:
        raise HTTPException(status_code=404, detail="No debug log for this thread (or recording disabled).")
    return JSONResponse(snap)


@app.get("/api/agent/history/{thread_id}")
def agent_history(thread_id: str) -> JSONResponse:
    if not memory.exists(thread_id):
        raise HTTPException(status_code=404, detail="Thread not found.")
    return JSONResponse({
        "thread_id": thread_id,
        "workspace_path": memory.get_workspace(thread_id),
        "messages": memory.get_messages(thread_id),
    })


@app.get("/api/agent/attachments/{thread_id}")
def agent_attachments(thread_id: str) -> JSONResponse:
    """List attachments visible in this org (attachments are org-owned)."""
    org = _app_db.get_default_org()
    atts = _app_db.list_attachments(org.id)
    return JSONResponse({
        "thread_id": thread_id,
        "attachments": [
            {
                "id": a.id,
                "name": a.filename,
                "size": a.size,
                "pages": a.pages,
                "indexed": a.indexed,
                "created_at": a.created_at,
            }
            for a in atts
        ],
    })


@app.get("/api/agent/artifacts/{thread_id}/{relpath:path}")
def agent_artifact_download(thread_id: str, relpath: str) -> FileResponse:
    """Download a generated file from the thread's workspace, sandboxed."""
    ws = memory.get_workspace(thread_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Thread has no workspace.")
    try:
        target = resolve_in_root(ws, relpath)
    except PathEscape:
        raise HTTPException(status_code=400, detail="Path escape rejected.")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"Not found: {relpath}")
    return FileResponse(str(target), filename=target.name)


# ============================================================================
#  Web IDE — file tree, read, write with validation
#
#  The web front-end mounts a left-hand explorer showing every file the agent
#  has produced under the thread's workspace. Files can be opened in a Monaco
#  editor and saved back; server-side validation refuses to persist a
#  malformed `.json` (against the sidecar schema) or `.feature` file so a
#  human edit can't silently break the artefact set.
# ============================================================================

_IDE_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", ".mypy_cache"}
_IDE_MAX_FILES = 2000
_IDE_MAX_BYTES = 2 * 1024 * 1024


def _kind_for_ext(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".feature"):
        return "feature"
    if lower.endswith(".json"):
        return "json"
    if lower.endswith(".md"):
        return "markdown"
    if lower.endswith((".yml", ".yaml")):
        return "yaml"
    if lower.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".go", ".rb", ".rs")):
        return "code"
    return "text"


@app.get("/api/agent/files/{thread_id}")
def agent_files_list(thread_id: str) -> JSONResponse:
    """List every file under the thread's workspace as a flat tree.

    Returned in POSIX-relative form so the client can build any UI it wants.
    """
    ws = memory.get_workspace(thread_id)
    if not ws or not Path(ws).is_dir():
        return JSONResponse({"thread_id": thread_id, "files": []})

    root = Path(ws)
    out: list[dict] = []
    for path in _walk_workspace(root):
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        out.append({
            "path": rel,
            "name": path.name,
            "size": st.st_size,
            "modified": st.st_mtime,
            "kind": _kind_for_ext(path.name),
        })
        if len(out) >= _IDE_MAX_FILES:
            break
    out.sort(key=lambda f: f["path"])
    return JSONResponse({"thread_id": thread_id, "files": out})


def _walk_workspace(root: Path):
    stack = [root]
    while stack:
        cur = stack.pop()
        try:
            children = list(cur.iterdir())
        except OSError:
            continue
        for child in children:
            if child.is_dir():
                if child.name in _IDE_SKIP_DIRS or child.name.startswith("."):
                    continue
                stack.append(child)
            elif child.is_file():
                yield child


@app.get("/api/agent/files/{thread_id}/content")
def agent_file_read(thread_id: str, path: str) -> JSONResponse:
    """Return a file's UTF-8 content plus metadata for the editor."""
    ws = memory.get_workspace(thread_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Thread has no workspace.")
    try:
        target = resolve_in_root(ws, path)
    except PathEscape:
        raise HTTPException(status_code=400, detail="Path escape rejected.")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"Not found: {path}")
    try:
        st = target.stat()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"stat failed: {e}") from e
    if st.st_size > _IDE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large to edit ({st.st_size} bytes).")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="File is not UTF-8 text.")
    return JSONResponse({
        "path": path,
        "name": target.name,
        "size": st.st_size,
        "modified": st.st_mtime,
        "kind": _kind_for_ext(target.name),
        "content": content,
    })


class FileWriteRequest(BaseModel):
    path: str
    content: str


@app.put("/api/agent/files/{thread_id}/content")
def agent_file_write(thread_id: str, req: FileWriteRequest) -> JSONResponse:
    """Persist the user's edit after validating format-specific rules."""
    from ..artefacts.validators import validate  # local import — avoids circulars

    ws = memory.get_workspace(thread_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Thread has no workspace.")
    try:
        target = resolve_in_root(ws, req.path)
    except PathEscape:
        raise HTTPException(status_code=400, detail="Path escape rejected.")
    if len(req.content.encode("utf-8")) > _IDE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Content exceeds the size cap.")

    issues = validate(req.path, req.content)
    if issues:
        return JSONResponse(
            status_code=422,
            content={
                "error": "validation_failed",
                "path": req.path,
                "issues": [i.to_dict() for i in issues],
            },
        )

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(req.content, encoding="utf-8")
        st = target.stat()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}") from e

    return JSONResponse({
        "path": req.path,
        "name": target.name,
        "size": st.st_size,
        "modified": st.st_mtime,
        "kind": _kind_for_ext(target.name),
    })


def _max_attachment_mb() -> float:
    try:
        return float(os.getenv("ATTACHMENT_MAX_FILE_MB", "20"))
    except ValueError:
        return 20.0


# ============================================================================
#  Settings — Jira / Confluence credentials
#
#  MVP: no auth on the app itself. Every write is attributed to the seeded
#  `admin` user. When we introduce login this endpoint just starts reading
#  the user_id from the session instead.
# ============================================================================

_ADMIN_USER_ID = "admin"
_SUPPORTED_PROVIDERS = {"jira", "confluence"}


def _detect_atlassian_auth_type(base_url: str, email: Optional[str]) -> str:
    """Cloud (email + API token) → basic; Server/DC (PAT only) → pat."""
    from ..connectors.jira import _looks_like_cloud
    if _looks_like_cloud(base_url) or email:
        return "basic"
    return "pat"


def _redact(token: str) -> str:
    if not token:
        return ""
    return f"••••{token[-4:]}" if len(token) > 4 else "••••"


class CredentialIn(BaseModel):
    provider: str = Field(description="jira | confluence")
    base_url: str = Field(description="e.g. https://acme.atlassian.net")
    token: str = Field(description="API token / PAT / password")
    email: Optional[str] = Field(default=None, description="Required for Atlassian Cloud (basic auth).")


class CredentialOut(BaseModel):
    id: str
    provider: str
    base_url: str
    email: Optional[str] = None
    auth_type: str
    token_masked: str
    updated_at: str


@app.get("/api/settings/credentials", response_model=list[CredentialOut])
def list_credentials() -> list[CredentialOut]:
    creds = _app_db.list_credentials(_ADMIN_USER_ID)
    return [
        CredentialOut(
            id=c.id,
            provider=c.provider,
            base_url=c.base_url,
            email=c.email,
            auth_type=c.auth_type,
            token_masked=_redact(c.token),
            updated_at=c.updated_at,
        )
        for c in creds
    ]


@app.put("/api/settings/credentials", response_model=CredentialOut)
def upsert_credential(payload: CredentialIn) -> CredentialOut:
    provider = payload.provider.strip().lower()
    if provider not in _SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unsupported provider: {provider}")
    if not payload.base_url or not payload.token:
        raise HTTPException(status_code=422, detail="base_url and token are required")
    from ..app_db import Credential
    auth_type = _detect_atlassian_auth_type(payload.base_url, payload.email)
    saved = _app_db.upsert_credential(Credential(
        id="", user_id=_ADMIN_USER_ID, team_id=None,
        provider=provider,
        base_url=payload.base_url.rstrip("/"),
        token=payload.token,
        refresh_token=None,
        expires_at=None,
        auth_type=auth_type,
        email=(payload.email or None),
        created_at="", updated_at="",
    ))
    log.info("credential upserted: provider=%s base_url=%s", provider, saved.base_url)
    return CredentialOut(
        id=saved.id,
        provider=saved.provider,
        base_url=saved.base_url,
        email=saved.email,
        auth_type=saved.auth_type,
        token_masked=_redact(saved.token),
        updated_at=saved.updated_at,
    )


@app.delete("/api/settings/credentials/{provider}")
def delete_credential(provider: str) -> dict:
    provider = provider.strip().lower()
    if provider not in _SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unsupported provider: {provider}")
    cred = _app_db.get_credential(_ADMIN_USER_ID, provider)
    if cred is None:
        raise HTTPException(status_code=404, detail=f"no {provider} credential to delete")
    _app_db.delete_credential(cred.id)
    return {"ok": True, "provider": provider}
