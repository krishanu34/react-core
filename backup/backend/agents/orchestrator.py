"""
Orchestrator Agent — Single Agent Loop

ONE agent loop handles EVERYTHING. No routing split.

This matches how Claude Code, GitHub Copilot, and Cursor actually work:
  - "hello" → agent has tools, doesn't use them, responds with text
  - "create a website" → agent uses file_write, run_terminal, etc.
  - "1" (follow-up) → agent sees memory, knows context, uses tools
  - "what is a closure?" → agent responds with text, no tools

WHY NO IntentDetector FOR ROUTING:

  The old architecture routed "hello" to a direct (no-tools) path to
  save ~5000 tokens. But this broke follow-ups:

    User: "create an e-commerce website"
    Agent: "What tech stack?" (ask_user tool, agent route) ✅
    User: "1"
    IntentDetector: no signals → direct route ❌
    Agent: dumps code as text, no files created ❌

  The IntentDetector can't know that "1" is a follow-up to a tool-using
  conversation. It only sees the current message, not the history.

  The fix: ALWAYS use the agent loop. The LLM sees the tools but only
  uses them when needed. For "hello" it just responds with text.
  For "1" after a clarification question, it sees the conversation
  memory and continues building.

  Cost: ~5000 extra tokens per simple question (tool descriptions).
  Benefit: Everything works. No misrouting. No broken follow-ups.

  IntentDetector is kept for LOGGING only — the SSE classification
  event still tells the client what signals were detected, which is
  useful for debugging and analytics. But it never affects routing.
"""

import traceback
from typing import Any, Awaitable, Callable, Optional

from .base_agent import BaseAgent
from .factory import build_agent
from .stop_registry import RunState
from .intent_detector import detect_intent, IntentResult
from utils.logger import get_logger

# AGENT_MODE now lives in agents/factory.py — one source of truth, so a
# sub-agent can never end up on a different loop than its parent.

log = get_logger(__name__)

EventCallback = Callable[[str, dict], Optional[Awaitable[None]]]
StopCheck = Callable[[], bool]


class OrchestratorAgent(BaseAgent):
    """
    Single agent loop for ALL messages. No routing split.
    The agent itself decides whether to use tools.
    """

    def __init__(
        self,
        llm,
        tool_registry=None,
        memory=None,
        token_tracker=None,
        context_window=8192,
        thread_id="default",
        max_run_tokens=None,
        quota_probe=None,
    ):
        tools = tool_registry.list_tools() if tool_registry else []
        super().__init__(llm, tools, memory)
        self.tool_registry = tool_registry
        self.token_tracker = token_tracker
        self.context_window = context_window
        self.thread_id = thread_id
        # The caller's per-run token ceiling, from their quota. None → the
        # MAX_AGENT_TOKENS env default.
        self.max_run_tokens = max_run_tokens
        # Mid-run budget probe (see ToolUseAgent.quota_probe).
        self.quota_probe = quota_probe

    async def _emit(self, on_event: Optional[EventCallback], event_type: str, data: dict):
        if on_event is None:
            return
        result = on_event(event_type, data)
        if result is not None:
            await result

    def _create_agent(self):
        """Create the agent based on AGENT_MODE (see agents/factory.py — the
        same builder SubAgentTool uses, so children run the parent's loop)."""
        return build_agent(
            llm=self.llm,
            tool_registry=self.tool_registry,
            memory=self.memory,
            token_tracker=self.token_tracker,
            context_window=self.context_window,
            thread_id=self.thread_id,
            max_run_tokens=self.max_run_tokens,
            quota_probe=self.quota_probe,
        )

    async def run(
        self,
        input,
        memory_context: str = "",
        on_event: Optional[EventCallback] = None,
        should_stop: Optional[StopCheck] = None,
        agent_logger=None,
        images: list = None,
    ):
        """
        Single agent loop for every message.

        IntentDetector runs for LOGGING ONLY — the classification
        event tells the client what signals were detected (useful
        for debugging/analytics), but routing is always "agent".
        """
        # IntentDetector for logging/analytics only — NOT for routing
        intent = detect_intent(input)
        log.info(
            f"Intent (info only): signals={len(intent.signals)}, "
            f"score={intent.total_score}"
        )

        # Always route to agent — the LLM decides whether to use tools
        route = "agent"

        await self._emit(on_event, "classification", {
            "route": route,
            "intent": {
                "minimum_route": intent.minimum_route,
                "signals": [s.reason for s in intent.signals],
                "score": intent.total_score,
            },
            "reasoning": (
                intent.reasoning if intent.signals
                else "Single agent loop — LLM decides tool usage"
            ),
        })

        if agent_logger:
            agent_logger.log_classification(
                route=route,
                intent_signals=[s.reason for s in intent.signals],
                reasoning=intent.reasoning,
            )

        # ONE agent loop handles everything
        agent = self._create_agent()

        try:
            result = await agent.run(
                input,
                memory_context=memory_context,
                on_event=on_event,
                should_stop=should_stop,
                agent_logger=agent_logger,
                images=images,
            )
        except Exception as e:
            error_msg = f"{type(e).__name__}: {str(e) or '(no message)'}"
            tb = traceback.format_exc()
            await self._emit(on_event, "error", {
                "message": error_msg,
                "traceback": tb,
            })
            return {
                "status": "error",
                "route": "agent",
                "answer": f"Agent error: {error_msg}",
                "steps_taken": 0,
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                # Crashed runs are resumable too — same input, fresh attempt.
                "run_state": RunState(
                    route="agent",
                    original_input=input,
                    memory_context=memory_context,
                    partial_answer="",
                    usage={},
                ),
            }

        # Build resume state if stopped OR errored. Claude Code keeps the
        # session alive after an API failure (timeout/429) — the user just
        # retries and continues. Saving state here makes POST /api/agent/resume
        # work after an LLM error instead of losing the run.
        run_state = None
        if result["status"] in ("stopped", "error"):
            run_state = RunState(
                route="agent",
                original_input=input,
                memory_context=memory_context,
                partial_answer=result["answer"],
                usage=result.get("usage", {}),
            )

        return {
            "status": result["status"],
            "route": "agent",
            "answer": result["answer"],
            "steps_taken": result["steps_taken"],
            "usage": result.get("usage", {}),
            "run_state": run_state,
        }

    async def resume(
        self,
        saved_state: RunState,
        on_event: Optional[EventCallback] = None,
        should_stop: Optional[StopCheck] = None,
    ):
        await self._emit(on_event, "classification", {
            "route": "agent",
            "reasoning": "Resuming previously stopped run",
            "resumed": True,
        })

        agent = self._create_agent()

        try:
            result = await agent.run(
                saved_state.original_input,
                memory_context=saved_state.memory_context,
                on_event=on_event,
                should_stop=should_stop,
            )
        except Exception as e:
            error_msg = f"{type(e).__name__}: {str(e) or '(no message)'}"
            await self._emit(on_event, "error", {"message": error_msg})
            return {
                "status": "error",
                "route": "agent",
                "answer": f"Resume error: {error_msg}",
                "steps_taken": 0,
                "usage": {},
            }

        run_state = None
        if result["status"] in ("stopped", "error"):
            run_state = RunState(
                route="agent",
                original_input=saved_state.original_input,
                memory_context=saved_state.memory_context,
                partial_answer=result["answer"],
                usage=result.get("usage", {}),
            )

        return {
            "status": result["status"],
            "route": "agent",
            "answer": result["answer"],
            "steps_taken": result["steps_taken"],
            "usage": result.get("usage", {}),
            "run_state": run_state,
        }
