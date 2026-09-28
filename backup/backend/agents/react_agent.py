"""
ReAct Agent - Reason + Act Loop (with Parallel Tool Calls)

This is THE core agent. It handles everything from "read one file"
to "refactor the entire codebase". The same loop, the same prompt.

The loop:
  1. Ask LLM: "given everything so far, what's your next move?"
  2. Parse: thought + one or MORE actions
  3. If any action is "final_answer" → done, return the answer
  4. Otherwise → execute ALL tools in parallel, record observations, loop

Parallel tool calls:
  The LLM can return multiple actions in one response using the
  "actions" array. All independent tools run simultaneously via
  asyncio.gather — this is how Claude Code handles workspace analysis.

  Single action (backward compatible):
    {"thought": "...", "action": "read_file", "action_input": {...}}

  Multiple actions (parallel):
    {"thought": "...", "actions": [
      {"tool": "read_file", "input": {"path": "a.py"}},
      {"tool": "read_file", "input": {"path": "b.py"}},
      {"tool": "read_file", "input": {"path": "c.py"}}
    ]}

  = 1 LLM call, 3 tool executions in parallel
"""

import asyncio
import time
import traceback
import uuid
from typing import Any, Awaitable, Callable, List, Optional

from .base_agent import BaseAgent
from .parallelism import slot, tool_slots
from memory.short_term import ShortTermMemory
from prompts.loader import PromptLoader
from llm.structured_output import extract_json, StructuredOutputError
from context.budget_manager import allocate_budget, measure_system_overhead
from utils.logger import get_logger

log = get_logger(__name__)

EventCallback = Callable[[str, dict], Optional[Awaitable[None]]]
StopCheck = Callable[[], bool]

MAX_PARALLEL_TOOLS = 10


class AgentStopped(Exception):
    """Raised when should_stop() returns True between steps."""


HARD_CEILING = 200
STALL_LIMIT = 3


