import asyncio
import json
import os
import time

import httpx

from .base import BaseLLM, ToolCall, ToolUseResponse
from .model_capabilities import adapt_from_error, capabilities_for
from utils.logger import get_logger

log = get_logger(__name__)

# ── Resilience config (Claude Code-style) ────────────────────────────────
# Connect fails fast (is Azure reachable?); read is generous because a big
# generation turn legitimately takes minutes — the old blanket timeout=120.0
# killed "generate the whole project" turns with ReadTimeout: (empty).
LLM_CONNECT_TIMEOUT = float(os.getenv("LLM_CONNECT_TIMEOUT", "10"))
LLM_READ_TIMEOUT = float(os.getenv("LLM_READ_TIMEOUT", "300"))
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "3"))

# Output-token budget note: the old 4096 default truncated large file_write /
# code-gen turns — Azure set finish_reason="length" and CUT the tool-call
# arguments JSON mid-string, which failed to parse and produced empty / blank
# files. The per-turn ceiling now comes from the MODEL's capabilities
# (model_capabilities.max_output_tokens, .env-overridable via
# LLM_MAX_OUTPUT_TOKENS) so it scales with the deployment (gpt-5.6-sol: 128000)
# instead of a hardcoded number. The agent still detects finish_reason="length"
# and regenerates with a larger budget as a safety net.

# Transient statuses worth retrying: rate limit + server-side hiccups.
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=LLM_CONNECT_TIMEOUT,
        read=LLM_READ_TIMEOUT,
        write=60.0,
        pool=30.0,
    )


def _retry_delay(attempt: int, response=None) -> float:
    """Exponential backoff (1s, 2s, 4s… capped 30s), honouring Retry-After
    when Azure sends one on a 429 — the server knows its own queue best."""
    if response is not None:
        retry_after = response.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after), 60.0)
            except ValueError:
                pass
    return min(2.0 ** attempt, 30.0)


def _cached_tokens(usage: dict) -> int:
    """Azure reports prompt-cache hits in prompt_tokens_details.cached_tokens
    (automatic for gpt-4o/gpt-4.1/o-series when prompts >1024 tokens share a
    stable prefix — no request parameter needed; other models report 0)."""
    details = usage.get("prompt_tokens_details") or {}
    return int(details.get("cached_tokens", 0) or 0)


