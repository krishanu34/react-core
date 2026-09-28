"""
Parsers for the machine-read spec / agent files.

tasks.md  — GitHub Spec Kit checkbox convention:
    - [ ] T001 Create user table migration [P] requires:T000
    - [x] T002 Done task
      · [P]            = safe to run in parallel with neighbours
      · requires:T00X  = explicit dependency (comma-separable)

Agent definitions — Claude Code / BMAD frontmatter blocks. The SAME format
covers three file shapes:
    · one agent per file  (.devaccel/agents/<name>.md, .claude/agents/<name>.md)
    · stacked blocks      (legacy agents.md, roster.md — several per file)
    · skills              (.devaccel/skills/<name>/SKILL.md — one per folder)

    ---
    name: api-builder
    description: Implements REST endpoints from design.md
    tools: read_file, write_file
    skills: generate-openapi, project-conventions
    tasks: T004, T005
    ---
    <free-text system prompt until the next block>

`skills:` is the BMAD-style association: names of skill folders whose
SKILL.md gets injected alongside the agent's system prompt when it runs.
Roster files may also declare skill blocks (`type: skill`) which the
scaffold phase expands into skills/<name>/SKILL.md folders.

All parsers are deliberately forgiving: they extract what matches and skip
what doesn't, because these files are ALSO hand-editable by users (and may
come straight from an existing BMAD install) — user edits win.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

# "- [ ] T001 title..."  /  "- [x] T001 title..."
_TASK_RE = re.compile(
    r"^\s*[-*]\s*\[(?P<done>[ xX])\]\s*(?P<id>T\d{3,})\s+(?P<title>.+?)\s*$"
)
_PARALLEL_RE = re.compile(r"\s*\[P\]\s*", re.IGNORECASE)
_REQUIRES_RE = re.compile(r"\s*requires:\s*(?P<ids>T\d{3,}(?:\s*,\s*T\d{3,})*)", re.IGNORECASE)
_PHASE_RE = re.compile(r"^\s*##\s+(?P<name>.+?)\s*$")


def parse_tasks(content: str) -> List[Dict]:
    """tasks.md → [{id, title, done, parallel, requires, phase}] in file order."""
    tasks: List[Dict] = []
    current_phase = ""
    for line in content.splitlines():
        phase_match = _PHASE_RE.match(line)
        if phase_match:
            current_phase = phase_match.group("name")
            continue
        m = _TASK_RE.match(line)
        if not m:
            continue
        title = m.group("title")

        requires: List[str] = []
        req = _REQUIRES_RE.search(title)
        if req:
            requires = [r.strip() for r in req.group("ids").split(",")]
            title = _REQUIRES_RE.sub("", title)

        parallel = bool(_PARALLEL_RE.search(title))
        title = _PARALLEL_RE.sub(" ", title).strip()

        tasks.append({
            "id": m.group("id"),
            "title": title,
            "done": m.group("done").lower() == "x",
            "parallel": parallel,
            "requires": requires,
            "phase": current_phase,
        })
    return tasks


def tick_task(content: str, task_id: str) -> str:
    """Return tasks.md content with task_id's checkbox ticked; every other
    byte untouched. Used when the SERVER updates tasks.md (per-task mode)."""
    out = []
    for line in content.splitlines(keepends=True):
        m = _TASK_RE.match(line)
        if m and m.group("id") == task_id and m.group("done") == " ":
            line = line.replace("[ ]", "[x]", 1)
        out.append(line)
    return "".join(out)


def _split_csv(value: str) -> List[str]:
    return [t.strip() for t in value.split(",") if t.strip()]


def _frontmatter_blocks(content: str) -> List[Tuple[Dict[str, str], str]]:
    """All (meta, body) frontmatter blocks in file order — blocks without a
    name/description are dropped (hand-edited noise, dividers, etc.)."""
    return [
        (meta, body)
        for meta, body in _all_frontmatter_blocks(content)
        if "name" in meta and "description" in meta
    ]


# A hand-written definition file often opens with the frontmatter KEYS and no
# `---` fences around them — the author knew what the fields were and not that
# the delimiters were load-bearing. The file is unmistakably a definition, so
# rejecting it over punctuation just makes the agent silently disappear, which
# is the least useful thing we could do with it.
#
# Guarded so ordinary prose can't qualify: an unbroken run of `key: value`
# lines from the very first line, at least two of them, and `name` or
# `description` among the keys.
_IMPLICIT_KEY_RE = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9_-]{0,63})\s*:\s*(?P<value>.*)$")
_IMPLICIT_MIN_KEYS = 2
_IMPLICIT_REQUIRED_KEYS = {"name", "description"}


def _implicit_frontmatter(content: str) -> Optional[Tuple[Dict[str, str], str]]:
    """(meta, body) for a fence-less definition file, or None."""
    lines = content.splitlines()
    meta: Dict[str, str] = {}
    consumed = 0
    for line in lines:
        if not line.strip():
            break                      # blank line ends the block
        m = _IMPLICIT_KEY_RE.match(line)
        if not m:
            break
        meta[m.group("key").strip().lower()] = m.group("value").strip()
        consumed += 1
    if len(meta) < _IMPLICIT_MIN_KEYS or not (_IMPLICIT_REQUIRED_KEYS & meta.keys()):
        return None
    return meta, "\n".join(lines[consumed:]).strip()


def _all_frontmatter_blocks(content: str) -> List[Tuple[Dict[str, str], str]]:
    """Every (meta, body) frontmatter block, no field requirements."""
    # Strip a BOM so the first fence still matches ^---.
    content = content.lstrip("﻿")
    if not content.lstrip().startswith("---"):
        implicit = _implicit_frontmatter(content)
        if implicit is not None:
            return [implicit]
    blocks = re.split(r"^---\s*$", content, flags=re.MULTILINE)
    # blocks alternate: [before, frontmatter, body, frontmatter, body, ...]
    out: List[Tuple[Dict[str, str], str]] = []
    for i in range(1, len(blocks) - 1, 2):
        meta_text, body = blocks[i], blocks[i + 1]
        meta: Dict[str, str] = {}
        for line in meta_text.splitlines():
            key, sep, value = line.partition(":")
            if sep and key.strip() and not key.startswith("#"):
                meta[key.strip().lower()] = value.strip()
        out.append((meta, body.strip()))
    return out


def parse_frontmatter(content: str) -> Optional[Tuple[Dict[str, str], str]]:
    """First frontmatter block as (meta, body), with NO required fields —
    for GitHub Copilot agent stubs (.github/agents/<name>.agent.md), whose
    frontmatter carries only `description:` (the name is the filename)."""
    blocks = _all_frontmatter_blocks(content)
    return blocks[0] if blocks else None


# A persona's human name may live in frontmatter (`persona:`) or, the way
# BMAD v6 skills write it, as the H1 immediately after the frontmatter
# ("# Mary"). Two guards, both learned the hard way:
#   · only the FIRST non-empty line counts — a `# Start dev server` comment
#     inside a fenced bash block further down is not somebody's name
#   · it must be short — "# Migration Runbook For The Payments Service" is a
#     document title, not a person
_H1_RE = re.compile(r"^#\s+(?P<title>[^\n#]+?)\s*$")
_PERSONA_NAME_MAX_WORDS = 3

# The third source, and in practice the most common one. A BMAD v6 stub is
# frontmatter with ONLY `description:` — no name, no persona — and the human
# name lives inside that sentence:
#
#   description: Strategic business analyst. Use when the user asks to talk
#                to Mary or requests the business analyst.
#
# Every agent in a stock BMAD install looks like this, so without reading it
# the persona field is empty for the entire roster.
_TALK_TO_RE = re.compile(
    r"\b(?:talk|speak|chat)\s+(?:to|with)\s+(?P<name>"
    r"(?:Dr\.?|Mr\.?|Ms\.?|Mrs\.?)?\s*[A-Z][a-zA-Z'’\-]+)",
    re.IGNORECASE,
)


def _persona_from_description(description: str) -> str:
    """The human name a 'talk to X' description names, or ''."""
    m = _TALK_TO_RE.search(description or "")
    if not m:
        return ""
    name = " ".join(m.group("name").split())
    # Guard against "talk to the architect" / "talk to your team" — a role or
    # a pronoun is not somebody's name.
    if not name or not name[0].isupper():
        return ""
    if name.lower() in {"the", "a", "an", "your", "our", "this", "that",
                        "them", "him", "her", "it", "us", "me", "someone"}:
        return ""
    return name


def _persona_from_body(body: str) -> str:
    """The human name declared as the body's opening H1, or ''."""
    for line in (body or "").splitlines():
        if not line.strip():
            continue
        m = _H1_RE.match(line.strip())
        if not m:
            return ""            # body opens with something else — no persona
        title = " ".join(m.group("title").split())
        if not title or len(title.split()) > _PERSONA_NAME_MAX_WORDS:
            return ""
        return title
    return ""


