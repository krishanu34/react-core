"""
Ask User Tool — The "Interrupt, Steer, or Add Context" Arrow

From the Claude Code agentic loop diagram:

  Your prompt → Gather context → Take action → Verify results → Done
                                      ↑
                        You: interrupt, steer, or add context

This tool enables the agent to ASK the user a question mid-task
when it hits ambiguity or needs a decision. The agent pauses,
the question goes to the client via SSE, and the user's answer
comes back in the next message.

In Claude Code, AskUserQuestion blocks the terminal until the
user types an answer. In our HTTP streaming architecture:
  1. Tool returns the question as an observation
  2. Agent emits SSE event type "ask_user" with the question
  3. Agent produces a final_answer that includes the question
  4. User's response comes as the next POST /api/agent/stream
  5. The agent resumes with the answer in conversation memory

This is the cooperative async equivalent of Claude Code's
synchronous terminal blocking.
"""

from .base_tool import BaseTool
from .ask_user_schema import (
    MAX_QUESTIONS,
    QuestionSet,
    strict_response_format,
)


class AskUserTool(BaseTool):

    # The tool emits the `ask_user` SSE event ITSELF (via on_event) so the UI
    # receives the EXPANDED question set. Previously the agent loop emitted the
    # event from the tool *arguments*, so the expander's completed questions
    # never reached the client — the card only showed the original question.
    SUPPORTS_STREAMING = True

    name = "ask_user"

    def __init__(self, workspace: str, long_term_memory=None, llm=None):
        super().__init__(workspace)
        self._memory = long_term_memory
        # Question-set completion (Copilot/Claude style). When the model asks
        # anything, the tool makes ONE llm call to complete the question set for
        # the current task — so a vague request gets ALL its clarifications in a
        # single card instead of question-by-question ping-pong. The trigger is
        # the model's own decision to ask (organic — no vagueness heuristic that
        # could misfire on small questions); the completeness is code-guaranteed.
        self._llm = llm
        self._task_context: str = ""   # set per-run by the agent
        self._expanded_once = False    # registry is per-request → per-run state

    def set_task_context(self, user_input: str) -> None:
        """Called by the agent at run start so expansion knows the original task."""
        self._task_context = (user_input or "")[:2000]
        self._expanded_once = False

    description = (
        "Ask the user for clarification, a decision, or missing context. "
        "PREFER the `questions` array to ask EVERYTHING you need AT ONCE "
        "(GitHub Copilot / Claude style) — e.g. frontend, backend, and database "
        "in a single call — instead of asking one question per turn. Use the "
        "single `question` form only when there is exactly one thing to clarify. "
        "Include 2-4 options per question when possible."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": (
                        "PREFERRED: ask ALL your clarifying questions at once. Each "
                        "item is one question with its own options. Use this whenever "
                        "you need more than one decision — never ask one at a time. "
                        "Example: [{'question':'Which frontend?','options':['React','Vue']}, "
                        "{'question':'Which database?','options':['PostgreSQL','MongoDB']}]"
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string", "description": "The question text."},
                            "options": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "2-4 choices for this question.",
                            },
                            "allow_multiple": {
                                "type": "boolean",
                                "description": "True if the user may select several options.",
                            },
                        },
                        "required": ["question"],
                    },
                },
                "question": {
                    "type": "string",
                    "description": (
                        "Single-question form — use `questions` instead when you have "
                        "2 or more. Example: 'Which database: PostgreSQL or MySQL?'"
                    )
                },
                "options": {
                    "type": "array",
                    "description": "Options for the single `question` form (2-4 choices).",
                    "items": {"type": "string"}
                },
                "context": {
                    "type": "string",
                    "description": (
                        "Optional context explaining WHY you need this information."
                    )
                }
            },
        }

    def _normalize(self, question, options, questions):
        """Return validated [{question, options, allow_multiple}] from either
        form. All shaping rules (caps, coercion, dedupe, drop-bad-items) live
        in the QuestionSet pydantic schema — the single source of truth shared
        with the expander and the agent's clarification fallback."""
        if isinstance(questions, list) and questions:
            candidates = questions
        elif question:
            candidates = [{"question": question, "options": options or []}]
        else:
            candidates = []
        return QuestionSet.model_validate({"questions": candidates}).as_payload()

    async def _maybe_expand(self, qs):
        """
        Complete the question set with ONE llm call — at most once per run.

        Given the original task and the model's proposed question(s), ask a
        checker to return the minimal COMPLETE set (max 4, options-first,
        keep the originals, no nice-to-know questions). This is what makes
        "which backend?" on a vague build request come back as ONE card with
        frontend + backend + database + auth, instead of four turns.

        Never blocks: any failure returns the original questions unchanged.
        """
        if self._llm is None or not self._task_context or self._expanded_once:
            return qs
        self._expanded_once = True

        import json
        try:
            from prompts.loader import PromptLoader
            from llm.structured_output import extract_json

            prompt = PromptLoader.load(
                "ask_user_expander",
                user_request=self._task_context,
                max_questions=MAX_QUESTIONS,
                proposed_questions=json.dumps(
                    [{"question": q["question"], "options": q["options"]} for q in qs]
                ),
            )
            msgs = [{"role": "user", "content": prompt}]
            try:
                # Strict structured outputs: Azure guarantees the response IS
                # valid JSON matching the QuestionSet schema — no fences, no
                # preamble, no missing keys.
                text, _usage = await self._llm.invoke(
                    msgs, temperature=0.0, max_tokens=600,
                    response_format=strict_response_format(),
                )
            except Exception:
                # Deployment/api-version without structured-outputs support —
                # retry prompt-only and rely on defensive extraction below.
                text, _usage = await self._llm.invoke(
                    msgs, temperature=0.0, max_tokens=600,
                )
            data = extract_json(text)
            expanded = QuestionSet.model_validate(
                {"questions": data.get("questions")}
            ).as_payload()
            # Sanity: use the expansion only if it still contains at least one
            # valid question after schema validation. Otherwise keep the
            # original set — expansion must never lose the model's question.
            if expanded:
                return expanded
        except Exception:
            pass  # expansion is best-effort — the original questions still ship
        return qs

    async def run(self, question=None, options=None, context=None, questions=None, on_event=None):
        qs = self._normalize(question, options, questions)
        if not qs:
            return {"error": "ask_user needs a `question` or a non-empty `questions` array."}

        # Complete the set (once per run) so the user answers everything in one card.
        qs = await self._maybe_expand(qs)

        # Emit the structured card to the client with the EXPANDED questions.
        if on_event is not None:
            payload = {"questions": qs, "question": qs[0]["question"]}
            if qs[0]["options"]:
                payload["options"] = qs[0]["options"]
            if context:
                payload["context"] = context
            maybe = on_event("ask_user", payload)
            if maybe is not None:
                await maybe

        # Human-readable block the model should echo in its final answer.
        blocks = []
        for i, q in enumerate(qs, 1):
            line = f"{i}. {q['question']}" if len(qs) > 1 else q["question"]
            if q["options"]:
                opts = "\n".join(f"   - {o}" for o in q["options"])
                line += f"\n{opts}"
            blocks.append(line)
        formatted = "\n\n".join(blocks)
        if context:
            formatted = f"Context: {context}\n\n{formatted}"

        result = {
            "status": "question_asked",
            "questions": qs,                       # structured — the UI renders this
            "formatted": formatted,
            "instruction": (
                "IMPORTANT: Include ALL these questions in your final_answer so the "
                "user sees them. Their combined answers come in the next message. "
                "Do NOT call ask_user again for the same task — ask everything now."
            ),
        }
        # Back-compat single-question fields.
        if len(qs) == 1:
            result["question"] = qs[0]["question"]
            if qs[0]["options"]:
                result["options"] = qs[0]["options"]
        if context:
            result["context"] = context

        # Persist so a later "use option 1 / React / MERN" resolves even after
        # history is compressed or the server restarts.
        if self._memory is not None:
            mem = "Pending questions:\n" + formatted
            self._memory.add(mem, tags=["ask_user", "pending"])

        return result
