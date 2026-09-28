"""The catalog — every loadable definition in one flat list.

Sources, merged into a single namespace exactly the way GitHub Copilot merges
its workspace / built-in / extension skill folders:

    builtin    backend/prompts/skills/*.md — our own methodology pack, so a
               workspace with no framework installed still has one
    workspace  whatever agents/custom_agent_registry.py discovered by shape
    client     Pattern C — the browser scanned the user's real folder and
               sent the metadata; bodies arrive later through the `skill`
               tool, which the client executes

`kind` is an OPEN set. `agent` and `skill` are the common cases, but a
framework may ship templates, checklists, workflows, orchestrations, or a
kind nobody has invented yet, and all of them list and load identically.
Nothing here validates a kind against a list.

Each entry knows three things beyond its own text, and those three are what
turn a file into a working import:

    bundle_root   the folder it lives in; its subfolders are resources the
                  model may read (listed here, never read here)
    parent_chain  the config files ABOVE it, nearest first — this is where
                  {planning_artifacts} and friends actually come from
    links         the names it points at, which have parents of their own

Everything is UNTRUSTED input: reads are size-capped upstream, names are
sanitised for display, and a declared tool list is persona guidance that
never widens the request's permission policy.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from agents.custom_agent_registry import _read_capped, scan_custom_agents
from prompts.loader import PromptLoader
from spec_driven.parsers import parse_skill
from utils.logger import get_logger

log = get_logger(__name__)

BUILTIN_PREFIX = "builtin:"
_BUILTIN_DIR = Path(__file__).resolve().parents[1] / "prompts" / "skills"

# Config-shaped filenames. A framework's variables live in one of these
# somewhere above the skill that uses them; which framework it is doesn't
# matter, only that it is a config sitting on the path back to the root.
_CONFIG_NAMES = {"config.yaml", "config.yml", "core-config.yaml",
                 "core-config.yml", "manifest.yaml", "manifest.yml",
                 "agents.md"}
_CONFIG_SUFFIXES = (".config.yaml", ".config.yml")

# Filenames that make an entry the OWNER of its folder — the folder exists for
# it, so everything beside it is its bundle. Any other filename shares the
# folder with peers and owns none of them.
_PRINCIPAL_BASENAMES = {"skill.md", "skills.md", "agents.md", "index.md"}

# Origin is derived from the path's first segment — a label for the UI and
# for collision ordering, never a filter.
_ORIGIN_BY_ROOT = {
    ".devaccel": "devaccel", ".claude": "claude", ".agents": "agents",
    ".github": "copilot", "_bmad": "bmad", "bmad": "bmad",
    ".bmad-core": "bmad",
}

# Roughly 4 chars per token, matching context/token_estimator.py's heuristic.
_CHARS_PER_TOKEN = 4


@dataclass
class SkillEntry:
    """One loadable definition. `body` stays None until something loads it."""
    name: str
    description: str = ""
    kind: str = "skill"
    origin: str = "workspace"
    source: str = ""                     # workspace-relative, or builtin:<name>
    persona: str = ""
    title: str = ""
    role: str = ""
    icon: str = ""
    when_to_use: str = ""
    tools: List[str] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    # The reverse of `links`: agents that declare this entry. Frameworks only
    # write the forward direction — an agent lists its skills, a skill never
    # names its owner, because skills are meant to be shared. That is correct
    # for authoring and useless for routing: "talk to Priya" has to reach the
    # migration skills, and a match on a SKILL has to be able to find the
    # agent that owns it. build_catalog derives this after the fact.
    used_by: List[str] = field(default_factory=list)
    used_by_personas: List[str] = field(default_factory=list)
    bundle_root: str = ""
    resources: List[str] = field(default_factory=list)
    parent_chain: List[str] = field(default_factory=list)
    body: Optional[str] = None

    @property
    def is_builtin(self) -> bool:
        return self.source.startswith(BUILTIN_PREFIX)

    @property
    def display(self) -> str:
        """'name (Persona, Title)' — what a human sees in a picker."""
        extra = ", ".join(p for p in (self.persona, self.title) if p)
        return f"{self.name} ({extra})" if extra else self.name

    def to_dict(self) -> Dict:
        return {
            "name": self.name, "description": self.description,
            "kind": self.kind, "origin": self.origin, "source": self.source,
            "persona": self.persona, "title": self.title, "icon": self.icon,
            "when_to_use": self.when_to_use, "links": list(self.links),
            "used_by": list(self.used_by),
            "used_by_personas": list(self.used_by_personas),
        }


# ── Link extraction ──────────────────────────────────────────────────

# A Capabilities table's last column is a registered skill name:
#     | MR | Market analysis … | bmad-market-research |
# Take every cell that looks like a slug; resolution against the catalog
# throws away the ones that are prose.
_TABLE_ROW_RE = re.compile(r"^\s*\|(?P<cells>.+)\|\s*$", re.MULTILINE)
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
_MAX_LINKS = 40


def _extract_links(body: str, declared: List[str]) -> List[str]:
    """Names this entry points at: `skills:` frontmatter first, then any
    slug-shaped cell in a markdown table (the BMAD Capabilities convention).

    Deliberately generous — a name that matches nothing in the catalog is
    dropped at resolution time, so over-collecting here costs nothing and
    under-collecting silently breaks a framework's own navigation.
    """
    links: List[str] = [s for s in declared if s]
    for row in _TABLE_ROW_RE.finditer(body or ""):
        for cell in row.group("cells").split("|"):
            token = cell.strip().strip("`*_")
            if _SLUG_RE.match(token) and token not in links:
                links.append(token)
                if len(links) >= _MAX_LINKS:
                    return links
    return links


# ── Bundle and parent chain ──────────────────────────────────────────

# A config path written INTO the body, e.g. BMAD v6's opening line:
#     Load config from {project-root}/_bmad/bmm/config.yaml and resolve:
# This is the strongest possible signal about where an entry's variables live,
# and often the only one: BMAD keeps skills under .github/skills/ and its
# config under _bmad/<module>/, which is a SIBLING tree, so no amount of
# walking up from the skill would ever find it. The file says where its parent
# is; take it at its word.
_CONFIG_REF_RE = re.compile(
    r"\{\{?\s*project[-_]root\s*\}?\}/([A-Za-z0-9_.\-/]+?\.ya?ml)\b"
    r"|(?<![\w/])((?:[A-Za-z0-9_.\-]+/){1,6}(?:core-)?config\.ya?ml)\b"
)
_MAX_REFERENCED_CONFIGS = 6


def _referenced_configs(workspace: Path, body: str) -> List[str]:
    """Config files the body points at, that actually exist. Order preserved:
    the first one mentioned is usually the module's own."""
    out: List[str] = []
    for match in _CONFIG_REF_RE.finditer(body or ""):
        rel = (match.group(1) or match.group(2) or "").lstrip("/")
        if not rel or rel in out:
            continue
        try:
            if (workspace / rel).is_file():
                out.append(rel)
        except OSError:
            continue
        if len(out) >= _MAX_REFERENCED_CONFIGS:
            break
    return out


