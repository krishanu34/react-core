"""
Planner Agent

Takes a complex task description and produces an ORDERED LIST of
steps (see prompts/planner_agent.md for the exact JSON shape), each
of which is later handed one-at-a-time to a ReActAgent for actual
execution (see agent/orchestrator.py for how the two connect).

Why a separate agent instead of folding this into ReActAgent?
Planning and executing are different jobs with different failure
modes. A planner makes ONE LLM call and returns a static list - it
never touches tools, never loops, never needs a max_steps cap. A
ReAct agent loops indefinitely (up to max_steps) calling tools and
reacting to their output. Mixing these into one class would mean
every change to "how do we call tools" risks breaking "how do we
plan", and vice versa. Same reasoning BaseAgent already encodes by
making run() abstract - different agents, different run()s.

This agent makes exactly one LLM call (not a loop), so it doesn't
need a should_stop callback the way ReActAgent does - there's no
multi-step loop to interrupt mid-flight. If you DO want planning to
be cancellable, that has to happen at the orchestrator level instead
(skip calling plan() at all).
"""

from .base_agent import BaseAgent
from prompts.loader import PromptLoader
from llm.structured_output import extract_json, StructuredOutputError


class PlannerAgent(BaseAgent):
    """
    Single-shot planner: task description in, ordered list of steps
    out. Does not execute anything itself.
    """

    def __init__(self, llm, tool_registry=None, memory=None, token_tracker=None):
        tools = tool_registry.list_tools() if tool_registry else []
        super().__init__(llm, tools, memory)
        self.tool_registry = tool_registry
        self.token_tracker = token_tracker

    def _tool_descriptions(self):
        if self.tool_registry is not None:
            return self.tool_registry.descriptions_text()
        if not self.tools:
            return "(no tools available)"
        return "\n".join(f"- {tool.name}: {tool.description}" for tool in self.tools)

    async def run(self, input, memory_context: str = ""):
        """
        input here is the task description (the user's request, or
        the orchestrator's elaboration of it) to break into steps.

        Returns a dict:
            {
              "status": "done" | "error",
              "plan_summary": str,
              "steps": [{"id": int, "description": str, "rationale": str}, ...],
              "usage": {"prompt_tokens": int, "completion_tokens": int, "total_tokens": int},
              "raw_error": str  # only present if status == "error"
            }
        """
        system_prompt = PromptLoader.load(
            "planner_agent",
            task_description=input,
            tool_descriptions=self._tool_descriptions(),
            memory_context=memory_context or "(no prior memory for this thread)",
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": input},
        ]

        raw_response, raw_usage = await self.llm.invoke(messages)

        usage = {
            "prompt_tokens": raw_usage.get("prompt_tokens", 0),
            "completion_tokens": raw_usage.get("completion_tokens", 0),
            "total_tokens": raw_usage.get("total_tokens", 0),
        }
        if self.token_tracker is not None:
            model = getattr(self.llm, "deployment", "unknown")
            self.token_tracker.record_usage(raw_usage, model=model)

        try:
            parsed = extract_json(raw_response)
        except StructuredOutputError as e:
            return {
                "status": "error",
                "plan_summary": "",
                "steps": [],
                "usage": usage,
                "raw_error": str(e),
            }

        steps = parsed.get("steps", [])
        # Defensive normalization: make sure every step at least has
        # the three fields callers expect, even if the model left one
        # out, rather than letting a downstream KeyError crash the
        # orchestrator over a minor formatting slip.
        normalized_steps = []
        for i, step in enumerate(steps, start=1):
            if isinstance(step, dict):
                normalized_steps.append({
                    "id": step.get("id", i),
                    "description": step.get("description", ""),
                    "rationale": step.get("rationale", ""),
                })
            else:
                normalized_steps.append({"id": i, "description": str(step), "rationale": ""})

        if self.memory:
            self.memory.add(
                content=f"Plan for: {input}\nSummary: {parsed.get('plan_summary', '')}",
                tags=["plan"],
            )

        return {
            "status": "done",
            "plan_summary": parsed.get("plan_summary", ""),
            "steps": normalized_steps,
            "usage": usage,
        }