class ReActAgent(BaseAgent):
    """
    The agent that actually does work. Loops: Think → Act → Observe.

    No fixed step limit — like Claude Code, the loop runs until:
      1. LLM says final_answer → success
      2. Context budget exhausted → graceful stop
      3. Stall detected (N consecutive non-productive steps) → stop
      4. Cooperative cancellation (should_stop) → stop
      5. Hard ceiling (200) → safety net, should never be hit

    The context window is the natural limit: as the scratchpad grows,
    older steps get compressed. When even compressed steps can't fit,
    the agent has used all available context and must stop.
    """

    def __init__(
        self,
        llm,
        tool_registry=None,
        memory=None,
        max_steps=None,
        token_tracker=None,
        context_window=8192,
    ):
        tools = tool_registry.list_tools() if tool_registry else []
        super().__init__(llm, tools, memory)
        self.tool_registry = tool_registry
        self.token_tracker = token_tracker
        self.context_window = context_window

        from context.budget_manager import allocate_budget
        self.budget = allocate_budget(context_window)

    async def _emit(self, on_event: Optional[EventCallback], event_type: str, data: dict):
        if on_event is None:
            return
        result = on_event(event_type, data)
        if result is not None:
            await result

    def _tool_descriptions(self):
        if self.tool_registry is not None:
            return self.tool_registry.descriptions_text()
        if not self.tools:
            return "(no tools available)"
        return "\n".join(f"- {tool.name}: {tool.description}" for tool in self.tools)

    def _build_messages(self, user_input, scratchpad: ShortTermMemory, memory_context: str = ""):
        system_prompt = PromptLoader.load(
            "react_agent",
            tool_descriptions=self._tool_descriptions(),
            memory_context=memory_context or "(no prior memory for this thread)",
        )

        # Scratchpad is compressed to its budget; user_input is NEVER truncated.
        # Claude Code rule: compress history, never chop the current message.
        scratchpad_text = scratchpad.as_text_compressed(
            token_budget=self.budget.scratchpad,
            keep_recent=3,
        )

        user_content = user_input  # always preserved in full
        if scratchpad_text:
            user_content += "\n\n## Steps completed so far\n" + scratchpad_text

        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

    def _parse_response(self, raw_text: str):
        """
        Parse the LLM's JSON response. Supports TWO formats:

        Single action (backward compatible):
          {"thought": "...", "action": "tool", "action_input": {...}}

        Parallel actions:
          {"thought": "...", "actions": [
            {"tool": "read_file", "input": {"path": "a.py"}},
            {"tool": "read_file", "input": {"path": "b.py"}}
          ]}

        Returns: (thought: str, actions: list[dict])
        Each action dict has: {"action": str, "action_input": dict}
        """
        parsed = extract_json(raw_text)
        thought = parsed.get("thought", "")

        # Format 1: parallel "actions" array
        if "actions" in parsed and isinstance(parsed["actions"], list):
            actions = []
            for item in parsed["actions"][:MAX_PARALLEL_TOOLS]:
                action_name = item.get("tool", item.get("action", ""))
                action_input = item.get("input", item.get("action_input", {}))
                if not action_name:
                    continue
                if isinstance(action_input, str) and action_name == "final_answer":
                    action_input = {"answer": action_input}
                actions.append({"action": action_name, "action_input": action_input})
            if actions:
                return thought, actions

        # Format 2: single "action" (original ReAct format)
        action = parsed.get("action", "")
        action_input = parsed.get("action_input", {})
        if action == "final_answer" and isinstance(action_input, str):
            action_input = {"answer": action_input}

        return thought, [{"action": action, "action_input": action_input}]

    async def _call_tool(self, action_name, action_input: dict, on_event=None):
        tool = self.tool_registry.get(action_name) if self.tool_registry else None
        if tool is None:
            available = self.tool_registry.names() if self.tool_registry else []
            return f"Error: unknown tool '{action_name}'. Available tools: {available}"

        if not isinstance(action_input, dict):
            return "Error: action_input must be a JSON object of arguments."

        try:
            if on_event and getattr(tool, "SUPPORTS_STREAMING", False):
                result = await tool.run(**action_input, on_event=on_event)
            else:
                result = await tool.run(**action_input)
            return str(result)
        except TypeError as e:
            return f"Error: invalid arguments for tool '{tool.name}': {e}"
        except Exception as e:
            return f"Error running tool '{tool.name}': {type(e).__name__}: {e}"

    async def _execute_tool_with_events(
        self, action_name, action_input, on_event, agent_logger, step_number
    ):
        """Execute one tool call with SSE events and logging. Returns (observation, duration_ms, is_error)."""
        # Tag every event from this call so the client can attribute it to the
        # right row. A step's actions run concurrently and their events
        # interleave on one SSE channel; matching by tool name alone misfiles
        # results whenever two calls to the same tool are in flight. The
        # tool_use loop does the same with the LLM's own tool_call id — the
        # ReAct protocol has none, so we mint one.
        call_id = uuid.uuid4().hex[:12]

        async def _tool_event(event_type: str, data: dict):
            await self._emit(on_event, event_type, {"call_id": call_id, **data})

        await _tool_event("tool_start", {
            "tool": action_name,
            "input": action_input,
        })

        tool_start = time.monotonic()
        observation = await self._call_tool(action_name, action_input, on_event=_tool_event)
        tool_duration = round((time.monotonic() - tool_start) * 1000)

        is_error = isinstance(observation, str) and observation.startswith("Error")
        await _tool_event(
            "tool_error" if is_error else "tool_result",
            {"tool": action_name, "observation": observation},
        )

        if agent_logger:
            agent_logger.log_tool_call(
                tool_name=action_name,
                tool_input=action_input,
                tool_output_size=len(observation),
                tool_duration_ms=tool_duration,
                tool_success=not is_error,
                tool_error=observation if is_error else None,
                step_number=step_number,
            )

        return observation, tool_duration, is_error

    async def run(
        self,
        input,
        memory_context: str = "",
        on_event: Optional[EventCallback] = None,
        should_stop: Optional[StopCheck] = None,
        agent_logger=None,
    ):
        """
        The main Reason+Act loop with parallel tool execution.

        When the LLM returns multiple actions, they execute
        concurrently via asyncio.gather — same as Claude Code.
        """
        # This loop has no message array — it prompts from a rendered
        # scratchpad string — so it has nowhere to put an image. Tools that
        # queue one (read_file on a screenshot) would otherwise leave it in the
        # buffer for whichever run drains next. Cleared here rather than at the
        # end because every exit path passes through the start of the NEXT run,
        # including the ones that raise.
        #
        # The thread id comes off the registry's tools: ReActAgent, unlike
        # ToolUseAgent, has never carried one, and its tools are the things
        # that actually queue images (ToolRegistry.build_for_workspace stamps
        # thread_id onto every one).
        from . import vision_buffer
        _tools = self.tool_registry.list_tools() if self.tool_registry else []
        for _tool in _tools[:1]:
            vision_buffer.clear(getattr(_tool, "thread_id", ""))
        # Measure actual system overhead once per run and recompute budget.
        # The system prompt includes tool descriptions whose length varies
        # with the number of tools — measuring avoids the hardcoded default.
        _system_text = PromptLoader.load(
            "react_agent",
            tool_descriptions=self._tool_descriptions(),
            memory_context=memory_context or "(no prior memory for this thread)",
        )
        actual_overhead = measure_system_overhead(system_text=_system_text)
        self.budget = allocate_budget(self.context_window, system_overhead=actual_overhead)

        scratchpad = ShortTermMemory()
        usage_totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        _previous_calls: set = set()

        # Bounds how many of one step's actions execute at once. Per run so a
        # sub-agent's child loop gets its own slots — see agents/parallelism.py.
        _tool_slots = tool_slots()

        import json as _json

        def _accumulate_usage(raw_usage: dict):
            usage_totals["prompt_tokens"] += raw_usage.get("prompt_tokens", 0)
            usage_totals["completion_tokens"] += raw_usage.get("completion_tokens", 0)
            usage_totals["total_tokens"] += raw_usage.get("total_tokens", 0)
            if self.token_tracker is not None:
                model = getattr(self.llm, "deployment", "unknown")
                self.token_tracker.record_usage(raw_usage, model=model)

        def _make_call_key(action_name, action_input):
            try:
                return action_name + "|" + _json.dumps(action_input, sort_keys=True)
            except (TypeError, ValueError):
                return action_name + "|" + str(action_input)

        steps_taken = 0
        stall_count = 0
        consecutive_parse_errors = 0

        try:
            while steps_taken < HARD_CEILING:
                if should_stop is not None and should_stop():
                    raise AgentStopped()

                # ── Check context budget ────────────────────────
                # If scratchpad can't even fit 1 compressed step,
                # context is exhausted — stop gracefully.
                from context.token_estimator import estimate_tokens
                scratchpad_tokens = scratchpad.total_tokens()
                if scratchpad_tokens > self.budget.scratchpad * 0.95:
                    log.info(f"Context budget exhausted at step {steps_taken} "
                             f"({scratchpad_tokens} tokens used)")
                    await self._emit(on_event, "thinking", {
                        "thought": f"[Context budget reached after {steps_taken} steps, producing answer]",
                    })
                    break

                # ── Call LLM ────────────────────────────────────
                messages = self._build_messages(input, scratchpad, memory_context)

                try:
                    raw_response, raw_usage = await self.llm.invoke(messages)
                except Exception as e:
                    error_detail = f"{type(e).__name__}: {str(e) or '(empty)'}"
                    await self._emit(on_event, "error", {
                        "message": f"LLM call failed on step {steps_taken + 1}: {error_detail}",
                    })
                    if scratchpad.steps:
                        partial = self._build_partial_answer(input, scratchpad)
                        await self._emit(on_event, "final", {"answer": partial})
                        return {
                            "status": "error", "answer": partial,
                            "steps_taken": steps_taken, "usage": usage_totals,
                        }
                    return {
                        "status": "error",
                        "answer": f"Failed to get response from LLM: {error_detail}",
                        "steps_taken": steps_taken, "usage": usage_totals,
                    }

                _accumulate_usage(raw_usage)
                await self._emit(on_event, "token_usage", {"usage": dict(usage_totals)})

                # ── Parse response (single or parallel) ─────────
                try:
                    thought, actions = self._parse_response(raw_response)
                    consecutive_parse_errors = 0
                except StructuredOutputError as e:
                    consecutive_parse_errors += 1
                    scratchpad.add_step(
                        thought="(unparseable response)",
                        action="(none)",
                        action_input="(none)",
                        observation=(
                            f"Error: your response was not valid JSON ({e}). "
                            f"Respond with ONLY a JSON object as instructed."
                        ),
                    )
                    steps_taken += 1
                    if consecutive_parse_errors >= 3:
                        log.error(
                            f"Agent stuck: {consecutive_parse_errors} consecutive "
                            f"unparseable LLM responses — stopping"
                        )
                        await self._emit(on_event, "error", {
                            "message": (
                                f"LLM returned invalid JSON {consecutive_parse_errors} "
                                "times in a row. The model may be rate-limited or "
                                "content-filtered. Please try again."
                            ),
                        })
                        partial = self._build_partial_answer(input, scratchpad)
                        await self._emit(on_event, "final", {"answer": partial})
                        return {
                            "status": "parse_error", "answer": partial,
                            "steps_taken": steps_taken, "usage": usage_totals,
                        }
                    continue

                await self._emit(on_event, "thinking", {"thought": thought})
                if agent_logger:
                    action_names = [a["action"] for a in actions]
                    agent_logger.log_agent_step(
                        step_number=steps_taken + 1,
                        thought=thought,
                        action=", ".join(action_names) if len(action_names) > 1 else action_names[0],
                    )

                # ── Handle final_answer ─────────────────────────
                final = next((a for a in actions if a["action"] == "final_answer"), None)
                if final:
                    answer = (
                        final["action_input"].get("answer", "")
                        if isinstance(final["action_input"], dict)
                        else str(final["action_input"])
                    )
                    if self.memory:
                        self.memory.add(
                            content=f"Q: {input[:200]}\nA: {answer[:200]}",
                            tags=["conversation"],
                        )
                    steps_taken += 1
                    log.info(f"Final answer produced ({len(answer)} chars, {steps_taken} steps)")
                    await self._emit(on_event, "final", {"answer": answer})
                    return {
                        "status": "done", "answer": answer,
                        "steps_taken": steps_taken, "usage": usage_totals,
                    }

                # ── Filter duplicates ───────────────────────────
                # to_execute holds (act, call_key) tuples so we can
                # discard the key from _previous_calls if the tool fails,
                # letting the LLM retry on the next step.
                to_execute = []
                for act in actions:
                    call_key = _make_call_key(act["action"], act["action_input"])
                    if call_key in _previous_calls:
                        log.warning(f"Duplicate tool call blocked: {act['action']}")
                        observation = (
                            f"DUPLICATE: You already called {act['action']} with "
                            f"these exact arguments. Use the result from your "
                            f"scratchpad. Do NOT repeat tool calls."
                        )
                        scratchpad.add_step(
                            thought=thought, action=act["action"],
                            action_input=act["action_input"], observation=observation,
                        )
                        await self._emit(on_event, "tool_result", {
                            "tool": act["action"], "observation": observation,
                        })
                    else:
                        _previous_calls.add(call_key)
                        to_execute.append((act, call_key))

                if not to_execute:
                    stall_count += 1
                    steps_taken += 1
                    if stall_count >= STALL_LIMIT:
                        log.info(f"Stall detected: {stall_count} consecutive non-productive steps")
                        await self._emit(on_event, "thinking", {
                            "thought": f"[Stall detected after {stall_count} duplicate steps, producing answer]",
                        })
                        break
                    continue
                stall_count = 0

                # ── Execute tools (parallel if multiple) ────────
                has_output_write = False

                if len(to_execute) == 1:
                    act, call_key = to_execute[0]
                    observation, duration, is_error = await self._execute_tool_with_events(
                        act["action"], act["action_input"],
                        on_event, agent_logger, steps_taken + 1,
                    )
                    # Allow retry on next step if this call failed
                    if is_error:
                        _previous_calls.discard(call_key)
                    truncated_obs = _truncate_observation(observation, tool_name=act["action"], budget_tokens=self.budget.scratchpad)
                    scratchpad.add_step(
                        thought=thought, action=act["action"],
                        action_input=act["action_input"], observation=truncated_obs,
                    )
                    if act["action"] == "create_output":
                        has_output_write = True

                    # ask_user: emit special SSE event for the client
                    if act["action"] == "ask_user" and "question" in str(observation):
                        await self._emit(on_event, "ask_user", act["action_input"])
                else:
                    parallel_count = len(to_execute)
                    log.info(f"Parallel execution: {parallel_count} tools")
                    await self._emit(on_event, "thinking", {
                        "thought": f"[Executing {parallel_count} tools in parallel]",
                    })

                    # Bounded fan-out — see agents/parallelism.py. Over the cap
                    # the extra calls queue instead of all firing at once.
                    async def _run_one(act):
                        async with slot(_tool_slots):
                            return await self._execute_tool_with_events(
                                act["action"], act["action_input"],
                                on_event, agent_logger, steps_taken + 1,
                            )

                    tasks = [_run_one(act) for act, _ in to_execute]
                    results = await asyncio.gather(*tasks)

                    for (act, call_key), (observation, duration, is_error) in zip(to_execute, results):
                        # Allow retry on next step if this call failed
                        if is_error:
                            _previous_calls.discard(call_key)
                        truncated_obs = _truncate_observation(observation, tool_name=act["action"], budget_tokens=self.budget.scratchpad)
                        scratchpad.add_step(
                            thought=f"[parallel] {thought}" if parallel_count > 1 else thought,
                            action=act["action"],
                            action_input=act["action_input"],
                            observation=truncated_obs,
                        )
                        if act["action"] == "create_output":
                            has_output_write = True

                # ── Auto-consume after output write ─────────────
                # When create_output is called, the read_file /
                # batch_read_files observations that fed into it are
                # no longer needed. Mark all prior steps as consumed
                # so the scratchpad compressor drops their observations.
                # This is Claude Code's "drop tool_result content for
                # already-processed files" approach.
                if has_output_write:
                    current_step_count = scratchpad.step_count()
                    scratchpad.mark_consumed_before(current_step_count - 1)
                    log.info(f"Marked {current_step_count - 1} steps as consumed after create_output")

                steps_taken += 1

            # Loop ended without final_answer — context exhausted,
            # stall detected, or hard ceiling hit.
            if scratchpad_tokens > self.budget.scratchpad * 0.95:
                stop_reason = "context_exhausted"
            elif stall_count >= STALL_LIMIT:
                stop_reason = "stall_detected"
            else:
                stop_reason = "hard_ceiling"

            log.info(f"Loop ended: {stop_reason} after {steps_taken} steps")
            partial = self._build_partial_answer(input, scratchpad)
            await self._emit(on_event, "final", {"answer": partial})
            return {
                "status": stop_reason, "answer": partial,
                "steps_taken": steps_taken, "usage": usage_totals,
            }

        except AgentStopped:
            await self._emit(on_event, "stopped", {"steps_taken": steps_taken})
            return {
                "status": "stopped",
                "answer": "Run was stopped before completion.",
                "steps_taken": steps_taken, "usage": usage_totals,
            }

    def _build_partial_answer(self, original_input: str, scratchpad: ShortTermMemory) -> str:
        """
        Build a user-readable partial answer when the agent couldn't
        produce a final_answer (LLM error or max_steps reached).

        Extracts UNIQUE tool results (not the agent's internal
        thoughts) and presents them as structured findings. This is
        what the user sees, so it must answer their question as best
        as possible with whatever was gathered.
        """
        # Extract unique observations from the scratchpad
        # Steps are: Thought, Action, Action Input, Observation (4 per cycle)
        findings = []
        seen_actions = set()

        for i in range(0, len(scratchpad.steps), 4):
            if i + 3 >= len(scratchpad.steps):
                break

            action_line = scratchpad.steps[i + 1]  # "Action: ..."
            obs_line = scratchpad.steps[i + 3]      # "Observation: ..."

            action = action_line.replace("Action: ", "", 1)
            obs = obs_line.replace("Observation: ", "", 1)

            # Skip duplicates and errors
            if action in seen_actions and action in ("list_directory", "file_search"):
                continue
            if obs.startswith("DUPLICATE:") or obs.startswith("Error"):
                continue
            seen_actions.add(action)

            # Extract useful info from each tool type
            if action == "list_directory":
                findings.append(_extract_directory_summary(obs))
            elif action == "read_file":
                findings.append(_extract_file_summary(obs))
            elif action == "grep_search":
                findings.append(f"**Search results:** {obs[:300]}")
            elif action == "file_search":
                findings.append(f"**Files found:** {obs[:300]}")
            elif action == "create_output":
                findings.append(f"**File created:** {obs[:200]}")
            else:
                findings.append(f"**{action}:** {obs[:200]}")

        # Build the answer
        parts = []
        if findings:
            parts.append(f"Here's what I found for: *{original_input}*\n")
            for f in findings:
                parts.append(f)
            # Check if user asked for a file that wasn't created
            input_lower = original_input.lower()
            asked_for_file = any(w in input_lower for w in [".md", "create", "generate", "report", "write", "make"])
            if asked_for_file and "create_output" not in seen_actions:
                parts.append(
                    "\n> **Note:** You asked for a file to be created, but the "
                    "agent ran out of steps before writing it. Please try again "
                    "— the agent now has better instructions to create the file "
                    "within fewer steps."
                )
        else:
            parts.append(
                f"I was working on: *{original_input}*\n\n"
                "The process ended before enough information could be gathered. "
                "Please try again."
            )

        return "\n\n".join(parts)