def _bundle_info(workspace: Path, source: str, body: str = "") -> tuple:
    """(bundle_root, resources, parent_chain) for a workspace-relative source.

    `resources` are the bundle's own subfolders and sibling files — listed so
    the model knows they exist, never read: that is the whole point of
    progressive disclosure.

    `parent_chain` is, in order:
      1. configs the BODY names — a file that says "load {project-root}/…/
         config.yaml" is telling us exactly where its parent is, and for
         layouts like BMAD v6 (skills in .github/skills/, config in _bmad/)
         it is the only thing that could: no walk upward from the skill would
         ever reach a sibling tree.
      2. configs found walking UP to the workspace root, nearest first.
    No framework is named in either rule.
    """
    src = Path(source)
    bundle = (workspace / src).parent
    resources: List[str] = []
    parents: List[str] = _referenced_configs(workspace, body)

    # A folder is this entry's BUNDLE only when the entry is the folder's
    # principal file — skills/<name>/SKILL.md owns everything beside it.
    # A file in a SHARED folder (agents/priya.agent.md) owns nothing there:
    # its neighbours are other people's agents, and listing them as "bundled
    # files you can read" put six unrelated personas in front of the model
    # every time one of them loaded.
    owns_folder = src.name.lower() in _PRINCIPAL_BASENAMES
    try:
        for child in sorted(bundle.iterdir()):
            if child.name.startswith(".") or child.samefile(workspace / src):
                continue
            if not owns_folder and child.is_file():
                continue          # a neighbour, not a resource
            rel = child.relative_to(workspace).as_posix()
            resources.append(rel + "/" if child.is_dir() else rel)
    except (OSError, ValueError):
        pass

    current = bundle
    while True:
        try:
            for child in sorted(current.iterdir()):
                if not child.is_file():
                    continue
                lower = child.name.lower()
                if lower in _CONFIG_NAMES or lower.endswith(_CONFIG_SUFFIXES):
                    rel = child.relative_to(workspace).as_posix()
                    if rel not in parents:
                        parents.append(rel)
        except (OSError, ValueError):
            pass
        if current == workspace or current.parent == current:
            break
        current = current.parent

    return bundle.relative_to(workspace).as_posix() if bundle != workspace else "", \
        resources[:40], parents[:12]


