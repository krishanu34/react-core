"""
Cross-worker signal bus — makes the agent API safe to scale horizontally.

The problem it solves: an SSE run lives inside ONE worker process (its asyncio
queue and pending futures can't move). But with `uvicorn --workers N` or
multiple replicas behind a load balancer, the follow-up requests that control
that run — POST /stop, /tool_result, /permission_response — may land on a
DIFFERENT worker. Without coordination they 404 and the run hangs.

Two implementations, chosen automatically by create_signal_bus():

  SignalBus (default)   No-op. Zero overhead, zero dependencies. Correct for
                        the single-process deployment used today.

  RedisSignalBus        Enabled when the REDIS_URL env var is set (requires
                        `pip install redis`). Provides:
                          - active markers   (which threads have a live run,
                                              visible from every worker)
                          - stop flags       (Redis key; should_stop() polls
                                              local flag OR the Redis flag)
                          - delivery pub/sub (tool_result / permission
                                              decisions are broadcast; the
                                              worker holding the future
                                              resolves it locally)

Durable state (conversations, memory, resume state) stays in PostgreSQL — the
bus only carries ephemeral "right now" signals, which is what Redis is for.
"""

import asyncio
import json
import os
import socket
from typing import Any, Callable, Dict, Optional

from utils.logger import get_logger

log = get_logger(__name__)


def _tcp_keepalive_options() -> Dict[int, int]:
    """OS-level TCP keepalive probes so even IDLE pooled connections stay warm
    when the app server and Redis are on DIFFERENT hosts. On such a path a
    NAT / firewall / load-balancer silently drops idle TCP flows (error 10054,
    "forcibly closed by the remote host"). These probes generate low-level
    traffic well under a typical ~4-minute idle cutoff, without the app having
    to send anything. Linux exposes the per-socket knobs; platforms that don't
    (e.g. Windows dev machines) return {} and rely on socket_keepalive=True
    plus the app-level PINGs — the tuned path is production (Linux)."""
    opts: Dict[int, int] = {}
    if hasattr(socket, "TCP_KEEPIDLE"):
        opts[socket.TCP_KEEPIDLE] = 30    # begin probing after 30s of idle
    if hasattr(socket, "TCP_KEEPINTVL"):
        opts[socket.TCP_KEEPINTVL] = 15   # then probe every 15s
    if hasattr(socket, "TCP_KEEPCNT"):
        opts[socket.TCP_KEEPCNT] = 3      # give up after 3 missed probes
    return opts

_CHANNEL = "devsphere:agent:signals"
_ACTIVE_KEY = "devsphere:agent:active:{thread_id}"
_STOP_KEY = "devsphere:agent:stop:{thread_id}"
_ACTIVE_TTL = 24 * 3600   # safety TTL so a crashed worker can't leak markers
_STOP_TTL = 3600

# Handler signature: fn(thread_id: str, payload: dict) -> None
Handlers = Dict[str, Callable[[str, dict], Any]]


class SignalBus:
    """No-op bus for single-process deployments. Base class for RedisSignalBus."""

    enabled = False

    async def start(self, handlers: Handlers) -> None:
        pass

    async def close(self) -> None:
        pass

    # ── Active-run markers ────────────────────────────────────────
    def mark_active(self, thread_id: str) -> None:
        pass

    def clear_active(self, thread_id: str) -> None:
        pass

    def is_active_anywhere(self, thread_id: str) -> bool:
        return False

    # ── Stop flags ────────────────────────────────────────────────
    def request_stop(self, thread_id: str) -> bool:
        """Flag the run to stop from any worker. True if a live run was found."""
        return False

    def stop_requested(self, thread_id: str) -> bool:
        return False

    # ── Cross-worker delivery (tool results, permission decisions) ─
    async def publish(self, kind: str, thread_id: str, payload: dict) -> int:
        """Broadcast a delivery; returns how many workers received it."""
        return 0