class AzureOpenAI(BaseLLM):
    """
    Talks to an Azure OpenAI chat completions deployment over plain
    HTTP using httpx - no SDK, just direct API calls, matching how
    this project does everything else.
    """

    def __init__(
        self,
        endpoint,
        api_key,
        deployment,
        api_version,
        caps=None,
    ):
        self.endpoint = endpoint
        self.api_key = api_key
        self.deployment = deployment
        self.api_version = api_version
        # Per-model request-parameter capabilities (gpt-5/o-series reject
        # `temperature` and want `max_completion_tokens`). Name-based guess
        # here; adapt_from_error() corrects it at runtime if Azure disagrees.
        # `caps` is passed when the values came from a model_configs row, where
        # an admin stated them explicitly — see llm/model_capabilities.py.
        self.caps = caps or capabilities_for(deployment)
        if not self.caps.supports_temperature or self.caps.tokens_param != "max_tokens":
            log.info(
                f"Model capabilities '{deployment}': "
                f"temperature={'yes' if self.caps.supports_temperature else 'no'}, "
                f"tokens_param={self.caps.tokens_param}"
            )

    def _body(self, messages, temperature, max_tokens) -> dict:
        """The ONE place capability-sensitive request params are applied.
        Models that reject `temperature` get none (their default of 1 is the
        only accepted value); the token-limit key follows the model family."""
        body = {"messages": messages}
        if self.caps.supports_temperature:
            body["temperature"] = temperature
        body[self.caps.tokens_param] = max_tokens
        return body

    def _url(self):
        return (
            f"{self.endpoint}/openai/deployments/{self.deployment}"
            f"/chat/completions?api-version={self.api_version}"
        )

    def _headers(self):
        return {
            "api-key": self.api_key,
            "Content-Type": "application/json",
        }

    async def _post_with_retries(self, body: dict, op: str) -> httpx.Response:
        """
        Non-streaming POST with retry + backoff (Claude Code behaviour).

        Retries timeouts/connection errors and 429/5xx statuses up to
        LLM_MAX_RETRIES times, honouring Retry-After. Non-retryable statuses
        (400, 401, content filter…) return immediately for the caller's
        normal error handling.
        """
        last_exc: Exception | None = None
        for attempt in range(LLM_MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=_timeout()) as client:
                    response = await client.post(
                        self._url(), headers=self._headers(), json=body,
                    )
            except (httpx.TimeoutException, httpx.ConnectError) as e:
                last_exc = e
                if attempt < LLM_MAX_RETRIES:
                    delay = _retry_delay(attempt)
                    log.warning(
                        f"LLM {op} {type(e).__name__} — retrying in {delay:.0f}s "
                        f"(attempt {attempt + 1}/{LLM_MAX_RETRIES})"
                    )
                    await asyncio.sleep(delay)
                    continue
                raise RuntimeError(
                    f"LLM {op} failed after {LLM_MAX_RETRIES + 1} attempts: "
                    f"{type(e).__name__} (read timeout {LLM_READ_TIMEOUT:.0f}s each — "
                    f"likely Azure rate-limit queueing; check the deployment's TPM quota)"
                ) from e

            if response.status_code in _RETRYABLE_STATUS and attempt < LLM_MAX_RETRIES:
                delay = _retry_delay(attempt, response)
                log.warning(
                    f"LLM {op} [{response.status_code}] — retrying in {delay:.0f}s "
                    f"(attempt {attempt + 1}/{LLM_MAX_RETRIES})"
                )
                await asyncio.sleep(delay)
                continue

            return response

        raise RuntimeError(f"LLM {op} failed: {last_exc}")  # pragma: no cover

    async def invoke(
        self,
        message,
        temperature=0.0,
        max_tokens=4096,
        response_format=None,
    ):
        """
        One-shot call: send the messages, wait for the full response,
        return (text, usage_dict).

        usage_dict looks like:
            {"prompt_tokens": int, "completion_tokens": int, "total_tokens": int}

        Azure ALWAYS includes "usage" on non-streaming chat completion
        responses, so we can return it straight from this one call -
        no extra request needed. This is what makes invoke() the easy
        case for token tracking compared to stream() below.

        response_format: optional OpenAI response_format dict. Pass a
        strict json_schema ({"type": "json_schema", ...}) to make the
        model's output guaranteed-valid JSON matching the schema —
        callers should still validate (pydantic) and be ready to retry
        without it if the deployment/api-version rejects the parameter.
        """
        def make_body():
            b = self._body(message, temperature, max_tokens)
            if response_format:
                b["response_format"] = response_format
            return b

        prompt_chars = sum(len(m.get("content", "")) for m in message)
        start = time.monotonic()

        log.debug(
            f"LLM invoke: deployment={self.deployment}, "
            f"prompt_chars={prompt_chars}, max_tokens={max_tokens}",
            extra={"model": self.deployment, "prompt_size_chars": prompt_chars},
        )

        response = await self._post_with_retries(make_body(), op="invoke")
        if response.status_code == 400 and adapt_from_error(self.caps, response.text):
            response = await self._post_with_retries(make_body(), op="invoke")

        latency_ms = round((time.monotonic() - start) * 1000)

        if response.status_code != 200:
            log.error(
                f"LLM invoke FAILED [{response.status_code}]: {response.text[:200]}",
                extra={"model": self.deployment, "duration_ms": latency_ms},
            )
            raise RuntimeError(
                f"Azure OpenAI call failed [{response.status_code}]: {response.text}"
            )

        data = response.json()

        # Azure occasionally returns HTTP 200 with an error body instead of choices
        if "error" in data:
            err = data["error"]
            raise RuntimeError(f"Azure OpenAI error: {err.get('message', str(err))}")

        choice = data["choices"][0]
        text = choice["message"]["content"]
        finish_reason = choice.get("finish_reason", "")

        # content_filter or other causes can yield null content with HTTP 200
        if text is None:
            if finish_reason == "content_filter":
                raise RuntimeError("Response blocked by Azure content filter")
            raise RuntimeError(f"Azure returned empty response (finish_reason={finish_reason!r})")

        usage = data.get("usage", {})

        cached = _cached_tokens(usage)
        log.info(
            f"LLM invoke OK: {usage.get('total_tokens', 0)} tokens, {latency_ms}ms"
            + (f", prompt-cache hit: {cached}" if cached else ""),
            extra={
                "model": self.deployment,
                "tokens": usage.get("total_tokens", 0),
                "duration_ms": latency_ms,
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "cached_tokens": cached,
            },
        )

        return text, usage

    async def stream(
        self,
        messages,
        temperature=0.0,
        max_tokens=4096,
    ):
        """
        Streams the response token-by-token as it's generated.

        IMPORTANT, READ THIS BEFORE CHANGING TOKEN TRACKING LOGIC:
        Azure (like OpenAI) does NOT include "usage" in every SSE
        chunk by default. To get usage at all during a streaming
        call, you must explicitly ask for it with:

            "stream_options": {"include_usage": true}

        When you do, the token counts arrive in ONE FINAL chunk,
        AFTER the last actual content chunk, where "choices" is an
        EMPTY LIST and "usage" is populated instead. If you forget
        this option, usage will silently be missing the whole time -
        not an error, just absent.

        This generator yields two kinds of items so the caller can
        tell them apart:
            ("content", "some text")              <- normal token chunk
            ("usage", {"prompt_tokens": ..., ...}) <- final usage chunk

        Whoever consumes this (the FastAPI route, in our case) checks
        the first element of the tuple to know what they got.
        """
        def make_body():
            b = self._body(messages, temperature, max_tokens)
            b["stream"] = True
            b["stream_options"] = {"include_usage": True}
            return b

        body = make_body()

        # Retry only while nothing has been yielded — see stream_with_tools.
        yielded_any = False
        for attempt in range(LLM_MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=_timeout()) as client:
                    async with client.stream(
                        "POST", self._url(), headers=self._headers(), json=body
                    ) as response:

                        if response.status_code != 200:
                            error_body = await response.aread()
                            if (
                                response.status_code == 400
                                and attempt < LLM_MAX_RETRIES
                                and adapt_from_error(self.caps, error_body.decode(errors="replace"))
                            ):
                                body = make_body()  # rebuilt with corrected params
                                continue
                            if response.status_code in _RETRYABLE_STATUS and attempt < LLM_MAX_RETRIES:
                                delay = _retry_delay(attempt, response)
                                log.warning(
                                    f"LLM stream [{response.status_code}] — retrying in "
                                    f"{delay:.0f}s (attempt {attempt + 1}/{LLM_MAX_RETRIES})"
                                )
                                await asyncio.sleep(delay)
                                continue
                            raise RuntimeError(
                                f"Azure OpenAI stream failed [{response.status_code}]: {error_body.decode()}"
                            )

                        async for line in response.aiter_lines():
                            if not line or not line.startswith("data:"):
                                continue

                            chunk = line.removeprefix("data:").strip()
                            if chunk == "[DONE]":
                                break

                            try:
                                parsed = json.loads(chunk)
                            except json.JSONDecodeError:
                                # Some proxies/corporate SSL inspection layers can
                                # mangle SSE framing. Skip a bad chunk instead of
                                # crashing the whole stream over one bad line.
                                continue

                            # The final usage-only chunk has an empty choices list.
                            # Everything else has at least one choice with a delta.
                            usage = parsed.get("usage")
                            if usage:
                                yielded_any = True
                                yield ("usage", usage)
                                continue

                            choices = parsed.get("choices") or []
                            if not choices:
                                continue

                            delta = choices[0].get("delta", {}).get("content")
                            if delta:
                                yielded_any = True
                                yield ("content", delta)

                return  # stream completed

            except (httpx.TimeoutException, httpx.ConnectError) as e:
                if yielded_any:
                    raise RuntimeError(
                        f"LLM stream dropped mid-response ({type(e).__name__}) — "
                        f"no data for {LLM_READ_TIMEOUT:.0f}s"
                    ) from e
                if attempt < LLM_MAX_RETRIES:
                    delay = _retry_delay(attempt)
                    log.warning(
                        f"LLM stream {type(e).__name__} — retrying in {delay:.0f}s "
                        f"(attempt {attempt + 1}/{LLM_MAX_RETRIES})"
                    )
                    await asyncio.sleep(delay)
                    continue
                raise RuntimeError(
                    f"LLM stream timed out after {LLM_MAX_RETRIES + 1} attempts "
                    f"(read timeout {LLM_READ_TIMEOUT:.0f}s each — likely Azure "
                    f"rate-limit queueing; check the deployment's TPM quota)"
                ) from e

    async def invoke_with_tools(
        self,
        messages,
        tools=None,
        temperature=0.0,
        max_tokens=None,
    ) -> ToolUseResponse:
        """
        Native function calling — the LLM returns structured tool_calls
        instead of JSON text the agent has to parse.

        This eliminates:
          - StructuredOutputError (no JSON parsing)
          - The "final_answer" hack (LLM just sends text when done)
          - Duplicate call detection logic
          - Text scratchpad (messages are the context)
        """
        if max_tokens is None:
            max_tokens = self.caps.max_output_tokens
        def make_body():
            b = self._body(messages, temperature, max_tokens)
            if tools:
                b["tools"] = tools
                b["tool_choice"] = "auto"
            return b

        prompt_chars = sum(len(m.get("content", "") or "") for m in messages)
        start = time.monotonic()

        log.debug(
            f"LLM invoke_with_tools: deployment={self.deployment}, "
            f"prompt_chars={prompt_chars}, tools={len(tools) if tools else 0}",
        )

        response = await self._post_with_retries(make_body(), op="invoke_with_tools")
        if response.status_code == 400 and adapt_from_error(self.caps, response.text):
            response = await self._post_with_retries(make_body(), op="invoke_with_tools")

        latency_ms = round((time.monotonic() - start) * 1000)

        if response.status_code != 200:
            log.error(f"LLM tool_use FAILED [{response.status_code}]: {response.text[:200]}")
            raise RuntimeError(
                f"Azure OpenAI call failed [{response.status_code}]: {response.text}"
            )

        data = response.json()
        message = data["choices"][0]["message"]
        usage = data.get("usage", {})

        cached = _cached_tokens(usage)
        log.info(
            f"LLM tool_use OK: {usage.get('total_tokens', 0)} tokens, {latency_ms}ms"
            + (f", prompt-cache hit: {cached}" if cached else ""),
            extra={"model": self.deployment, "tokens": usage.get("total_tokens", 0), "cached_tokens": cached},
        )

        # Parse tool_calls if present
        tool_calls = []
        raw_tool_calls = message.get("tool_calls", [])
        for tc in raw_tool_calls:
            try:
                args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                # Don't silently drop the arguments — a write tool would then
                # run with no content and blank the file. Flag it so the agent
                # returns a retryable error to the model instead.
                args = {"__args_parse_error__": True,
                        "_raw": str(tc.get("function", {}).get("arguments", ""))[:2000]}
            tool_calls.append(ToolCall(
                id=tc.get("id", ""),
                name=tc["function"]["name"],
                arguments=args,
            ))

        return ToolUseResponse(
            text=message.get("content", "") or "",
            tool_calls=tool_calls,
            usage=usage,
            raw_message=message,
        )

    async def stream_with_tools(
        self,
        messages,
        tools=None,
        temperature=0.0,
        max_tokens=None,
    ):
        """
        Stream the response token-by-token. When the LLM responds
        with text, tokens stream live. When it makes tool calls, they
        arrive as a single batch at the end.

        Yields:
          ("content", "token")     -> one text token (stream live)
          ("tool_calls", [...])    -> list of ToolCall objects
          ("usage", {...})         -> token usage dict
          ("truncated", {...})     -> output hit the token cap (finish_reason=
                                      "length") BEFORE the turn finished. The
                                      tool-call arguments (or text) are
                                      incomplete — the caller should retry with
                                      a larger budget rather than act on a
                                      half-formed call.
        """
        if max_tokens is None:
            max_tokens = self.caps.max_output_tokens
        def make_body():
            b = self._body(messages, temperature, max_tokens)
            b["stream"] = True
            b["stream_options"] = {"include_usage": True}
            if tools:
                b["tools"] = tools
                b["tool_choice"] = "auto"
            return b

        body = make_body()

        prompt_chars = sum(len(m.get("content", "") or "") for m in messages)
        start = time.monotonic()
        log.debug(
            f"LLM stream_with_tools: deployment={self.deployment}, "
            f"prompt_chars={prompt_chars}, tools={len(tools) if tools else 0}",
        )

        # Accumulators for tool calls (built up across chunks)
        tool_call_accum = {}

        # Retry loop — Claude Code behaviour. We retry timeouts / 429 / 5xx with
        # backoff, but ONLY while nothing has been yielded yet: retrying after
        # tokens were already delivered would duplicate output. Once the first
        # chunk arrives, a drop becomes a hard (but clearly-worded) error.
        yielded_any = False
        finish_reason = None
        for attempt in range(LLM_MAX_RETRIES + 1):
            tool_call_accum = {}
            finish_reason = None
            try:
                async with httpx.AsyncClient(timeout=_timeout()) as client:
                    async with client.stream(
                        "POST", self._url(), headers=self._headers(), json=body
                    ) as response:
                        if response.status_code != 200:
                            error_body = await response.aread()
                            if (
                                response.status_code == 400
                                and attempt < LLM_MAX_RETRIES
                                and adapt_from_error(self.caps, error_body.decode(errors="replace"))
                            ):
                                body = make_body()  # rebuilt with corrected params
                                continue
                            if response.status_code in _RETRYABLE_STATUS and attempt < LLM_MAX_RETRIES:
                                delay = _retry_delay(attempt, response)
                                log.warning(
                                    f"LLM stream_with_tools [{response.status_code}] — retrying "
                                    f"in {delay:.0f}s (attempt {attempt + 1}/{LLM_MAX_RETRIES})"
                                )
                                await asyncio.sleep(delay)
                                continue
                            raise RuntimeError(
                                f"Azure OpenAI stream failed [{response.status_code}]: {error_body.decode()}"
                            )

                        async for line in response.aiter_lines():
                            if not line or not line.startswith("data:"):
                                continue
                            chunk = line.removeprefix("data:").strip()
                            if chunk == "[DONE]":
                                break

                            try:
                                parsed = json.loads(chunk)
                            except json.JSONDecodeError:
                                continue

                            # Usage chunk (final)
                            usage = parsed.get("usage")
                            if usage:
                                cached = _cached_tokens(usage)
                                if cached:
                                    log.info(
                                        f"Prompt-cache hit: {cached} of "
                                        f"{usage.get('prompt_tokens', 0)} prompt tokens",
                                        extra={"model": self.deployment, "cached_tokens": cached},
                                    )
                                yielded_any = True
                                yield ("usage", usage)
                                continue

                            choices = parsed.get("choices") or []
                            if not choices:
                                # Azure sends in-stream errors as {"error": {...}} chunks
                                if "error" in parsed:
                                    err = parsed["error"]
                                    raise RuntimeError(
                                        f"Azure stream error: {err.get('message', str(err))}"
                                    )
                                continue

                            # Why the model stopped this chunk's generation.
                            # "length" == hit the output cap → truncated turn.
                            fr = choices[0].get("finish_reason")
                            if fr:
                                finish_reason = fr

                            delta = choices[0].get("delta", {})

                            # Text content tokens
                            content = delta.get("content")
                            if content:
                                yielded_any = True
                                yield ("content", content)

                            # Tool call chunks — accumulate across multiple deltas
                            tc_deltas = delta.get("tool_calls", [])
                            for tc_delta in tc_deltas:
                                idx = tc_delta.get("index", 0)
                                if idx not in tool_call_accum:
                                    tool_call_accum[idx] = {
                                        "id": tc_delta.get("id", ""),
                                        "name": "",
                                        "arguments": "",
                                    }
                                if tc_delta.get("id"):
                                    tool_call_accum[idx]["id"] = tc_delta["id"]
                                func = tc_delta.get("function", {})
                                if func.get("name"):
                                    tool_call_accum[idx]["name"] = func["name"]
                                if func.get("arguments"):
                                    tool_call_accum[idx]["arguments"] += func["arguments"]

                break  # stream completed — leave the retry loop

            except (httpx.TimeoutException, httpx.ConnectError) as e:
                if yielded_any:
                    raise RuntimeError(
                        f"LLM stream dropped mid-response ({type(e).__name__}) — "
                        f"no data for {LLM_READ_TIMEOUT:.0f}s"
                    ) from e
                if attempt < LLM_MAX_RETRIES:
                    delay = _retry_delay(attempt)
                    log.warning(
                        f"LLM stream_with_tools {type(e).__name__} — retrying in {delay:.0f}s "
                        f"(attempt {attempt + 1}/{LLM_MAX_RETRIES})"
                    )
                    await asyncio.sleep(delay)
                    continue
                raise RuntimeError(
                    f"LLM stream timed out after {LLM_MAX_RETRIES + 1} attempts "
                    f"(read timeout {LLM_READ_TIMEOUT:.0f}s each — likely Azure "
                    f"rate-limit queueing; check the deployment's TPM quota)"
                ) from e

        latency_ms = round((time.monotonic() - start) * 1000)
        log.info(
            f"LLM stream_with_tools OK: {latency_ms}ms, "
            f"tool_calls={len(tool_call_accum)}, finish={finish_reason!r}",
            extra={"model": self.deployment, "duration_ms": latency_ms},
        )

        # Output cap hit BEFORE the turn finished → the tool-call arguments (or
        # text) are cut off mid-string. This is OUR budget being too small, not
        # a malformed model response: acting on the partial call is what blanked
        # files. Signal truncation so the caller re-runs with a larger budget
        # (Claude Code continues the turn; we regenerate) — never guess/parse
        # the incomplete JSON.
        if finish_reason == "length":
            log.warning(
                f"LLM output truncated at max_tokens={max_tokens} "
                f"(finish_reason=length, tool_calls={len(tool_call_accum)}) — "
                f"signalling truncation for retry with a larger budget."
            )
            yield ("truncated", {
                "reason": "length",
                "stage": "tool_call" if tool_call_accum else "text",
                "max_tokens": max_tokens,
            })
            return

        # Emit accumulated tool calls as a batch
        if tool_call_accum:
            tool_calls = []
            for idx in sorted(tool_call_accum.keys()):
                tc = tool_call_accum[idx]
                try:
                    args = json.loads(tc["arguments"])
                except json.JSONDecodeError:
                    # Not truncation (finish_reason != length) yet still invalid
                    # JSON — surface it rather than dropping to {} (which would
                    # make file_write run with empty content and blank the file).
                    args = {"__args_parse_error__": True,
                            "_raw": str(tc.get("arguments", ""))[:2000]}
                tool_calls.append(ToolCall(
                    id=tc["id"],
                    name=tc["name"],
                    arguments=args,
                ))
            yield ("tool_calls", tool_calls)