def _origin_for(source: str) -> str:
    return _ORIGIN_BY_ROOT.get(source.split("/", 1)[0], "workspace")


# ── Building ─────────────────────────────────────────────────────────

def _builtin_entries() -> List[SkillEntry]:
    """Our own pack. Present in every workspace, so a project with no
    framework installed still has a methodology to reach for."""
    entries: List[SkillEntry] = []
    if not _BUILTIN_DIR.is_dir():
        return entries
    for path in sorted(_BUILTIN_DIR.glob("*.md")):
        content = _read_capped(path)
        if content is None:
            continue
        parsed = parse_skill(content, fallback_name=path.stem)
        if not parsed:
            continue
        entries.append(SkillEntry(
            name=parsed["name"] or path.stem,
            description=parsed.get("description", ""),
            kind=parsed.get("kind", "skill"),
            origin="builtin",
            source=f"{BUILTIN_PREFIX}{path.stem}",
            persona=parsed.get("persona", ""),
            title=parsed.get("title", ""),
            when_to_use=parsed.get("when_to_use", ""),
            links=_extract_links(parsed.get("instructions", ""),
                                 parsed.get("skills", []) or []),
        ))
    return entries


def build_catalog(workspace: str = "",
                  client_entries: Optional[List[Dict]] = None,
                  include_builtin: bool = True) -> List[SkillEntry]:
    """The full catalog for a request.

    `client_entries` is Pattern C: the browser already scanned the user's real
    folder and sent metadata. Those win over a server scan of the same name —
    the client's workspace is the canonical one.

    Never raises. Discovery running into an unreadable tree must not cost the
    user their turn, so failures are logged and the catalog comes back shorter.
    """
    by_name: Dict[str, SkillEntry] = {}

    def _add(entry: SkillEntry):
        if entry.name and entry.name not in by_name:
            by_name[entry.name] = entry

    for raw in client_entries or []:
        try:
            _add(SkillEntry(
                name=str(raw.get("name") or "").strip(),
                description=str(raw.get("description") or ""),
                kind=str(raw.get("kind") or "skill").strip().lower() or "skill",
                origin=_origin_for(str(raw.get("path") or "")),
                source=str(raw.get("path") or ""),
                persona=str(raw.get("persona") or ""),
                title=str(raw.get("title") or ""),
                icon=str(raw.get("icon") or ""),
                when_to_use=str(raw.get("when_to_use") or ""),
                links=[str(s) for s in (raw.get("links") or [])],
            ))
        except (AttributeError, TypeError) as e:
            log.warning(f"skill_catalog entry ignored (bad shape): {e}")

    if workspace and Path(workspace).is_dir():
        root = Path(workspace)
        try:
            scan = scan_custom_agents(workspace)
        except OSError as e:
            log.warning(f"Workspace skill scan failed ({e}) — catalog is builtin-only")
            scan = {"agents": [], "skills": []}

        for agent in scan["agents"]:
            source = agent.get("source", "")
            bundle, resources, parents = _bundle_info(
                root, source, agent.get("system_prompt", ""))
            _add(SkillEntry(
                name=agent["name"], description=agent.get("description", ""),
                kind="agent", origin=_origin_for(source), source=source,
                persona=agent.get("persona", ""), title=agent.get("title", ""),
                role=agent.get("role", ""), icon=agent.get("icon", ""),
                when_to_use=agent.get("when_to_use", ""),
                tools=list(agent.get("tools") or []),
                links=_extract_links(agent.get("system_prompt", ""),
                                     agent.get("skills") or []),
                bundle_root=bundle, resources=resources, parent_chain=parents,
            ))
        for skill in scan["skills"]:
            source = skill.get("source", "")
            bundle, resources, parents = _bundle_info(
                root, source, skill.get("instructions", ""))
            _add(SkillEntry(
                name=skill["name"], description=skill.get("description", ""),
                kind=skill.get("kind", "skill"), origin=_origin_for(source),
                source=source, persona=skill.get("persona", ""),
                title=skill.get("title", ""), icon=skill.get("icon", ""),
                when_to_use=skill.get("when_to_use", ""),
                links=_extract_links(skill.get("instructions", ""),
                                     skill.get("skills") or []),
                bundle_root=bundle, resources=resources, parent_chain=parents,
            ))

        # Supporting material nested inside a definition's folder. Added after
        # agents and skills so the owner it belongs to already exists.
        for artifact in scan.get("artifacts", []):
            source = artifact.get("source", "")
            bundle, resources, parents = _bundle_info(
                root, source, artifact.get("instructions", ""))
            _add(SkillEntry(
                name=artifact["name"], description=artifact.get("description", ""),
                kind=artifact.get("kind", "reference"), origin=_origin_for(source),
                source=source, bundle_root=bundle, resources=resources,
                parent_chain=parents,
            ))

    if include_builtin:
        for entry in _builtin_entries():
            _add(entry)

    _index_owners(by_name)
    _index_containers(by_name)
    return list(by_name.values())


