"""ask_user — pause the run to ask the user a question over SSE.

Emits a `user_question` event, then blocks on a per-thread future until the
client POSTs the answer to `/api/agent/answer`. The event carries a `call_id`
the client must echo back.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any, Awaitable, Callable

from .base import BaseTool

ASK_USER_TIMEOUT = int(os.getenv("REACT_CORE_ASK_USER_TIMEOUT", "600"))


class AskUserBroker:
    def __init__(self):
        self._futures: dict[tuple[str, str], asyncio.Future] = {}

    def create(self, thread_id: str, call_id: str) -> asyncio.Future:
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._futures[(thread_id, call_id)] = fut
        return fut

    def resolve(self, thread_id: str, call_id: str, answer: str) -> bool:
        fut = self._futures.pop((thread_id, call_id), None)
        if fut is None or fut.done():
            return False
        fut.set_result(answer)
        return True

    def cancel_thread(self, thread_id: str) -> None:
        for key in [k for k in self._futures if k[0] == thread_id]:
            fut = self._futures.pop(key, None)
            if fut is not None and not fut.done():
                fut.set_result({"error": "run cancelled"})


ask_user_broker = AskUserBroker()


class AskUserTool(BaseTool):
    name = "ask_user"
    SUPPORTS_STREAMING = True
    description = (
        "Ask the user a clarifying question when the request is ambiguous. "
        "Prefer this over guessing. Blocks until the user answers via the "
        "/api/agent/answer endpoint. Include a clear question and, if useful, "
        "suggested options as an array of strings."
    )

    def __init__(self, workspace: str, thread_id: str | None = None):
        super().__init__(workspace)
        self.thread_id = thread_id or ""

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question to show the user."},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional suggested answers.",
                },
            },
            "required": ["question"],
        }

    async def run(
        self,
        question: str,
        options: list[str] | None = None,
        on_event: Callable[[str, dict], Awaitable[None] | None] | None = None,
    ) -> dict[str, Any]:
        if not self.thread_id:
            return {"error": "ask_user requires a bound thread_id."}
        if on_event is None:
            return {"error": "no live client channel — cannot ask the user."}
        call_id = uuid.uuid4().hex
        fut = ask_user_broker.create(self.thread_id, call_id)
        payload = {"call_id": call_id, "question": question}
        if options:
            payload["options"] = list(options)[:12]
        result = on_event("user_question", payload)
        if hasattr(result, "__await__"):
            await result

        try:
            answer = await asyncio.wait_for(fut, timeout=ASK_USER_TIMEOUT)
        except asyncio.TimeoutError:
            ask_user_broker._futures.pop((self.thread_id, call_id), None)
            return {"error": f"User did not answer within {ASK_USER_TIMEOUT}s."}
        return {"answer": answer, "question": question}
