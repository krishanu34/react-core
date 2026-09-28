"""
Short-Term Memory (Scratchpad)

Holds the Thought/Action/Observation steps for ONE agent.run() call.
Does not survive between different run() calls, never written to disk.

Three-tier compression:
  - CONSUMED steps: already written to output file -> ultra-compact
    "Step 3: read_file(a.py) -> [written to output]"
  - OLD steps: not consumed but not recent -> one-line summary
    "Step 5: read_file(b.py) -> Found 45 lines, FastAPI router..."
  - RECENT steps (last 3-5): kept verbatim with full observations

This mirrors Claude Code's message-level context management:
  - Drop tool_result content for already-processed files
  - Summarize older messages
  - Keep recent messages verbatim
"""

from dataclasses import dataclass, field
from typing import Any, Optional
from context.token_estimator import estimate_tokens


@dataclass
class Step:
    """One complete Thought -> Action -> Observation cycle."""
    thought: str
    action: str
    action_input: Any
    observation: str
    consumed: bool = False
    _tokens: Optional[int] = field(default=None, repr=False)

    @property
    def tokens(self) -> int:
        if self._tokens is None:
            self._tokens = estimate_tokens(self.as_text())
        return self._tokens

    def as_text(self) -> str:
        return (
            f"Thought: {self.thought}\n"
            f"Action: {self.action}\n"
            f"Action Input: {self.action_input}\n"
            f"Observation: {self.observation}"
        )

    def as_summary(self, max_chars: int = 100) -> str:
        obs_preview = self.observation[:max_chars].replace("\n", " ")
        if len(self.observation) > max_chars:
            obs_preview += "..."
        return f"Used {self.action} -> {obs_preview}"

    def as_consumed(self) -> str:
        return f"Used {self.action} -> [already written to output]"


class ShortTermMemory:
    """
    The agent's working notepad for a single task.

    Structured steps instead of a flat text list — enables per-step
    token counting, consumed tracking, and tiered compression.
    """

    def __init__(self):
        self._steps: list[Step] = []

    @property
    def steps(self) -> list[str]:
        """Backward-compatible flat list for _build_partial_answer."""
        flat = []
        for step in self._steps:
            flat.append(f"Thought: {step.thought}")
            flat.append(f"Action: {step.action}")
            flat.append(f"Action Input: {step.action_input}")
            flat.append(f"Observation: {step.observation}")
        return flat

    def add_step(self, thought, action, action_input, observation):
        self._steps.append(Step(
            thought=str(thought),
            action=str(action),
            action_input=action_input,
            observation=str(observation),
        ))

    def step_count(self) -> int:
        return len(self._steps)

    def mark_consumed_before(self, step_index: int):
        """
        Mark all steps before step_index as consumed.

        Call this after create_output writes a batch — the read_file /
        batch_read_files observations that fed into that output are no
        longer needed in the scratchpad.
        """
        for i in range(min(step_index, len(self._steps))):
            self._steps[i].consumed = True

    def mark_all_consumed(self):
        """Mark all current steps as consumed (output was just written)."""
        for step in self._steps:
            step.consumed = True

    def total_tokens(self) -> int:
        """Total tokens across all steps (uses per-step caching)."""
        return sum(step.tokens for step in self._steps)

    def as_text(self) -> str:
        if not self._steps:
            return ""
        return "\n".join(step.as_text() for step in self._steps)

    def as_text_compressed(self, token_budget: int, keep_recent: int = 3) -> str:
        """
        Three-tier compression:

        1. CONSUMED steps -> ultra-compact (just action + "[written to output]")
        2. OLD steps -> one-line summary (action + first 100 chars of observation)
        3. RECENT steps -> full verbatim text

        This is the Claude Code approach: drop tool_result content
        for already-processed files, summarize old messages, keep
        recent messages verbatim.
        """
        if not self._steps:
            return ""

        total = len(self._steps)
        has_consumed = any(s.consumed for s in self._steps)

        # If everything fits AND nothing is consumed, return full text.
        # Consumed steps are ALWAYS compressed regardless of budget —
        # their data has been written to output and is no longer relevant.
        full_text = self.as_text()
        if not has_consumed and estimate_tokens(full_text) <= token_budget:
            return full_text

        # Split into tiers
        recent_start = max(0, total - keep_recent)
        old_steps = self._steps[:recent_start]
        recent_steps = self._steps[recent_start:]

        # Per-step summary char limit derived from budget: give each old step
        # an equal share of 20% of the token budget (the summary block should
        # be compact). Clamp between 40 chars (readable) and 200 (one-liner).
        if old_steps and token_budget > 0:
            step_summary_chars = max(40, min(200, (token_budget * 4 // 5) // len(old_steps)))
        else:
            step_summary_chars = 100  # default one-liner length

        # Tier 1 & 2: consumed -> ultra-compact, old -> one-liner
        summary_lines = []
        if old_steps:
            summary_lines.append("## Earlier steps (summarized)")
            for i, step in enumerate(old_steps):
                step_num = i + 1
                if step.consumed:
                    summary_lines.append(f"Step {step_num}: {step.as_consumed()}")
                else:
                    summary_lines.append(f"Step {step_num}: {step.as_summary(step_summary_chars)}")

        # Tier 3: recent -> full verbatim
        recent_lines = []
        if recent_steps:
            recent_lines.append("\n## Recent steps (full detail)")
            for step in recent_steps:
                recent_lines.append(step.as_text())

        compressed = "\n".join(summary_lines) + "\n".join(recent_lines)

        # If STILL over budget, reduce keep_recent
        if estimate_tokens(compressed) > token_budget and keep_recent > 0:
            return self.as_text_compressed(token_budget, keep_recent=keep_recent - 1)

        # Last resort: hard truncate
        if estimate_tokens(compressed) > token_budget:
            return _hard_truncate(compressed, token_budget)

        return compressed

    def per_step_token_report(self) -> list[dict]:
        """Token usage per step — useful for debugging context growth."""
        return [
            {
                "step": i + 1,
                "action": step.action,
                "tokens": step.tokens,
                "consumed": step.consumed,
            }
            for i, step in enumerate(self._steps)
        ]

    def clear(self):
        self._steps = []


def _hard_truncate(text: str, token_budget: int) -> str:
    target_chars = token_budget * 4
    if len(text) <= target_chars:
        return text
    return "[...earlier steps removed...]\n" + text[-target_chars:]