def _index_containers(by_name: Dict[str, SkillEntry]) -> None:
    """Attribute each nested artifact to the definition whose folder holds it.

    `skills/java-python/checklists/gate.md` belongs to `java-python` — that is
    the whole reason for nesting it there. The path already says so, so the
    ownership is read off the path rather than asked for twice.
    """
    # Longest source prefix wins: a definition deeper in the tree is the
    # nearer owner.
    owners = sorted(
        ((e.bundle_root, e) for e in by_name.values()
         if e.kind in ("agent", "skill") and e.bundle_root),
        key=lambda pair: len(pair[0]), reverse=True,
    )
    for entry in by_name.values():
        if entry.kind in ("agent", "skill") or not entry.source:
            continue
        for bundle, owner in owners:
            if entry.source.startswith(bundle + "/") and owner.name not in entry.used_by:
                entry.used_by.append(owner.name)
                if owner.persona:
                    entry.used_by_personas.append(owner.persona)
                # The owner should also point AT its artifacts, so loading the
                # skill lists the gate it is meant to be run under.
                if entry.name not in owner.links:
                    owner.links.append(entry.name)
                break


def _index_owners(by_name: Dict[str, SkillEntry]) -> None:
    """Fill `used_by` / `used_by_personas` by inverting every agent's links.

    Frameworks author one direction only — the agent declares its skills, and
    the skill stays agent-agnostic so two agents can share it. That is right
    for authoring and wrong for routing: without the inverse, a match on
    `java-python-translation` has no way back to Priya, and a persona's name
    only exists on one of the entries the task actually needs.
    """
    for entry in by_name.values():
        if entry.kind != "agent":
            continue
        for link in entry.links:
            target = by_name.get(link)
            if target is None or target is entry:
                continue
            if entry.name not in target.used_by:
                target.used_by.append(entry.name)
            if entry.persona and entry.persona not in target.used_by_personas:
                target.used_by_personas.append(entry.persona)


def find_entry(catalog: List[SkillEntry], name: str) -> Optional[SkillEntry]:
    """Exact match first, then case-insensitive — a model that types
    'Migration' for `migration` should not get a dead end."""
    wanted = (name or "").strip()
    if not wanted:
        return None
    for entry in catalog:
        if entry.name == wanted:
            return entry
    lowered = wanted.lower()
    for entry in catalog:
        if entry.name.lower() == lowered:
            return entry
    return None