def _persona_for(meta: Dict[str, str], body: str) -> str:
    """Persona name from the strongest available source, in order:
    an explicit `persona:` field, the body's opening H1, then the
    'talk to X' phrasing inside the description."""
    return (meta.get("persona", "")
            or _persona_from_body(body)
            or _persona_from_description(meta.get("description", "")))


def _agent_from_block(meta: Dict[str, str], body: str) -> Dict:
    return {
        "name": meta["name"],
        "description": meta["description"],
        "tools": _split_csv(meta.get("tools", "")),
        "skills": _split_csv(meta.get("skills", "")),
        "tasks": _split_csv(meta.get("tasks", "")),
        "model": meta.get("model", ""),
        # Persona identity — every field optional. An agent without them is
        # still a perfectly good agent; these only make it a *someone*.
        "persona": _persona_for(meta, body),
        "title": meta.get("title", ""),
        "role": meta.get("role", ""),
        "icon": meta.get("icon", ""),
        "when_to_use": meta.get("whentouse", "") or meta.get("when_to_use", ""),
        "system_prompt": body,
    }


def parse_agents(content: str) -> List[Dict]:
    """Agent definition file(s) → [{name, description, tools, skills, tasks,
    model, system_prompt}]. Handles BOTH one-agent-per-file (Claude Code /
    BMAD compiled agents) and stacked multi-agent files (legacy agents.md,
    roster.md). Blocks marked `type: skill` are NOT agents — skipped here,
    surfaced by parse_roster()."""
    return [
        _agent_from_block(meta, body)
        for meta, body in _frontmatter_blocks(content)
        if meta.get("type", "agent").strip().lower() != "skill"
    ]


