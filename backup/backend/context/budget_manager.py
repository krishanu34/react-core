"""
Context Budget Manager

Allocates a token budget to each component of the LLM prompt
(system prompt + tools, user input, memory context, scratchpad) and
enforces those limits before every LLM call.

Usage pattern:
  1. Build your system prompt and serialise your tool schemas to JSON.
  2. Call measure_system_overhead(system_text, tools_json) to get the
     exact token cost of those two components.
  3. Pass that value to allocate_budget(system_overhead=...) so the
     remaining budget is split between memory and scratchpad correctly.
  4. Call fit_to_budget() before each LLM call to enforce the limits.

Budget allocation (128 K model, ~3 000 token system overhead example):
  Total: 128 000 tokens
  - System + tools: 3 000 (measured, not guessed)
  - Completion reserve: 1 500 (room for LLM response)
  - Available: 123 500
  - Memory context: 43 225 (35%)
  - Scratchpad: 80 275 (65%)
"""

from dataclasses import dataclass

from .token_estimator import estimate_tokens


@dataclass
class ContextBudget:
    """Token budget for each component of the LLM prompt."""
    model_context_window: int
    system_and_tools: int    # system prompt + tool descriptions (measured)
    user_input: int          # the user's original message (soft advisory)
    memory_context: int      # conversation history + long-term memory
    scratchpad: int          # ReAct steps (Thought/Action/Observation)
    completion_reserve: int  # tokens reserved for the LLM's response

    @property
    def total_prompt_budget(self) -> int:
        """Max tokens available for the prompt (excludes completion reserve)."""
        return self.model_context_window - self.completion_reserve


def measure_system_overhead(system_text: str = "", tools_text: str = "") -> int:
    """
    Measure the actual token cost of the system prompt + tool schemas.

    Call this after building the system prompt and serialising the tool
    schemas to JSON. Pass the result to allocate_budget(system_overhead=...)
    so that the remaining context budget is partitioned correctly.

    Example:
        import json
        overhead = measure_system_overhead(
            system_text=system_prompt,
            tools_text=json.dumps(tool_schemas),
        )
        budget = allocate_budget(context_window, system_overhead=overhead)
    """
    return estimate_tokens(system_text) + estimate_tokens(tools_text)


def allocate_budget(
    model_context_window: int = 128000,
    completion_reserve: int = 1500,
    system_overhead: int = None,
) -> ContextBudget:
    """
    Allocate token budgets for each prompt component.

    system_overhead: pass measure_system_overhead(system_text, tools_json)
    for the exact value. When None, a conservative 1 500-token default is
    used (covers typical system prompts + tool schemas for GPT-4-class
    models at 8 K context). For 128 K deployments with many tools the real
    overhead is typically 2 000–5 000 tokens, so always measure.

    DESIGN: The user's current message is NEVER capped — we compress
    HISTORY (old turns), not the present message. user_input budget is
    a soft advisory only (used for logging), not enforced.
    """
    if system_overhead is None:
        # Conservative default: system prompt (~700 tokens) + tool schemas
        # for ~20 tools (~800 tokens). Over-estimate to avoid overflow.
        system_overhead = 1500

    available = model_context_window - completion_reserve - system_overhead
    available = max(available, 2000)  # safety floor

    # 35% memory context (conversation history), 65% scratchpad (ReAct steps)
    memory_context = int(available * 0.35)
    scratchpad = available - memory_context

    # user_input has no hard cap — stored as advisory for logging only.
    user_input = available

    return ContextBudget(
        model_context_window=model_context_window,
        system_and_tools=system_overhead,
        user_input=user_input,
        memory_context=memory_context,
        scratchpad=scratchpad,
        completion_reserve=completion_reserve,
    )


def fit_to_budget(
    system_prompt: str,
    user_input: str,
    memory_context: str,
    scratchpad_text: str,
    budget: ContextBudget,
) -> tuple:
    """
    Ensure all components fit within their budgets. Returns
    (system_prompt, user_input, memory_context, scratchpad_text)
    with any necessary truncation applied.

    Truncation order (least important content cut first):
    1. Memory context — old messages can be summarized/truncated
    2. Scratchpad — last resort: cut oldest steps
    3. User input — NEVER truncated (current message always kept whole)
    4. System prompt — NEVER truncated (agent instructions)
    """
    # user_input is NEVER truncated — the current message is always kept whole.
    memory_context = _truncate_to_budget(memory_context, budget.memory_context, "[Memory truncated]")
    scratchpad_text = _truncate_to_budget(scratchpad_text, budget.scratchpad, "[Earlier steps truncated]")

    total = (
        estimate_tokens(system_prompt)
        + estimate_tokens(user_input)
        + estimate_tokens(memory_context)
        + estimate_tokens(scratchpad_text)
    )

    # If still over, aggressively cut scratchpad (the largest component)
    max_prompt = budget.total_prompt_budget
    while total > max_prompt and len(scratchpad_text) > 200:
        cut_point = len(scratchpad_text) // 5
        scratchpad_text = "[...earlier steps removed...]\n" + scratchpad_text[cut_point:]
        total = (
            estimate_tokens(system_prompt)
            + estimate_tokens(user_input)
            + estimate_tokens(memory_context)
            + estimate_tokens(scratchpad_text)
        )

    return system_prompt, user_input, memory_context, scratchpad_text


def _truncate_to_budget(text: str, token_budget: int, truncation_marker: str) -> str:
    """
    Truncate text to fit within a token budget. Cuts from the
    BEGINNING (oldest content) since recent content is more relevant.
    """
    if not text:
        return text

    if estimate_tokens(text) <= token_budget:
        return text

    target_chars = token_budget * 4
    if target_chars >= len(text):
        return text

    return truncation_marker + "\n" + text[-target_chars:]
