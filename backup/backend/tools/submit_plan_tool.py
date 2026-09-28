"""
Submit Plan Tool — Claude Code-style structured plan handoff.

Claude Code never parses a plan out of the model's prose: the model ends
plan mode by CALLING a tool whose schema-validated argument IS the plan
(ExitPlanMode). This tool is our equivalent for the spec-mode roster
phase: instead of formatting stacked frontmatter in its final answer (and
hoping it parses), the model calls submit_plan with the plan as typed
JSON — native function calling enforces the schema, so "the plan arrived
as prose" structurally cannot happen.

SpecWorkflow registers this tool for spec runs only, resets it before the
roster phase, and reads `captured` after the run. The old text-parsing
normalization ladder remains as the fallback for turns where the model
never calls the tool.
"""

from .base_tool import BaseTool

_ARTIFACT_TYPES = ["template", "task", "checklist", "workflow", "data"]


class SubmitPlanTool(BaseTool):

    name = "submit_plan"

    description = (
        "Submit your FINAL generation plan (agents, skills, other BMAD "
        "artifacts) as structured data. This is HOW the plan is delivered — "
        "planning turns MUST end with exactly one submit_plan call. After "
        "calling it, finish with a short 2-4 line summary for the reviewer; "
        "do NOT also write the plan out as text."
    )

    def __init__(self, workspace: str):
        super().__init__(workspace)
        self.captured: dict | None = None

    def reset(self) -> None:
        self.captured = None

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "One line: what will be created and why.",
                },
                "target": {
                    "type": "string",
                    "enum": ["devaccel", "claude", "copilot", "bmad"],
                    "description": "Folder convention for the generated files "
                                   "(use the target you were given).",
                },
                "agents": {
                    "type": "array",
                    "description": "The agent(s) to create — usually ONE for a "
                                   "focused request. Names kebab-case, derived "
                                   "from the request domain.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "kebab-case slug, 2-4 words — becomes the filename"},
                            "description": {
                                "type": "string",
                                "description": "One line, shown before anyone decides "
                                               "to load this agent. Write it as a "
                                               "TRIGGER covering both routes: what the "
                                               "user will ask for, and the persona's "
                                               "name. e.g. 'Owns schema migrations. "
                                               "Use when the user asks to migrate a "
                                               "table, or asks to talk to Winston.'",
                            },
                            "persona_name": {
                                "type": "string",
                                "description": "The agent's human first name (Mary, "
                                               "Winston, Amelia) — how the user "
                                               "addresses it. NOT the slug.",
                            },
                            "title": {
                                "type": "string",
                                "description": "The job title, e.g. 'Principal "
                                               "Database Engineer'.",
                            },
                            "icon": {"type": "string", "description": "One emoji for this role"},
                            "when_to_use": {
                                "type": "string",
                                "description": "One line naming the situations that "
                                               "should route here, including the "
                                               "persona's name.",
                            },
                            "tools": {
                                "type": "array", "items": {"type": "string"},
                                "description": "Preferred tool names for this role. Advisory only: other available tools may be used when the task requires them.",
                            },
                            "skills": {
                                "type": "array", "items": {"type": "string"},
                                "description": "Names of skills (below) this agent loads",
                            },
                            "persona": {
                                "type": "string",
                                "description": "The agent's operating brief, 4-10 "
                                               "lines: what it owns, how it works "
                                               "step by step, standards, what it must "
                                               "never touch, how it verifies its work",
                            },
                        },
                        "required": ["name", "description", "persona",
                                     "persona_name", "title"],
                    },
                },
                "skills": {
                    "type": "array",
                    "description": "Reusable know-how the agents rely on (1-3 "
                                   "typically). Skills the user named MUST appear.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "kebab-case"},
                            "description": {"type": "string", "description": "One line"},
                            "instructions": {"type": "string", "description": "The knowledge, in brief — expanded at scaffold"},
                        },
                        "required": ["name", "description"],
                    },
                },
                "artifacts": {
                    "type": "array",
                    "description": "OTHER BMAD artifacts ONLY when the request "
                                   "needs them (never pad): template = recurring "
                                   "structured document; task = reusable procedure; "
                                   "checklist = quality gate; workflow = multi-agent "
                                   "sequence; data = reference knowledge.",
                    "items": {
                        "type": "object",
                        "properties": {
                            # Not an enum: the known types cover most requests,
                            # but a workspace may genuinely need a kind we
                            # never listed (orchestration, policy, runbook).
                            # Scaffold gives an unknown type its own folder,
                            # and discovery finds it like any other file.
                            "type": {
                                "type": "string",
                                "description": "Usually one of: "
                                               + ", ".join(_ARTIFACT_TYPES)
                                               + ". Another kebab-case kind is "
                                                 "allowed when the request truly "
                                                 "needs one.",
                            },
                            "name": {"type": "string", "description": "kebab-case"},
                            "description": {"type": "string", "description": "One line"},
                            "owner": {
                                "type": "string",
                                "description": "The exact name of the SKILL (or "
                                               "agent) this artifact serves. The "
                                               "file is written inside that "
                                               "owner's folder, so the tree "
                                               "shows what belongs to what. "
                                               "Always set this — an artifact "
                                               "that serves nothing is an "
                                               "artifact nobody will find.",
                            },
                            "instructions": {"type": "string", "description": "Content brief — expanded at scaffold"},
                        },
                        "required": ["type", "name", "description", "owner"],
                    },
                },
            },
            "required": ["summary", "target", "agents"],
        }

    async def run(self, **kwargs) -> dict:
        agents = kwargs.get("agents")
        if not isinstance(agents, list) or not agents:
            return {"error": "submit_plan needs a non-empty 'agents' array."}
        self.captured = kwargs
        return {
            "status": "plan_submitted",
            "agents": [a.get("name") for a in agents if isinstance(a, dict)],
            "instruction": (
                "Plan captured. Finish your turn NOW with a 2-4 line summary "
                "for the reviewer — do not repeat the plan and do not call "
                "submit_plan again."
            ),
        }