def _extract_directory_summary(obs: str) -> str:
    """Pull a clean directory listing from a list_directory observation."""
    # The observation is a stringified dict like: {'path': '.', 'entries': [...]}
    try:
        import ast
        data = ast.literal_eval(obs) if obs.startswith("{") else {}
        path = data.get("path", ".")
        entries = data.get("entries", [])
        if entries:
            dirs = [e["name"] for e in entries if e.get("type") == "dir"]
            files = [e["name"] for e in entries if e.get("type") == "file"]
            parts = [f"**Directory `{path}/`:**"]
            if dirs:
                parts.append("  Folders: " + ", ".join(dirs[:10]))
            if files:
                parts.append("  Files: " + ", ".join(files[:10]))
            return "\n".join(parts)
    except Exception:
        pass
    return f"**Directory listing:** {obs[:200]}"


def _extract_file_summary(obs: str) -> str:
    """Pull file path and first few lines from a read_file observation."""
    import re

    # Try to extract path and line count with regex (works even when
    # ast.literal_eval fails on complex escaped content)
    path_match = re.search(r"'path':\s*'([^']+)'", obs)
    lines_match = re.search(r"'total_lines':\s*(\d+)", obs)

    path = path_match.group(1) if path_match else "unknown"
    total = lines_match.group(1) if lines_match else "?"

    # Try to extract content preview
    content_match = re.search(r"'content':\s*'(.+?)(?:',\s*'size'|',\s*'total_lines'|\}$)", obs, re.DOTALL)
    if content_match:
        content = content_match.group(1)
        # Show first 5 lines only
        lines = content.replace("\\n", "\n").split("\n")[:5]
        preview = "\n".join(lines)
        return f"**File `{path}` ({total} lines):**\n```\n{preview}\n```"

    return f"**File `{path}` ({total} lines)**"


