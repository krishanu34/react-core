"""Scaffold phase — agent-builder gate 2. Expands the approved roster.md
into the target folder convention — .devaccel by DEFAULT; another only
when the user named it in the request — so the generated agents are
reusable by the tool that owns that convention:

    target "devaccel" (default — DevSphere's own workspace):
        .devaccel/agents/<name>/AGENT.md            full agent
        .devaccel/agents/<name>/tasks/<x>.md        its tasks
        .devaccel/skills/<name>/SKILL.md            skill
        .devaccel/skills/<name>/checklists/<x>.md   its gates
        .devaccel/skills/<name>/templates/<x>.md    its templates
        .devaccel/skills/<name>/config.yaml         settings for THIS skill
        .devaccel/core-config.yaml                  settings shared by ALL

    A folder per agent and per skill, with that thing's supporting material
    inside it: opening one folder shows the method, its gates and its
    templates together. The only thing deliberately NOT nested is
    core-config.yaml — it is shared, resolved by walking UP from whichever
    skill is running, so a copy per skill would be one value maintained in
    five places. A skill that needs settings of its own gets a config.yaml
    in its folder, and the nearest config wins.

    target "claude" (Claude Code subagents + skills):
        .claude/agents/<name>.md              full agent
        .claude/skills/<name>/SKILL.md        skill

    target "copilot" (GitHub Copilot custom agents / agent profiles):
        .github/agents/<name>.agent.md        full agent
        .agents/skills/<name>/SKILL.md        skill (cross-tool root)

    target "bmad" (BMAD v6 skills architecture — canonical + stubs):
        .agents/skills/<name>/SKILL.md        canonical (agents AND skills)
        .github/agents/<name>.agent.md        Copilot stub ("LOAD the FULL …")
        .claude/skills/<name>/SKILL.md        Claude Code mirror

Whatever the target, DevSphere's discovery (custom_agent_registry + the
client scan) reads all of these locations, so the agents always show in
the Spec → Execution dropdown."""

from typing import List, Tuple

from .base import PhaseContext, SpecPhase
from .requirements import READ_TOOLS
from .roster import ROSTER_KEY

# kind → how the file's CONTENT is written (drives prompt + validation):
#   "full"   — complete agent definition (frontmatter + persona body)
#   "skill"  — SKILL.md knowledge file
#   "stub"   — BMAD-style Copilot stub pointing at the canonical SKILL.md
#   "mirror" — exact copy of the canonical file (not validated)
TARGET_LAYOUTS = {
    # One FOLDER per agent and per skill, with that thing's supporting
    # material nested inside it. Opening `.devaccel/skills/java-python/`
    # shows the method, its gates and its templates together — which is the
    # difference between a workspace with a dozen agents being navigable and
    # being a pile of files in four flat directories.
    "devaccel": {
        "agent": [("full", ".devaccel/agents/{name}/AGENT.md")],
        "skill": [("skill", ".devaccel/skills/{name}/SKILL.md")],
    },
    # BMAD artifact types the roster may additionally propose (dynamically,
    # per question). Whatever the agent/skill target, these are OUR workflow
    # material and always live under .devaccel — the BMAD-core layout mapped
    # into DevSphere's workspace (see prompts/spec/bmad_kb.md).
    # kind == roster block type; content format comes from the KB.
}
# An artifact lives INSIDE the skill or agent it serves:
#     .devaccel/skills/<owner>/checklists/<name>.md
# The folder in the middle is the whole point — it is what tells a reader
# which method this gate belongs to without opening a single file, and it is
# what discovery reads the ownership back off.
#
# `<kind>s` is derived, not enumerated, so an artifact type nobody has thought
# of yet gets a sensible home rather than being dropped.
OWNED_ARTIFACT_PATH = "{owner_dir}/{kind}s/{name}.md"
# A `settings` artifact is a config file, not a document: it keeps the
# `config.yaml` name so the parent-chain walk finds it, and lands directly in
# its owner's folder rather than in a `settingss/` subfolder. Settings that
# belong to ONE skill live with that skill; the nearest config wins, so it
# overrides just those keys and still inherits everything shared.
#
# The roster's own `type: config` block is the workflow's target selector, so
# this artifact kind is spelled `settings` to keep the two apart.
OWNED_SETTINGS_TYPE = "settings"
OWNED_CONFIG_PATH = "{owner_dir}/config.yaml"
# Fallback for an artifact the plan attributed to nobody — the workspace-level
# folders, which is where these used to live unconditionally.
ARTIFACT_PATHS = {
    "template":  ".devaccel/templates/{name}-tmpl.yaml",
    "task":      ".devaccel/tasks/{name}.md",
    "checklist": ".devaccel/checklists/{name}.md",
    "workflow":  ".devaccel/workflows/{name}.yaml",
    "data":      ".devaccel/data/{name}.md",
}
# Artifact kinds are an OPEN set (parsers.ROSTER_ARTIFACT_TYPES is "where we
# know to put things", not "what we accept"). A kind with no entry above —
# `orchestration`, `policy`, whatever a framework or the request invents —
# lands in a folder named after itself, where discovery finds it like any
# other file.
GENERIC_ARTIFACT_PATH = ".devaccel/{type}s/{name}.md"
CORE_CONFIG_PATH = ".devaccel/core-config.yaml"
TARGET_LAYOUTS.update({
    "claude": {
        "agent": [("full", ".claude/agents/{name}.md")],
        "skill": [("skill", ".claude/skills/{name}/SKILL.md")],
    },
    "copilot": {
        "agent": [("full", ".github/agents/{name}.agent.md")],
        "skill": [("skill", ".agents/skills/{name}/SKILL.md")],
    },
    "bmad": {
        "agent": [
            ("full", ".agents/skills/{name}/SKILL.md"),
            ("stub", ".github/agents/{name}.agent.md"),
            ("mirror", ".claude/skills/{name}/SKILL.md"),
        ],
        "skill": [
            ("skill", ".agents/skills/{name}/SKILL.md"),
            ("mirror", ".claude/skills/{name}/SKILL.md"),
        ],
    },
})
DEFAULT_TARGET = "devaccel"