class RedisSignalBus(SignalBus):
    enabled = True

    # Two very different access patterns share one Redis server here, and they
    # need OPPOSITE timeout policies:
    #
    #   SYNC client  — mark_active/is_active_anywhere/request_stop/
    #                  stop_requested run inline on the asyncio event loop (not
    #                  in an executor), on every agent step across every worker.
    #                  A bounded socket_timeout is MANDATORY: without it a Redis
    #                  network blip blocks that worker's entire event loop
    #                  indefinitely — freezing every SSE stream it holds. The
    #                  short timeout makes the call fail fast into the try/except
    #                  each method already has (degrading to local-only signals).
    #
    #   ASYNC client — used by the pubsub subscriber, which is SUPPOSED to block
    #                  for minutes waiting for the next message. It must NOT get
    #                  a socket_timeout: pubsub connections inherit the client's
    #                  connection_kwargs, so a read timeout makes listen() raise
    #                  TimeoutError on every idle gap and kills the subscriber
    #                  (that was the bug). Instead we keep the connection alive
    #                  with health-check PINGs + TCP keepalive, bound the one
    #                  short op on it (publish) with asyncio.wait_for, and make
    #                  the listener reconnect on any error instead of dying.
    # Timeouts are generous because this Redis is a REMOTE host with high
    # round-trip latency (measured ~300 ms/op, ~2 s first connect) — tuned to
    # tolerate that path while still bounding every call to a few seconds so a
    # genuinely dead Redis fails fast instead of hanging a worker forever.
    _SOCKET_TIMEOUT = 4.0
    _CONNECT_TIMEOUT = 5.0
    _HEALTH_CHECK = 20       # PING an idle link this often to keep it warm (s)
    _PUBLISH_TIMEOUT = 4.0   # bound publish() so an HTTP handler never hangs
    # How often the subscriber sends a keepalive PING while idle. Must be well
    # UNDER the idle-connection timeout of any NAT / firewall / load-balancer
    # between here and the remote Redis — those silently drop idle TCP links
    # (error 10054, "forcibly closed by the remote host"). Generating traffic
    # this often keeps the pubsub link warm so it is never dropped. Kept short
    # (10s) for a cross-host path where the idle cutoff can be aggressive.
    _KEEPALIVE_INTERVAL = 10
    # OS-level TCP keepalive probes (Linux) — computed once; keeps even idle
    # POOLED sync connections warm, which the app-level PINGs above do not.
    _KEEPALIVE_OPTS = _tcp_keepalive_options()

    def __init__(self, url: str):
        import redis
        import redis.asyncio as aioredis

        self._sync = redis.Redis.from_url(
            url,
            decode_responses=True,
            socket_timeout=self._SOCKET_TIMEOUT,
            socket_connect_timeout=self._CONNECT_TIMEOUT,
            socket_keepalive=True,
            socket_keepalive_options=self._KEEPALIVE_OPTS,
            health_check_interval=self._HEALTH_CHECK,
            retry_on_timeout=False,
        )
        # No socket_timeout here — the pubsub listener must block indefinitely.
        self._async = aioredis.Redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=self._CONNECT_TIMEOUT,
            socket_keepalive=True,
            socket_keepalive_options=self._KEEPALIVE_OPTS,
            health_check_interval=self._HEALTH_CHECK,
        )
        self._subscriber_task: Optional[asyncio.Task] = None
        self._handlers: Handlers = {}

    async def start(self, handlers: Handlers) -> None:
        """Subscribe this worker to the delivery channel. Each worker resolves
        only the futures it actually holds and silently ignores the rest.

        The listener runs in a reconnect loop: any Redis error (timeout, dropped
        connection, restart) is caught and the subscription is re-established
        after a short backoff, instead of the task dying silently and leaving
        cross-worker delivery permanently broken until a full server restart."""
        self._handlers = handlers

        async def _listen():
            while True:
                pubsub = self._async.pubsub()
                try:
                    await pubsub.subscribe(_CHANNEL)
                    log.info("Signal bus: Redis subscriber connected (multi-worker mode)")
                    while True:
                        # Bounded read instead of a blocking listen(): returns
                        # None after _KEEPALIVE_INTERVAL of silence, at which
                        # point we PING to keep the idle link warm (see the
                        # constant's note on error 10054). A real drop makes
                        # get_message/ping raise → caught below → reconnect.
                        message = await pubsub.get_message(
                            ignore_subscribe_messages=True,
                            timeout=self._KEEPALIVE_INTERVAL,
                        )
                        if message is None:
                            await pubsub.ping()   # generate traffic; stay alive
                            continue
                        if message.get("type") != "message":
                            continue  # ignore pong / subscribe confirmations
                        try:
                            event = json.loads(message["data"])
                            handler = self._handlers.get(event.get("kind", ""))
                            if handler:
                                result = handler(event.get("thread_id", ""), event.get("payload", {}))
                                if asyncio.iscoroutine(result):
                                    await result
                        except Exception as e:  # never let one bad message kill the bus
                            log.warning(f"Signal bus: failed to handle message: {e}")
                except asyncio.CancelledError:
                    try:
                        await pubsub.aclose()
                    except Exception:
                        pass
                    raise
                except Exception as e:
                    # Connection dropped / timed out — log once, drop the dead
                    # pubsub, back off, and re-subscribe on the next iteration.
                    log.warning(f"Signal bus: subscriber lost connection ({e}); "
                                f"reconnecting in 2s")
                    try:
                        await pubsub.aclose()
                    except Exception:
                        pass
                    await asyncio.sleep(2)

        self._subscriber_task = asyncio.create_task(_listen())
        log.info("Signal bus: Redis subscriber started (multi-worker mode)")

    async def close(self) -> None:
        if self._subscriber_task and not self._subscriber_task.done():
            self._subscriber_task.cancel()
        await self._async.close()

    def mark_active(self, thread_id: str) -> None:
        try:
            self._sync.set(_ACTIVE_KEY.format(thread_id=thread_id), "1", ex=_ACTIVE_TTL)
        except Exception as e:
            log.warning(f"Signal bus: mark_active failed: {e}")

    def clear_active(self, thread_id: str) -> None:
        try:
            self._sync.delete(
                _ACTIVE_KEY.format(thread_id=thread_id),
                _STOP_KEY.format(thread_id=thread_id),
            )
        except Exception as e:
            log.warning(f"Signal bus: clear_active failed: {e}")

    def is_active_anywhere(self, thread_id: str) -> bool:
        try:
            return bool(self._sync.exists(_ACTIVE_KEY.format(thread_id=thread_id)))
        except Exception as e:
            log.warning(f"Signal bus: is_active_anywhere failed: {e}")
            return False

    def request_stop(self, thread_id: str) -> bool:
        try:
            if not self.is_active_anywhere(thread_id):
                return False
            self._sync.set(_STOP_KEY.format(thread_id=thread_id), "1", ex=_STOP_TTL)
            return True
        except Exception as e:
            log.warning(f"Signal bus: request_stop failed: {e}")
            return False

    def stop_requested(self, thread_id: str) -> bool:
        try:
            return bool(self._sync.exists(_STOP_KEY.format(thread_id=thread_id)))
        except Exception as e:
            log.warning(f"Signal bus: stop_requested failed: {e}")
            return False

    async def publish(self, kind: str, thread_id: str, payload: dict) -> int:
        # The async client has no socket_timeout (its connection pool is shared
        # with the blocking pubsub listener), so bound this one-shot op here to
        # keep a slow/dead Redis from hanging the HTTP handler that called it.
        try:
            receivers = await asyncio.wait_for(
                self._async.publish(
                    _CHANNEL,
                    json.dumps({"kind": kind, "thread_id": thread_id, "payload": payload}),
                ),
                timeout=self._PUBLISH_TIMEOUT,
            )
            return int(receivers or 0)
        except asyncio.TimeoutError:
            log.warning("Signal bus: publish timed out")
            return 0
        except Exception as e:
            log.warning(f"Signal bus: publish failed: {e}")
            return 0


def create_signal_bus() -> SignalBus:
    """REDIS_URL set + redis installed -> RedisSignalBus, else no-op bus."""
    url = os.getenv("REDIS_URL", "").strip()
    if not url:
        return SignalBus()
    try:
        import redis  # noqa: F401
    except ImportError:
        log.warning(
            "REDIS_URL is set but the 'redis' package is not installed "
            "(pip install redis). Falling back to single-worker mode."
        )
        return SignalBus()
    try:
        bus = RedisSignalBus(url)
        log.info(f"Signal bus: Redis enabled ({url.split('@')[-1]})")
        return bus
    except Exception as e:
        log.warning(f"Signal bus: failed to init Redis ({e}). Single-worker mode.")
        return SignalBus()