def parse_skill(content: str, fallback_name: str = "") -> Optional[Dict]:
    """SKILL.md → {name, description, instructions, kind, persona, …} or None
    when the file is empty. `fallback_name` (usually the folder name) wins
    over a missing name.

    `kind` is an OPEN set: whatever the file's `type:` says. A framework may
    ship templates, checklists, workflows, orchestrations or a type nobody
    has thought of yet, and all of them are loadable the same way — so this
    never validates the value against a list."""
    blocks = _frontmatter_blocks(content)
    if not blocks:
        if not content.strip():
            return None
        body = content.strip()
        return {"name": fallback_name, "description": "", "instructions": body,
                "kind": "skill", "persona": _persona_from_body(body),
                "title": "", "role": "", "icon": "", "when_to_use": "",
                "skills": []}
    meta, body = blocks[0]
    return {
        "name": meta.get("name") or fallback_name,
        "description": meta.get("description", ""),
        "instructions": body,
        "kind": (meta.get("type", "").strip().lower() or "skill"),
        "persona": _persona_for(meta, body),
        "title": meta.get("title", ""),
        "role": meta.get("role", ""),
        "icon": meta.get("icon", ""),
        "when_to_use": meta.get("whentouse", "") or meta.get("when_to_use", ""),
        "skills": _split_csv(meta.get("skills", "")),
    }


def parse_skills_file(content: str) -> List[Dict]:
    """A STACKED skills file (skills.md) → one dict per frontmatter block,
    same shape as parse_skill().

    Some frameworks keep every skill in one file instead of one folder per
    skill. Both are valid; this is the multi-block reader for the first.
    Blocks without a name are skipped (dividers, hand-edited noise)."""
    out: List[Dict] = []
    for meta, body in _all_frontmatter_blocks(content):
        name = (meta.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "name": name,
            "description": meta.get("description", ""),
            "instructions": body,
            "kind": (meta.get("type", "").strip().lower() or "skill"),
            "persona": _persona_for(meta, body),
            "title": meta.get("title", ""),
            "role": meta.get("role", ""),
            "icon": meta.get("icon", ""),
            "when_to_use": meta.get("whentouse", "") or meta.get("when_to_use", ""),
            "skills": _split_csv(meta.get("skills", "")),
        })
    return out


