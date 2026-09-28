"""Short-term scratchpad — per-run (thought, action, observation) tuples.

Rendered verbatim. Compression by token budget will land later; the storage
model already tracks `consumed` per step so nothing has to change here when
that arrives.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Step:
    thought: str
    observations: list[dict[str, Any]] = field(default_factory=list)
    consumed: bool = False


class Scratchpad:
    def __init__(self):
        self._steps: list[Step] = []

    def add(self, thought: str, observations: list[dict[str, Any]]) -> None:
        self._steps.append(Step(thought=str(thought), observations=list(observations)))

    def mark_all_consumed(self) -> None:
        for s in self._steps:
            s.consumed = True

    def step_count(self) -> int:
        return len(self._steps)

    def render(self) -> str:
        if not self._steps:
            return "(no prior steps in this run yet)"
        return "\n".join(_render_step(s, i + 1) for i, s in enumerate(self._steps))


def _render_step(step: Step, index: int) -> str:
    lines = [f"Step {index}:", f"  Thought: {step.thought}"]
    for obs in step.observations:
        tool = obs.get("tool", "?")
        inp = obs.get("input", {})
        try:
            inp_text = json.dumps(inp, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            inp_text = str(inp)
        lines.append(f"  Action: {tool}({inp_text})")
        lines.append(f"  Observation: {obs.get('observation', '')}")
    return "\n".join(lines)
