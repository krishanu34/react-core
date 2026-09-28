"""
Chat Streaming API

This is the actual HTTP layer of the project. It exposes one main
endpoint, POST /chat/stream, which:

  1. Looks up (or creates) the conversation history for this chat
  2. Adds the user's new message to that history
  3. Sends the FULL history (not just the new message) to the LLM,
     so the model has context of everything said so far
  4. Streams the LLM's response back to the client token-by-token
     as Server-Sent Events (SSE), so the UI can show text appearing
     live instead of waiting for the whole answer
  5. Once the LLM is done, records token usage and saves the
     complete assistant reply into conversation history, so the
     NEXT message in this conversation has it as context too

Why SSE (text/event-stream) instead of returning the whole answer
at once?
Because for anything but the shortest replies, returning all the
text in one HTTP response means the user stares at a blank screen
until the entire answer is ready. Streaming lets the UI render each
token as it arrives, which feels dramatically more responsive even
though the total time to finish is the same.
"""

import json
import sys
from pathlib import Path

DEVSPHERE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = DEVSPHERE_DIR.parent
for candidate in (REPO_ROOT, DEVSPHERE_DIR):
    text = str(candidate)
    if text not in sys.path:
        sys.path.insert(0, text)

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from llm.factory import LLMFactory
from persistence.postgres_agent import PostgresConversationHistory, PostgresTokenTrackerStore
from router.admin import admin_router
from router.agent_stream import agent_router
from workspace_studio.app import register_workspace_studio

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router)
app.include_router(admin_router)
register_workspace_studio(app)

# These are created once when the server starts and persist through PostgreSQL.
llm = None
conversation_history = PostgresConversationHistory()
token_tracker = PostgresTokenTrackerStore().get("__chat__")


def get_llm():
    """The model for /chat/stream, which has no per-user model selection.

    Shares `router.agent_stream._get_llm`'s resolution so this endpoint doesn't
    become the one place that still hard-requires the Azure block in `.env`
    after models moved into the database.
    """
    global llm
    if llm is None:
        from router.agent_stream import _get_llm

        llm = _get_llm()
    return llm


class ChatRequest(BaseModel):
    """
    Shape of the JSON body the client sends to POST /chat/stream.

    message:         the user's new chat message
    conversation_id: optional. If omitted, a brand new conversation
                      is started and its id is sent back to the
                      client in the very first SSE event, so the
                      client can reuse it on their NEXT message.
    """
    message: str
    conversation_id: str | None = None


def _sse_event(event_type: str, data: dict) -> str:
    """
    Formats one Server-Sent Event. SSE's wire format is just:

        data: <json>\n\n

    The blank line at the end is REQUIRED by the SSE spec - it's how
    the client knows one event has ended. We always send a JSON
    object (rather than raw text) so the client can tell different
    kinds of events apart (a content token vs. a usage report vs.
    an error) by checking data["type"].
    """
    payload = json.dumps({"type": event_type, **data})
    return f"data: {payload}\n\n"


@app.get("/")
async def hello():
    return {"message": "Hello, World!"}


@app.post("/chat/stream")
async def chat_stream(request: Request, chat_request: ChatRequest):
    """
    Main streaming chat endpoint.

    The client gets back a stream of SSE events shaped like:

        data: {"type": "conversation_id", "conversation_id": "..."}

        data: {"type": "content", "delta": "Hello"}

        data: {"type": "content", "delta": " there"}

        ...

        data: {"type": "usage", "usage": {"prompt_tokens": 12, ...}}

        data: {"type": "done"}

    The client should concatenate every "content" delta in order to
    build up the full reply text as it streams in.
    """
    conversation_id = chat_request.conversation_id
    if not conversation_id:
        conversation_id = conversation_history.create_conversation()

    # Add the user's new message to history BEFORE calling the LLM,
    # so the LLM call below sends the complete conversation including
    # this latest message.
    conversation_history.add_message(conversation_id, "user", chat_request.message)
    messages = conversation_history.get_messages(conversation_id)
    active_llm = get_llm()

    async def event_generator():
        # Tell the client which conversation_id this is FIRST, before
        # any content, so even if they didn't supply one, they can
        # start using it for their next message right away.
        yield _sse_event("conversation_id", {"conversation_id": conversation_id})

        full_reply_parts = []

        try:
            async for kind, value in active_llm.stream(messages):
                if kind == "content":
                    full_reply_parts.append(value)
                    yield _sse_event("content", {"delta": value})

                elif kind == "usage":
                    # This is the final chunk Azure sends because we
                    # set stream_options.include_usage = True in
                    # AzureOpenAI.stream(). It always arrives AFTER
                    # all the content chunks, never before.
                    recorded = token_tracker.record_usage(
                        value, model=active_llm.deployment
                    )
                    yield _sse_event("usage", {"usage": recorded.to_dict()})

        except Exception as e:
            # If the LLM call fails partway through streaming, tell
            # the client explicitly rather than just cutting the
            # connection, so the UI can show a real error message
            # instead of a silently truncated reply.
            yield _sse_event("error", {"message": str(e)})
            return

        # Now that streaming is fully done, save the complete
        # assistant reply into history. We do this AFTER streaming
        # (not chunk-by-chunk) because we want history to contain
        # one clean, complete message - not dozens of tiny partial
        # fragments.
        full_reply = "".join(full_reply_parts)
        conversation_history.add_message(conversation_id, "assistant", full_reply)

        yield _sse_event("done", {})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            # Disables buffering on some proxies (e.g. nginx) that
            # would otherwise hold back chunks until the response is
            # complete, defeating the whole purpose of streaming.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


@app.get("/chat/history/{conversation_id}")
async def get_history(conversation_id: str):
    """
    Plain (non-streaming) endpoint to fetch a conversation's full
    message history. Useful for a UI to reload a chat on page
    refresh, or just for debugging what's currently stored.
    """
    messages = conversation_history.get_messages(conversation_id)
    if not messages:
        raise HTTPException(status_code=404, detail="Conversation not found or empty")
    return {"conversation_id": conversation_id, "messages": messages}


@app.get("/usage/total")
async def get_usage_total():
    """
    Plain endpoint to see total token usage across every request
    this server process has handled since it started. Useful for a
    simple "tokens used today" display, or just sanity-checking that
    tracking is actually working while you develop.
    """
    return token_tracker.get_total()


@app.get("/usage/history")
async def get_usage_history():
    """
    Returns every individual recorded usage entry (one per LLM call),
    not just the summed total - useful if you want to see usage
    per-request rather than only the running total.
    """
    return {"history": token_tracker.get_history()}