# BMAD artifact types the roster may propose beyond agents/skills — each has
# a KNOWN folder under .devaccel (see phases/scaffold.py ARTIFACT_PATHS).
#
# This is a list of types we know where to PUT, not a list of types we
# accept: parse_roster treats any `type:` that isn't agent/skill/config as an
# artifact, so a framework (or a user) can invent `orchestration`, `policy`,
# `runbook` and have it round-trip. The scaffold phase falls back to a
# generic path for types not named here.
ROSTER_ARTIFACT_TYPES = {"template", "task", "checklist", "workflow", "data"}

# Types that are structural rather than artifacts.
_NON_ARTIFACT_TYPES = {"agent", "skill", "config"}


def parse_roster(content: str) -> Dict[str, Any]:
    """roster.md (agent-builder gate 1 deliverable) → {"agents": [...],
    "skills": [...], "artifacts": [...], "config": {...}}.

    Same stacked-frontmatter format as agents.md:
      · `type: skill` blocks — knowledge expanded into skills/<n>/SKILL.md
      · `type: template|task|checklist|workflow|data` blocks — BMAD
        artifacts the question needs (dynamically decided by the LLM),
        expanded into .devaccel/<type>s/ by the scaffold phase
      · `type: config` block — workflow settings, most importantly
        `target:` (devaccel | claude | copilot | bmad)
      · everything else with name+description — an agent."""
    agents: List[Dict] = []
    skills: List[Dict] = []
    artifacts: List[Dict] = []
    config: Dict[str, str] = {}
    for meta, body in _all_frontmatter_blocks(content):
        block_type = meta.get("type", "agent").strip().lower()
        if block_type == "config":
            config.update({k: v for k, v in meta.items() if k != "type"})
            continue
        if "name" not in meta or "description" not in meta:
            continue  # noise block — skip (hand-edited file)
        if block_type == "skill":
            skills.append({
                "name": meta["name"],
                "description": meta["description"],
                "instructions": body,
            })
        elif block_type not in _NON_ARTIFACT_TYPES:
            artifacts.append({
                "type": block_type,
                "name": meta["name"],
                "description": meta["description"],
                # Which skill or agent this serves. The scaffold writes the
                # file INSIDE that owner's folder, so the tree itself records
                # the relationship and discovery reads it straight back.
                "owner": meta.get("owner", ""),
                "instructions": body,
            })
        else:
            agents.append(_agent_from_block(meta, body))
    return {"agents": agents, "skills": skills, "artifacts": artifacts,
            "config": config}


