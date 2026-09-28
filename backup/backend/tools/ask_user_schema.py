"""
Ask-User Question Schema — the ONE definition of a clarification card.

Three different producers feed questions into the ask_user card:
  1. The model's own tool-call arguments (questions=[...])
  2. The expander LLM's completed question set (ask_user_expander.md)
  3. The agent's clarification fallback (regex-extracted from plain text)

Before this module each path did its own ad-hoc dict munging; a malformed
item (missing key, wrong type, giant option string) was silently shaped by
whichever code path saw it first. Now everything is validated through the
same pydantic models, and the expander call also sends the matching STRICT
json_schema response_format so Azure guarantees well-formed JSON on the
wire — pydantic then enforces the semantic rules (caps, non-empty, dedupe).

Validation philosophy: coerce and drop, never crash. A bad question item
is skipped; a bad option is skipped; an over-long list is truncated. The
card must always ship — a lost clarification is worse than a trimmed one.
"""

import os

from pydantic import BaseModel, Field, field_validator

# One clarification card, at most this many questions / options per question.
# 4/4 mirrors Claude Code's own AskUserQuestion schema limits — beyond that a
# card feels like a form; larger tasks should get defaults + stated assumptions
# instead of more questions. Configurable per deployment via env.
MAX_QUESTIONS = max(1, int(os.getenv("ASK_USER_MAX_QUESTIONS", "4")))
MAX_OPTIONS = max(2, int(os.getenv("ASK_USER_MAX_OPTIONS", "4")))

# Keep individual strings sane — a 500-char "option" is prose, not a choice.
MAX_QUESTION_CHARS = 300
MAX_OPTION_CHARS = 80


class ClarifyQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    options: list[str] = Field(default_factory=list)
    allow_multiple: bool = False

    @field_validator("question", mode="before")
    @classmethod
    def _coerce_question(cls, v):
        return str(v).strip()[:MAX_QUESTION_CHARS] if v is not None else v

    @field_validator("options", mode="before")
    @classmethod
    def _clean_options(cls, v):
        if not isinstance(v, (list, tuple)):
            return []
        seen, out = set(), []
        for o in v:
            s = str(o).strip()
            if s and len(s) <= MAX_OPTION_CHARS and s.lower() not in seen:
                seen.add(s.lower())
                out.append(s)
        return out[:MAX_OPTIONS]


class QuestionSet(BaseModel):
    questions: list[ClarifyQuestion] = Field(default_factory=list)

    @field_validator("questions", mode="before")
    @classmethod
    def _drop_invalid_items(cls, v):
        """Validate item-by-item so one malformed entry doesn't sink the set."""
        if not isinstance(v, (list, tuple)):
            return []
        kept = []
        for item in v:
            try:
                kept.append(ClarifyQuestion.model_validate(item))
            except Exception:
                continue  # coerce-and-drop: a bad item never blocks the card
        return kept[:MAX_QUESTIONS]

    def as_payload(self) -> list:
        """The plain-dict shape the SSE event / UI expects."""
        return [q.model_dump() for q in self.questions]


def strict_response_format() -> dict:
    """
    OpenAI/Azure strict structured-outputs schema matching QuestionSet.

    Written by hand (not model_json_schema()) because strict mode demands
    additionalProperties:false and every property listed in required —
    pydantic's generated schema doesn't satisfy that for optional fields.
    """
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "question_set",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "options": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                                "allow_multiple": {"type": "boolean"},
                            },
                            "required": ["question", "options", "allow_multiple"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["questions"],
                "additionalProperties": False,
            },
        },
    }
