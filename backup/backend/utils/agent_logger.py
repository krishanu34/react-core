"""
Agent Logger — Structured Event Tracking for Agentic AI

This is the dashboard-ready logging layer. It writes structured
JSON events to logs/agent_events.jsonl — one event per line,
each containing all the context needed for analytics.

What it tracks (every field the dashboard will need):

  USER EVENTS:
    - user_question: the raw question asked
    - thread_id: which conversation
    - timestamp: when

  LLM EVENTS:
    - model: which model (gpt-4.1, etc.)
    - prompt_tokens / completion_tokens / total_tokens
    - latency_ms: how long the LLM call took
    - prompt_size_chars: how big the prompt was
    - temperature / max_tokens: generation params
    - step_number: which ReAct step this call was for
    - purpose: "classification" / "react_step" / "summarization" / "direct_answer"

  TOOL EVENTS:
    - tool_name: which tool was called
    - tool_input: what arguments were passed
    - tool_output_size: how big the result was
    - tool_duration_ms: how long the tool took
    - tool_success: true/false
    - tool_error: error message if failed

  AGENT EVENTS:
    - route: "direct" / "agent"
    - intent_signals: what the IntentDetector found
    - steps_taken: total ReAct steps
    - final_answer_length: how long the answer was
    - status: "done" / "error" / "stopped" / "max_steps_reached"
    - total_duration_ms: end-to-end time for the whole request

  ERROR EVENTS:
    - error_type: exception class name
    - error_message: full error text
    - error_context: what was happening when it failed
    - traceback: full stack trace

Usage:
    from utils.agent_logger import AgentLogger
    al = AgentLogger(thread_id="abc123")
    al.log_user_question("analyze my workspace")
    al.log_llm_call(model="gpt-4.1", prompt_tokens=500, ...)
    al.log_tool_call(tool_name="read_file", ...)
    al.log_agent_complete(status="done", ...)
"""

import json
import os
import time
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler

from .logger import get_logger, LOG_DIR

# Dedicated file for agent events — separate from app.log so the
# dashboard can consume it independently without parsing app logs.
_EVENTS_FILE = os.path.join(LOG_DIR, "agent_events.jsonl")