# ── Module-level helpers ─────────────────────────────────────────

# Fallback observation limits used when no budget is available.
# These are conservative defaults for an 8 K context window.
_DEFAULT_OBSERVATION_TOKENS = 500    # ~2 000 chars
_DEFAULT_BATCH_READ_TOKENS  = 1500   # ~6 000 chars


def _truncate_observation(observation: str, tool_name: str = "", budget_tokens: int = None) -> str:
    """
    Truncate a tool observation to fit within the scratchpad budget.

    workspace_tree: extracts a COMPACT file list (path + hint per line)
    so ALL files fit in the scratchpad.

    batch_read_files: gets a 3× higher limit than single observations.

    Other tools: 5% of the scratchpad budget per observation so the
    LLM can accumulate many results without overflowing context.

    budget_tokens: pass self.budget.scratchpad for dynamic limits.
    Falls back to conservative defaults when None.
    """
    if tool_name == "workspace_tree":
        return _compact_tree_observation(observation)

    if budget_tokens and budget_tokens > 0:
        # Single obs: ≤ 5% of scratchpad; batch reads: ≤ 15%.
        # Floor values ensure tiny budgets stay usable.
        single_tokens = max(300, budget_tokens // 20)
        batch_tokens  = max(800, budget_tokens // 7)
    else:
        single_tokens = _DEFAULT_OBSERVATION_TOKENS
        batch_tokens  = _DEFAULT_BATCH_READ_TOKENS

    max_tokens = batch_tokens if tool_name == "batch_read_files" else single_tokens
    max_len    = max_tokens * 4  # convert tokens → approximate chars

    if len(observation) <= max_len:
        return observation

    half = max_len // 2
    return (
        observation[:half]
        + f"\n\n... [truncated - {len(observation)} chars total] ...\n\n"
        + observation[-half:]
    )


def _compact_tree_observation(observation: str) -> str:
    """
    Convert workspace_tree's verbose dict output into a compact
    path-per-line format so ALL files fit in the scratchpad.

    Input:  {'path': '.', 'total_files': 138, 'files': [{'path': 'a.py', 'hint': 'desc'}, ...]}
    Output:
      138 files found in workspace:
      Dockerfile | syntax=docker/dockerfile:1
      README.md | User Story Generator UI
      agent/__init__.py | Code Intelligence Agent
      agent/agent_models.py | Pydantic models for agent tasks
      ...
    """
    import re

    # Extract total_files
    total_match = re.search(r"'total_files':\s*(\d+)", observation)
    total = total_match.group(1) if total_match else "?"

    # Extract all (path, hint) pairs
    path_pattern = re.finditer(
        r"'path':\s*'([^']+)'[^}]*?(?:'hint':\s*'([^']*)')?",
        observation,
    )

    lines = [f"{total} files found in workspace:"]
    for match in path_pattern:
        path = match.group(1)
        hint = match.group(2) or ""
        # Skip the root path entry
        if path == ".":
            continue
        if hint:
            hint = hint[:80].replace("\n", " ")
            lines.append(f"{path} | {hint}")
        else:
            lines.append(path)

    return "\n".join(lines)