def resolve_target(value: str) -> str:
    value = (value or "").strip().lower()
    return value if value in TARGET_LAYOUTS else DEFAULT_TARGET


class ScaffoldPhase(SpecPhase):
    name = "scaffold"
    gate = "gate2"
    produces = []  # dynamic — derived from the approved roster (output_paths)
    allow_tools = READ_TOOLS + ["file_write"]
    # Union fence over every target's roots + the BMAD artifact dirs — the
    # prompt pins the actual plan; validation catches wrong locations.
    allow_write_paths = [
        "*.devaccel/agents/*", "*.devaccel/skills/*",
        "*.devaccel/templates/*", "*.devaccel/tasks/*",
        "*.devaccel/checklists/*", "*.devaccel/workflows/*",
        "*.devaccel/data/*", "*.devaccel/core-config.yaml",
        "*.claude/agents/*", "*.claude/skills/*",
        "*.github/agents/*", "*.agents/skills/*",
    ]
    prompt_template = "scaffold"

    def _roster(self, ctx: PhaseContext, workspace: str = None) -> dict:
        """The approved plan from gate 1 — carried in memory (Claude Code
        plan-mode style), never a workspace file. To change the plan the
        user answers the gate with 'revise'; there is no file to edit."""
        from spec_driven.parsers import parse_roster

        return parse_roster(ctx.prior_files.get(ROSTER_KEY) or "")

    def _target(self, roster: dict, ctx: PhaseContext) -> str:
        # The roster's config block wins (it survives revise rounds and
        # user edits); the context carries the keyword-detected answer.
        return resolve_target(roster.get("config", {}).get("target") or ctx.target)

    def _plan(self, roster: dict, ctx: PhaseContext) -> List[Tuple[str, str, str]]:
        """[(kind, path, name)] — every file this scaffold must write.

        Agents and skills each get their own FOLDER, with their supporting
        artifacts nested inside it, so one folder tells the whole story.

        core-config.yaml is the exception and is deliberately NOT nested: it
        is shared by every agent and skill, resolved by walking up from
        whichever one is running. A copy per skill would be the same value
        maintained in five places. It is planned only when it does not
        already exist — regenerating it would discard the settings of every
        agent generated before this run."""
        layout = TARGET_LAYOUTS[self._target(roster, ctx)]
        plan: List[Tuple[str, str, str]] = []
        artifacts = roster.get("artifacts") or []
        if artifacts and self._read_local(ctx.workspace, CORE_CONFIG_PATH) is None:
            plan.append(("config", CORE_CONFIG_PATH, "core-config"))
        for agent in roster["agents"]:
            for kind, template in layout["agent"]:
                plan.append((kind, template.format(name=agent["name"]), agent["name"]))
        for skill in roster["skills"]:
            for kind, template in layout["skill"]:
                plan.append((kind, template.format(name=skill["name"]), skill["name"]))
        # Where each proposed skill/agent's folder is, so an artifact can be
        # written inside the one it serves.
        owner_dirs = {}
        for skill in roster["skills"]:
            for kind, template in layout["skill"]:
                if kind == "skill":
                    owner_dirs[skill["name"]] = template.format(
                        name=skill["name"]).rsplit("/", 1)[0]
        for agent in roster["agents"]:
            for kind, template in layout["agent"]:
                if kind == "full":
                    owner_dirs.setdefault(agent["name"], template.format(
                        name=agent["name"]).rsplit("/", 1)[0])

        for artifact in artifacts:
            owner_dir = owner_dirs.get(artifact.get("owner") or "")
            if owner_dir and not owner_dir.endswith("/agents") \
                    and not owner_dir.endswith("/skills"):
                # Nested under the skill or agent that uses it.
                path = (OWNED_CONFIG_PATH.format(owner_dir=owner_dir)
                        if artifact["type"] == OWNED_SETTINGS_TYPE
                        else OWNED_ARTIFACT_PATH.format(
                            owner_dir=owner_dir, kind=artifact["type"],
                            name=artifact["name"]))
            else:
                # Unowned, or a target whose layout keeps definitions as flat
                # files (no folder to nest into). A type we know gets its
                # conventional home; anything else gets a folder named after
                # the type, because dropping it would discard a decision the
                # roster gate already approved.
                path = (ARTIFACT_PATHS.get(artifact["type"])
                        or GENERIC_ARTIFACT_PATH.format(
                            type=artifact["type"], name="{name}")
                        ).format(name=artifact["name"])
            plan.append((artifact["type"], path, artifact["name"]))
        return plan

    def output_paths(self, ctx: PhaseContext) -> List[str]:
        roster = self._roster(ctx)
        paths = [path for _, path, _ in self._plan(roster, ctx)]
        return paths or [".devaccel/agents/", ".devaccel/skills/"]

    def build_prompt(self, ctx: PhaseContext) -> str:
        from prompts.loader import PromptLoader

        roster = self._roster(ctx)
        target = self._target(roster, ctx)
        kind_notes = {
            "full": "FULL agent definition (template 1)",
            "skill": "SKILL file (template 2)",
            "stub": "Copilot STUB (template 3)",
            "mirror": "MIRROR — exact copy of the canonical file",
            "template": "BMAD TEMPLATE — *-tmpl.yaml per the KB's template format",
            "task": "BMAD TASK — executable procedure per the KB's task format",
            "checklist": "BMAD CHECKLIST per the KB's checklist format",
            "workflow": "BMAD WORKFLOW YAML per the KB's workflow format",
            "data": "BMAD DATA/knowledge file (plain markdown)",
            "config": "core-config.yaml per the KB",
        }
        plan_lines = [
            f"- {path}   ← {kind_notes[kind]}  [{name}]"
            for kind, path, name in self._plan(roster, ctx)
        ] or ["- (roster not readable server-side — derive the same plan "
              "yourself from the roster file and the target's layout)"]
        return self._load_prompt(
            self.prompt_template,
            roster=ctx.prior_files.get(
                ROSTER_KEY,
                "(plan missing — this should not happen; ask the user to "
                "re-run generation)",
            ),
            target=target,
            file_plan="\n".join(plan_lines),
            bmad_kb=PromptLoader.load("spec/bmad_kb"),
            revision_feedback=ctx.revision_feedback or "None — first draft.",
        )

    def validate_outputs(self, workspace: str, ctx: PhaseContext) -> List[str]:
        from spec_driven.parsers import parse_agents, parse_skill

        roster = self._roster(ctx, workspace)
        if not roster["agents"]:
            # No readable roster (or empty) — nothing structural to check;
            # the human gate review covers it.
            return []
        problems = []
        for kind, path, name in self._plan(roster, ctx):
            if kind == "mirror":
                continue  # convenience copy — human review covers it
            content = self._read_local(workspace, path)
            if content is None:
                problems.append(f"{path} was not created")
            elif kind == "full" and not parse_agents(content):
                problems.append(
                    f"{path} has no parseable frontmatter — it must start "
                    f"with a '---' block containing name: and description:"
                )
            elif kind == "skill" and parse_skill(content, fallback_name=name) is None:
                problems.append(f"{path} is empty")
            elif kind in ("template", "task", "checklist", "workflow",
                          "data", "config") and not content.strip():
                problems.append(f"{path} is empty")
        return problems