def roster_text_from_plan(plan: Dict, default_target: str = "devaccel") -> str:
    """submit_plan tool payload (schema-enforced JSON) → the stacked-
    frontmatter roster text the rest of the pipeline consumes. Fully
    deterministic: the tool schema guarantees the SHAPE, this guarantees
    the FORMAT — so a captured plan can never fail roster validation.

    Hardening: names are kebab-cased; bodies containing a bare '---' line
    (which would break block structure) are defused; skills an agent
    references but the plan forgot to define get stub blocks (expanded at
    scaffold time) so validate_answer's skill check always passes."""
    def _kebab(value: Any) -> str:
        slug = re.sub(r"[^a-z0-9-]+", "-", str(value or "").strip().lower()).strip("-")
        return slug or "unnamed"

    def _line(value: Any, fallback: str) -> str:
        return " ".join(str(value or "").split()) or fallback

    def _body(value: Any, fallback: str) -> str:
        text = str(value or "").strip() or fallback
        return re.sub(r"(?m)^---\s*$", "—", text)

    target = str(plan.get("target") or default_target).strip().lower()
    if target not in ("devaccel", "claude", "copilot", "bmad"):
        target = default_target

    out: List[str] = [
        f"## Generation Plan — {_line(plan.get('summary'), 'agent & skills for this request')}",
        "",
        "---", "type: config", f"target: {target}", "---", "",
    ]

    referenced: List[str] = []
    for agent in plan.get("agents") or []:
        if not isinstance(agent, dict) or not agent.get("name"):
            continue
        skills = [_kebab(s) for s in (agent.get("skills") or []) if str(s).strip()]
        referenced += skills
        out += ["---", f"name: {_kebab(agent['name'])}",
                f"description: {_line(agent.get('description'), 'Agent for this request')}"]
        # Identity: an agent the user can address by name ("talk to Winston")
        # rather than only by slug. Every field is optional in the schema, so
        # each is emitted only when the plan actually supplied it.
        for key, label in (("persona_name", "persona"), ("title", "title"),
                           ("role", "role"), ("icon", "icon"),
                           ("when_to_use", "whenToUse")):
            value = _line(agent.get(key), "")
            if value:
                out.append(f"{label}: {value}")
        tools = [str(t).strip() for t in (agent.get("tools") or []) if str(t).strip()]
        if tools:
            out.append(f"tools: {', '.join(tools)}")
        if skills:
            out.append(f"skills: {', '.join(skills)}")
        out += ["---", _body(agent.get("persona"),
                             f"You own this request end-to-end: "
                             f"{_line(agent.get('description'), 'the user request')}."), ""]

    defined = set()
    for skill in plan.get("skills") or []:
        if not isinstance(skill, dict) or not skill.get("name"):
            continue
        name = _kebab(skill["name"])
        defined.add(name)
        out += ["---", "type: skill", f"name: {name}",
                f"description: {_line(skill.get('description'), 'Reusable know-how')}",
                "---", _body(skill.get("instructions"), "Expanded at scaffold time."), ""]
    for name in dict.fromkeys(referenced):          # keep order, dedupe
        if name not in defined:
            out += ["---", "type: skill", f"name: {name}",
                    f"description: Know-how for {name.replace('-', ' ')}",
                    "---", "Expanded at scaffold time.", ""]

    for artifact in plan.get("artifacts") or []:
        if not isinstance(artifact, dict):
            continue
        a_type = str(artifact.get("type") or "").strip().lower()
        # Any type EXCEPT the structural ones — the plan may name an artifact
        # kind we have no dedicated folder for; scaffold gives it a generic
        # home rather than dropping the LLM's decision on the floor.
        a_type = re.sub(r"[^a-z0-9-]+", "-", a_type).strip("-")
        if not a_type or a_type in _NON_ARTIFACT_TYPES or not artifact.get("name"):
            continue
        out += ["---", f"type: {a_type}", f"name: {_kebab(artifact['name'])}",
                f"description: {_line(artifact.get('description'), a_type)}"]
        owner = _kebab(artifact.get("owner")) if artifact.get("owner") else ""
        if owner and owner != "unnamed":
            out.append(f"owner: {owner}")
        out += ["---", _body(artifact.get("instructions"),
                             "Expanded at scaffold time."), ""]

    return "\n".join(out)


# BMAD-core agent files keep their definition in a fenced ```yaml block
# (agent: {name, id, title, whenToUse, …}) instead of frontmatter. This is
# a deliberately light regex extraction — enough for discovery (name +
# description + full text as the persona) without a YAML dependency.
_BMAD_YAML_BLOCK_RE = re.compile(r"```ya?ml\s*\n(.*?)```", re.DOTALL)


def parse_bmad_agent(content: str, fallback_name: str = "") -> Optional[Dict]:
    """A .bmad-core-style agent (Markdown + embedded YAML block) → the same
    dict shape parse_agents() produces, or None when the file has no yaml
    block with an `agent:` mapping. The WHOLE file is the system prompt —
    BMAD agents are self-contained operating instructions."""
    m = _BMAD_YAML_BLOCK_RE.search(content)
    if not m:
        return None
    block = m.group(1)
    if not re.search(r"^agent\s*:", block, re.MULTILINE):
        return None

    def _field(name: str) -> str:
        f = re.search(rf"^\s{{2,}}{name}\s*:\s*(.+)$", block, re.MULTILINE)
        return f.group(1).strip().strip("'\"") if f else ""

    agent_id = _field("id") or fallback_name
    if not agent_id:
        return None
    when_to_use = _field("whenToUse")
    title = _field("title")
    # BMAD's `name:` inside the agent block IS the human name ("Mary");
    # the file/`id` is the slug. That is the opposite of our frontmatter
    # convention, hence the crossover here.
    return {
        "name": agent_id,
        "description": when_to_use or title,
        "tools": [],
        "skills": [],
        "tasks": [],
        "model": "",
        "persona": _field("name"),
        "title": title,
        "role": _field("role"),
        "icon": _field("icon"),
        "when_to_use": when_to_use,
        "system_prompt": content.strip(),
    }


def find_persona_for_task(agents: List[Dict], task_id: str) -> Dict | None:
    """The agents.md entry that claims this task id, if any."""
    for agent in agents:
        if task_id in agent.get("tasks", []):
            return agent
    return None