def load_body(entry: SkillEntry, workspace: str = "") -> Optional[str]:
    """The entry's raw text, cached on the entry. None when it can't be read
    — which for a client-side workspace is the normal case: the server has no
    access to those files and the `skill` tool is delegated instead."""
    if entry.body is not None:
        return entry.body
    if entry.is_builtin:
        try:
            entry.body = PromptLoader.load(
                f"skills/{entry.source[len(BUILTIN_PREFIX):]}")
        except FileNotFoundError:
            log.warning(f"Builtin skill file missing: {entry.source}")
            return None
        return entry.body
    if not workspace or not entry.source:
        return None
    entry.body = _read_capped(Path(workspace) / entry.source)
    return entry.body


# ── Rendering for the system prompt ──────────────────────────────────

def _escape(text: str, limit: int = 300) -> str:
    """One clean line. Bodies are untrusted, so angle brackets that would
    break out of the catalog block are neutralised."""
    flat = " ".join(str(text or "").split())[:limit]
    return flat.replace("<", "‹").replace(">", "›")


def render_catalog(entries: List[SkillEntry], token_budget: int = 4000) -> str:
    """The `<catalog>` block: every entry, one line each, grouped by kind.

    Flat and complete is the design — that is how Copilot ships ~70 skills and
    how a model learns the shape of a framework rather than a filtered slice
    of it. `token_budget` is only a safety valve for an outsized install; when
    it bites, the block says so and says where the rest are, so nothing is
    silently invisible.
    """
    if not entries:
        return ""

    by_kind: Dict[str, List[SkillEntry]] = {}
    for entry in entries:
        by_kind.setdefault(entry.kind or "skill", []).append(entry)

    lines: List[str] = ["<catalog>"]
    budget = token_budget * _CHARS_PER_TOKEN
    used = 0
    withheld = 0
    roots = sorted({e.source.split("/", 1)[0] for e in entries
                    if e.source and not e.is_builtin and "/" in e.source})

    # agent first — a persona changes how the whole turn behaves, so it
    # should be the first thing read.
    for kind in sorted(by_kind, key=lambda k: (k != "agent", k)):
        for entry in sorted(by_kind[kind], key=lambda e: e.name):
            parts = [f"<{kind}><name>{_escape(entry.name, 80)}</name>"]
            if entry.persona:
                parts.append(f"<persona>{_escape(entry.persona, 60)}</persona>")
            description = entry.description or entry.when_to_use
            parts.append(f"<description>{_escape(description)}</description>")
            # Who owns this. A skill matched on its own merits still has to
            # reach the agent that runs it — "translate this Java service"
            # should land on Priya, not on a bare instruction sheet.
            if entry.used_by:
                owners = ", ".join(
                    f"{name} ({persona})" if persona else name
                    for name, persona in zip(
                        entry.used_by,
                        entry.used_by_personas + [""] * len(entry.used_by))
                )
                parts.append(f"<used-by>{_escape(owners, 200)}</used-by>")
            parts.append(f"<file>{_escape(entry.source, 200)}</file></{kind}>")
            line = "".join(parts)
            if used + len(line) > budget:
                withheld += 1
                continue
            used += len(line)
            lines.append(line)

    if withheld:
        lines.append(
            f"<note>{withheld} more entries were withheld to save context. "
            f"List them with list_directory on: {', '.join(roots) or '.devaccel'}"
            f"</note>"
        )
    lines.append("</catalog>")
    return "\n".join(lines)


def render_agents_block(entries: List[SkillEntry]) -> str:
    """The `<agents>` block — the personas `sub_agent` can be handed by name."""
    agents = sorted((e for e in entries if e.kind == "agent"), key=lambda e: e.name)
    if not agents:
        return ""
    lines = ["<agents>"]
    for entry in agents:
        parts = [f"<agent><name>{_escape(entry.name, 80)}</name>"]
        if entry.persona:
            parts.append(f"<persona>{_escape(entry.persona, 60)}</persona>")
        parts.append(
            f"<description>{_escape(entry.description or entry.when_to_use)}"
            f"</description></agent>")
        lines.append("".join(parts))
    lines.append("</agents>")
    return "\n".join(lines)