def _write_event(event: dict):
    """Append one JSON event to the events file."""
    try:
        with open(_EVENTS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass  # logging should never crash the application


class AgentLogger:
    """
    Per-request logger that tracks everything about one agent run.
    Create one at the start of each /api/agent/stream request,
    pass it through the orchestrator and agent.
    """

    def __init__(self, thread_id: str = "unknown"):
        self.thread_id = thread_id
        self.request_start = time.monotonic()
        self.request_start_utc = datetime.now(timezone.utc)
        self._log = get_logger("agent")
        self._step_count = 0

    def _base_event(self, event_type: str) -> dict:
        """Base fields present on every event."""
        return {
            "event_type": event_type,
            "thread_id": self.thread_id,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "elapsed_ms": round((time.monotonic() - self.request_start) * 1000),
        }

    # ── User Events ──────────────────────────────────────────────

    def log_user_question(self, question: str, workspace_path: str = None):
        """Log when a user sends a question."""
        event = self._base_event("user_question")
        event.update({
            "question": question,
            "question_length": len(question),
            "workspace_path": workspace_path,
        })
        _write_event(event)
        self._log.info(
            f"User question: {question[:100]}{'...' if len(question) > 100 else ''}",
            extra={"thread_id": self.thread_id},
        )

    # ── Classification / Route Events ────────────────────────────

    def log_classification(self, route: str, intent_signals: list = None, reasoning: str = ""):
        """Log the orchestrator's routing decision."""
        event = self._base_event("classification")
        event.update({
            "route": route,
            "intent_signals": intent_signals or [],
            "reasoning": reasoning,
        })
        _write_event(event)
        self._log.info(
            f"Route: {route}",
            extra={"thread_id": self.thread_id, "route": route},
        )

    # ── LLM Call Events ──────────────────────────────────────────

    def log_llm_call(
        self,
        purpose: str,
        model: str = "unknown",
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
        latency_ms: int = 0,
        prompt_size_chars: int = 0,
        temperature: float = 0.0,
        max_tokens: int = 0,
        step_number: int = None,
        success: bool = True,
        error: str = None,
    ):
        """
        Log every LLM API call. Called from azure_openai.py.

        purpose: "react_step" / "direct_answer" / "summarization" / etc.
        """
        event = self._base_event("llm_call")
        event.update({
            "purpose": purpose,
            "model": model,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "latency_ms": latency_ms,
            "prompt_size_chars": prompt_size_chars,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "step_number": step_number,
            "success": success,
            "error": error,
        })
        _write_event(event)

        tokens = total_tokens
        if success:
            self._log.info(
                f"LLM call ({purpose}): {tokens} tokens, {latency_ms}ms",
                extra={
                    "thread_id": self.thread_id,
                    "model": model,
                    "tokens": tokens,
                    "duration_ms": latency_ms,
                },
            )
        else:
            self._log.error(
                f"LLM call FAILED ({purpose}): {error}",
                extra={"thread_id": self.thread_id, "model": model},
            )

    # ── Tool Call Events ─────────────────────────────────────────

    def log_tool_call(
        self,
        tool_name: str,
        tool_input: dict = None,
        tool_output_size: int = 0,
        tool_duration_ms: int = 0,
        tool_success: bool = True,
        tool_error: str = None,
        step_number: int = None,
    ):
        """Log every tool execution. Called from react_agent.py."""
        event = self._base_event("tool_call")
        event.update({
            "tool_name": tool_name,
            "tool_input": _safe_truncate(tool_input, 500),
            "tool_output_size": tool_output_size,
            "tool_duration_ms": tool_duration_ms,
            "tool_success": tool_success,
            "tool_error": tool_error,
            "step_number": step_number,
        })
        _write_event(event)
        self._log.info(
            f"Tool: {tool_name} -> {'OK' if tool_success else 'FAIL'} ({tool_duration_ms}ms)",
            extra={
                "thread_id": self.thread_id,
                "tool": tool_name,
                "duration_ms": tool_duration_ms,
            },
        )

    # ── Agent Step Events ────────────────────────────────────────

    def log_agent_step(self, step_number: int, thought: str, action: str):
        """Log each ReAct step (think → act)."""
        self._step_count = step_number
        event = self._base_event("agent_step")
        event.update({
            "step_number": step_number,
            "thought": thought[:300],
            "action": action,
        })
        _write_event(event)

    # ── Agent Completion Events ──────────────────────────────────

    def log_agent_complete(
        self,
        status: str,
        route: str,
        steps_taken: int = 0,
        final_answer_length: int = 0,
        total_prompt_tokens: int = 0,
        total_completion_tokens: int = 0,
        total_tokens: int = 0,
    ):
        """Log when the full agent run completes."""
        total_duration_ms = round((time.monotonic() - self.request_start) * 1000)
        event = self._base_event("agent_complete")
        event.update({
            "status": status,
            "route": route,
            "steps_taken": steps_taken,
            "final_answer_length": final_answer_length,
            "total_prompt_tokens": total_prompt_tokens,
            "total_completion_tokens": total_completion_tokens,
            "total_tokens": total_tokens,
            "total_duration_ms": total_duration_ms,
        })
        _write_event(event)
        self._log.info(
            f"Agent complete: {status}, {steps_taken} steps, "
            f"{total_tokens} tokens, {total_duration_ms}ms",
            extra={"thread_id": self.thread_id, "route": route},
        )

    # ── Error Events ─────────────────────────────────────────────

    def log_error(
        self,
        error_type: str,
        error_message: str,
        error_context: str = "",
        traceback: str = None,
    ):
        """Log any error with full context."""
        event = self._base_event("error")
        event.update({
            "error_type": error_type,
            "error_message": error_message,
            "error_context": error_context,
            "traceback": traceback,
        })
        _write_event(event)
        self._log.error(
            f"{error_type}: {error_message} (context: {error_context})",
            extra={"thread_id": self.thread_id},
        )

    # ── Output File Events ───────────────────────────────────────

    def log_output_created(self, filename: str, path: str, size: int):
        """Log when the agent creates an output file."""
        event = self._base_event("output_created")
        event.update({
            "filename": filename,
            "path": path,
            "size_bytes": size,
        })
        _write_event(event)
        self._log.info(
            f"Output created: {filename} ({size} bytes)",
            extra={"thread_id": self.thread_id},
        )


def _safe_truncate(obj, max_chars: int) -> str:
    """Safely convert any object to a truncated string for logging."""
    try:
        text = json.dumps(obj, default=str)
    except Exception:
        text = str(obj)
    if len(text) > max_chars:
        return text[:max_chars] + "..."
    return text
