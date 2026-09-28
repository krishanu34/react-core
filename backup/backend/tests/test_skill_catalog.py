"""
Skill discovery, link closure, and variable resolution.

Three properties, each of which was a real failure before it was one:

1. THE FOLDER DECIDES what a file is, and the nearest declaring folder wins.
   Anything under `agents/` is an agent — a direct file, a folder per agent,
   any filename — and anything outside it is not, however its frontmatter
   reads. That is a rule an organisation can enforce by looking at the tree.
   A checklist nested inside a skill stays a checklist rather than becoming
   a second skill.

2. NESTING RECORDS OWNERSHIP. `skills/x/checklists/gate.md` belongs to `x`,
   and both discovery and generation agree on that, so the relationship is
   visible in the tree instead of being declared twice. Opening one folder
   shows the method, its gates and its templates together.

3. A LOADED FILE IS NOT A DEAD END. It resolves the variables it was written
   against from the config above it, and it names what it links to, so the
   model can follow a framework's own navigation instead of guessing.
"""

from __future__ import annotations

import pytest

from agents.custom_agent_registry import scan_custom_agents
from skills.catalog import build_catalog, find_entry, load_body, render_catalog
from skills.closure import resolve_closure
from skills.variables import build_session_scope, module_scope_for, substitute


def _write(root, rel: str, text: str):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="" so a test that deliberately writes CRLF gets CRLF, rather
    # than \r\n being translated to \r\r\n on Windows.
    path.write_text(text, encoding="utf-8", newline="")
    return path


def _skill(name: str, description: str = "d", body: str = "body", **meta) -> str:
    extra = "".join(f"{k}: {v}\n" for k, v in meta.items())
    return f"---\nname: {name}\ndescription: {description}\n{extra}---\n{body}"


@pytest.fixture
def workspace(tmp_path):
    """One workspace holding every layout we claim to support, including two
    nobody has ever specified."""
    # Canonical layouts
    _write(tmp_path, ".claude/skills/x/SKILL.md", _skill("x", "claude skill"))
    _write(tmp_path, ".agents/skills/y/SKILL.md", _skill("y", "canonical y", "# Mary\nhi"))
    _write(tmp_path, ".github/agents/y.agent.md",
           "---\ndescription: stub for y\n---\nLOAD .agents/skills/y/SKILL.md")
    _write(tmp_path, ".bmad-core/agents/dev.md",
           "# Dev\n```yaml\nagent:\n  name: Amelia\n  id: dev\n  title: Senior Engineer\n"
           "  whenToUse: story implementation\n```\n")
    # Shapes the old glob scan could not express
    _write(tmp_path, ".devaccel/SKILL.md", _skill("root-skill", "at the very root"))
    _write(tmp_path, ".devaccel/migration/SKILL.md", _skill("migration", "migrate tables"))
    _write(tmp_path, ".devaccel/packs/acme/skills/deep/SKILL.md",
           _skill("deep", "three levels down"))
    _write(tmp_path, ".devaccel/skills.md",
           _skill("stacked-one", "first") + "\n" + _skill("stacked-two", "second"))
    # A layout nobody specified
    _write(tmp_path, "frameworks/acme-sdlc/roles/migrator.agent.md",
           _skill("migrator", "invented layout", "body", persona="Winston"))
    _write(tmp_path, "frameworks/acme-sdlc/roles/references/notes.md", "not a definition")
    # Kinds beyond agent/skill
    _write(tmp_path, ".devaccel/orch/SKILL.md",
           _skill("releaser", "orchestrates a release", type="orchestration"))
    _write(tmp_path, ".devaccel/custom/SKILL.md",
           _skill("house-rules", "our own thing", type="my-custom-kind"))
    # Pasted by hand into the agents folder — an ordinary filename, and a
    # folder-per-agent. Both are the convention.
    _write(tmp_path, ".devaccel/agent/mary.md",
           _skill("mary-analyst", "business analyst", "# Mary\nbody"))
    _write(tmp_path, ".devaccel/agents/priya/AGENT.md",
           _skill("priya-migrator", "migrations", "# Priya\nbody"))
    _write(tmp_path, ".devaccel/agents/omar/definition.md",
           _skill("omar-qa", "quality", "# Omar\nbody"))
    # OUTSIDE agents/ or skills/ — not a definition, whatever it declares
    _write(tmp_path, ".devaccel/my-team/roles/winston.md",
           _skill("winston", "api engineer"))
    # Documentation sitting beside them must NOT register
    _write(tmp_path, ".devaccel/agent/README.md", "# Put your agents here\nJust docs.")
    _write(tmp_path, ".devaccel/notes/design.md", "# Design notes\n\nProse, no frontmatter.")
    # Must never be scanned
    _write(tmp_path, "node_modules/pkg/SKILL.md", _skill("leaked", "must not appear"))
    return tmp_path


# ── Discovery ────────────────────────────────────────────────────────

def test_discovers_every_layout_including_unspecified_ones(workspace):
    scan = scan_custom_agents(str(workspace))
    names = {s["name"] for s in scan["skills"]} | {a["name"] for a in scan["agents"]}
    assert {
        "x", "y", "dev", "root-skill", "migration", "deep",
        "stacked-one", "stacked-two", "migrator", "releaser", "house-rules",
    } <= names


def test_any_file_under_an_agents_folder_is_an_agent(workspace):
    """The organisation's rule: agents live under `agents/`, and inside it a
    direct file, a folder-per-agent, or an arbitrary filename in that folder
    are all equally valid. Nothing about the FILENAME has to be memorised."""
    agents = {a["name"]: a for a in scan_custom_agents(str(workspace))["agents"]}
    assert agents["mary-analyst"]["source"] == ".devaccel/agent/mary.md"
    assert agents["mary-analyst"]["persona"] == "Mary"
    assert agents["priya-migrator"]["source"] == ".devaccel/agents/priya/AGENT.md"
    assert agents["omar-qa"]["source"] == ".devaccel/agents/omar/definition.md"


def test_a_file_outside_the_convention_is_not_an_agent(workspace):
    """`.devaccel/my-team/roles/winston.md` has perfectly good agent
    frontmatter and is still not an agent, because it is not under agents/.
    That is what makes the convention enforceable by looking at the tree."""
    scan = scan_custom_agents(str(workspace))
    names = {a["name"] for a in scan["agents"]} | {s["name"] for s in scan["skills"]}
    assert "winston" not in names


def test_documentation_beside_a_definition_is_not_a_definition(workspace):
    scan = scan_custom_agents(str(workspace))
    names = {s["name"] for s in scan["skills"]} | {a["name"] for a in scan["agents"]}
    assert not any(n.lower() in ("readme", "design", "") for n in names)
    # Nothing sourced from the two documentation files.
    sources = {s.get("source") for s in scan["skills"]} | {a.get("source") for a in scan["agents"]}
    assert ".devaccel/agent/README.md" not in sources
    assert ".devaccel/notes/design.md" not in sources


def test_excluded_directories_are_never_scanned(workspace):
    scan = scan_custom_agents(str(workspace))
    names = {s["name"] for s in scan["skills"]} | {a["name"] for a in scan["agents"]}
    assert "leaked" not in names


def test_a_persona_is_not_also_listed_as_a_plain_skill(workspace):
    scan = scan_custom_agents(str(workspace))
    assert "y" in {a["name"] for a in scan["agents"]}
    assert "y" not in {s["name"] for s in scan["skills"]}


@pytest.mark.parametrize("name,persona,source", [
    ("dev", "Amelia", "yaml block"),        # .bmad-core agent: block
    ("y", "Mary", "opening H1"),            # BMAD v6 "# Mary"
    ("migrator", "Winston", "frontmatter"),  # persona: key
])
def test_persona_names_parse_from_every_convention(workspace, name, persona, source):
    agents = {a["name"]: a for a in scan_custom_agents(str(workspace))["agents"]}
    assert agents[name]["persona"] == persona, f"persona from {source}"


def test_shell_comments_in_code_fences_are_not_persona_names(tmp_path):
    """`# Start dev server` inside a fenced block is not somebody's name —
    only the body's opening line counts."""
    _write(tmp_path, ".devaccel/s/SKILL.md",
           _skill("s", "d", "Some prose first.\n\n```bash\n# Start dev server\nnpm run dev\n```"))
    skills = {s["name"]: s for s in scan_custom_agents(str(tmp_path))["skills"]}
    assert skills["s"]["persona"] == ""


# ── Open kinds ───────────────────────────────────────────────────────

def test_kind_is_an_open_set(workspace):
    catalog = build_catalog(str(workspace), include_builtin=False)
    kinds = {e.name: e.kind for e in catalog}
    assert kinds["releaser"] == "orchestration"
    assert kinds["house-rules"] == "my-custom-kind"


def test_unknown_kinds_appear_in_the_rendered_catalog(workspace):
    block = render_catalog(build_catalog(str(workspace), include_builtin=False))
    assert "<my-custom-kind>" in block
    assert "<orchestration>" in block


# ── Link closure ─────────────────────────────────────────────────────

@pytest.fixture
def linked(tmp_path):
    """agent → skill → template, the chain a real framework forms."""
    _write(tmp_path, ".devaccel/core-config.yaml",
           'user_name: Charles\nplanning: "{project-root}/out/planning"\n')
    _write(tmp_path, ".devaccel/agents/lead.agent.md", _skill(
        "lead", "owns migrations",
        "# Winston\nGreet {user_name}. Write to {planning}. Sprint: {sprint_dir}.\n\n"
        "## Capabilities\n| Code | Description | Skill |\n|---|---|---|\n"
        "| EC | expand/contract | expand-contract |\n"
        "| XX | not installed | missing-skill |\n",
        skills="expand-contract"))
    _write(tmp_path, ".devaccel/skills/expand-contract/SKILL.md", _skill(
        "expand-contract", "expand then contract",
        "Use the plan template.\n\n| C | D | S |\n|---|---|---|\n"
        "| T | plan | migration-plan |\n"))
    _write(tmp_path, ".devaccel/templates/SKILL.md",
           _skill("migration-plan", "the plan skeleton", type="template"))
    _write(tmp_path, ".devaccel/skills/expand-contract/references/notes.md", "notes")
    return tmp_path


def test_closure_follows_links_transitively(linked):
    catalog = build_catalog(str(linked), include_builtin=False)
    closure = resolve_closure(find_entry(catalog, "lead"), catalog)
    assert [e.name for e in closure.load_order] == [
        "lead", "expand-contract", "migration-plan",
    ]


def test_closure_reports_a_link_that_does_not_exist(linked):
    catalog = build_catalog(str(linked), include_builtin=False)
    closure = resolve_closure(find_entry(catalog, "lead"), catalog)
    assert "missing-skill" in closure.missing
    assert "missing-skill" in closure.as_text()


def test_closure_terminates_on_a_cycle(tmp_path):
    _write(tmp_path, ".devaccel/skills/a/SKILL.md", _skill("a", "d", "x", skills="b"))
    _write(tmp_path, ".devaccel/skills/b/SKILL.md", _skill("b", "d", "x", skills="a"))
    catalog = build_catalog(str(tmp_path), include_builtin=False)
    closure = resolve_closure(find_entry(catalog, "a"), catalog)
    assert [e.name for e in closure.load_order] == ["a", "b"]


def test_bundled_resources_are_listed_not_read(linked):
    catalog = build_catalog(str(linked), include_builtin=False)
    entry = find_entry(catalog, "expand-contract")
    assert "references/" in " ".join(entry.resources)
    assert entry.body is None, "listing a bundle must not read it"


# ── Variables ────────────────────────────────────────────────────────

def test_variables_resolve_from_the_parent_config(linked):
    catalog = build_catalog(str(linked), include_builtin=False)
    entry = find_entry(catalog, "lead")
    session = build_session_scope(str(linked), user_name="ignored-by-config")
    scope = {**session, **module_scope_for(str(linked), entry.parent_chain, session)}
    resolved, _ = substitute(load_body(entry, str(linked)), scope)
    assert "Greet Charles." in resolved
    # The config's own value is a template — it must resolve too.
    assert "/out/planning" in resolved and "{project-root}" not in resolved


def test_an_unresolved_variable_is_reported_with_where_to_look(linked):
    catalog = build_catalog(str(linked), include_builtin=False)
    entry = find_entry(catalog, "lead")
    session = build_session_scope(str(linked))
    scope = {**session, **module_scope_for(str(linked), entry.parent_chain, session)}
    _, unresolved = substitute(load_body(entry, str(linked)), scope)
    assert unresolved == ["sprint_dir"]
    assert ".devaccel/core-config.yaml" in entry.parent_chain


def test_substitution_leaves_json_and_jsx_braces_alone():
    """Bodies are full of braces that were never placeholders. str.format()
    would raise on these, which is why substitution is targeted."""
    body = 'Return {"status": "ok"} and render <T v={x} />. Greet {user_name}.'
    resolved, unresolved = substitute(body, {"user_name": "Charles"})
    assert '{"status": "ok"}' in resolved
    assert "v={x}" in resolved
    assert "Greet Charles." in resolved
    assert unresolved == []


# ── Builtins ─────────────────────────────────────────────────────────

def test_every_builtin_skill_has_a_description():
    """The description is the ONLY thing shown before something decides to
    load an entry — one without it is unreachable in practice."""
    missing = [e.name for e in build_catalog("") if not e.description]
    assert missing == []


def test_builtin_pack_is_present_without_a_workspace():
    names = {e.name for e in build_catalog("")}
    assert {"bmad_method", "github_spec_kit", "framework_install"} <= names


# ── The real BMAD v6 shape ───────────────────────────────────────────

@pytest.fixture
def bmad_v6(tmp_path):
    """Skills under .github/skills/, config under _bmad/<module>/ — a SIBLING
    tree. Walking up from the skill can never reach that config; only the
    body's own "load {project-root}/_bmad/bmm/config.yaml" line can."""
    _write(tmp_path, "_bmad/bmm/config.yaml",
           'user_name: Charles\nplanning_artifacts: "{project-root}/out/planning"\n')
    _write(tmp_path, ".github/skills/bmad-agent-analyst/SKILL.md", _skill(
        "bmad-agent-analyst",
        "Strategic business analyst. Use when the user asks to talk to Mary.",
        "# Mary\nLoad config from {project-root}/_bmad/bmm/config.yaml, greet "
        "{user_name}, write to {planning_artifacts}.\n\n"
        "## Capabilities\n| Code | Description | Skill |\n|---|---|---|\n"
        "| MR | Market analysis | bmad-market-research |\n"))
    _write(tmp_path, ".github/skills/bmad-market-research/SKILL.md",
           _skill("bmad-market-research", "Competitive landscape"))
    return tmp_path


def test_bmad_agent_skill_becomes_an_agent_without_a_stub(bmad_v6):
    """A `bmad-agent-*` skill folder IS a persona even with no .github stub —
    the Claude-Code-only install shape."""
    catalog = build_catalog(str(bmad_v6), include_builtin=False)
    entry = find_entry(catalog, "bmad-agent-analyst")
    assert entry.kind == "agent"
    assert entry.persona == "Mary"


def test_config_in_a_sibling_tree_resolves_because_the_body_names_it(bmad_v6):
    catalog = build_catalog(str(bmad_v6), include_builtin=False)
    entry = find_entry(catalog, "bmad-agent-analyst")
    assert "_bmad/bmm/config.yaml" in entry.parent_chain

    session = build_session_scope(str(bmad_v6))
    scope = {**session, **module_scope_for(str(bmad_v6), entry.parent_chain, session)}
    resolved, unresolved = substitute(load_body(entry, str(bmad_v6)), scope)
    assert "greet Charles" in resolved
    assert "out/planning" in resolved
    assert unresolved == []


def test_client_entries_win_over_the_server_scan(workspace):
    """Pattern C: the client's workspace is the canonical one."""
    catalog = build_catalog(str(workspace), client_entries=[
        {"name": "migration", "kind": "skill", "description": "from the client",
         "path": ".devaccel/migration/SKILL.md"},
    ], include_builtin=False)
    assert find_entry(catalog, "migration").description == "from the client"


# ── Delegation by name ───────────────────────────────────────────────

def test_sub_agent_can_be_handed_a_workspace_persona(bmad_v6):
    """runSubagent(agentName=…): the workspace's own definition becomes the
    child's brief, so the parent doesn't paraphrase a persona that already
    exists."""
    from tools.registry import ToolRegistry

    catalog = build_catalog(str(bmad_v6), include_builtin=False)
    registry = ToolRegistry.build_for_workspace(
        str(bmad_v6), llm=object(), skill_catalog=catalog,
        session_scope=build_session_scope(str(bmad_v6)),
    )
    brief = registry.get("sub_agent")._brief_from_catalog("bmad-agent-analyst")
    assert brief["role"] == "Mary"
    # The child gets the persona AND its links, so it can pull the skills the
    # persona depends on instead of working from the identity section alone.
    assert "bmad-market-research" in brief["system_prompt"]


def test_sub_agent_rejects_a_name_that_is_not_an_agent(bmad_v6):
    from tools.registry import ToolRegistry

    catalog = build_catalog(str(bmad_v6), include_builtin=False)
    registry = ToolRegistry.build_for_workspace(
        str(bmad_v6), llm=object(), skill_catalog=catalog,
    )
    sub_agent = registry.get("sub_agent")
    assert sub_agent._brief_from_catalog("nope") is None
    # A plain skill is not a persona — delegating to it would silently give
    # the child knowledge instead of a role.
    assert sub_agent._brief_from_catalog("bmad-market-research") is None


def test_skill_tool_is_absent_when_there_is_nothing_to_load(tmp_path):
    from tools.registry import ToolRegistry

    registry = ToolRegistry.build_for_workspace(str(tmp_path), skill_catalog=[])
    assert registry.get("skill") is None


# ── A declaring FOLDER, under any top-level name ─────────────────────

@pytest.fixture
def any_folder(tmp_path):
    """Frameworks unpacked under names we have never heard of. A directory
    called `agent/` or `skills/` states what it holds as clearly as any
    filename convention, wherever it sits."""
    _write(tmp_path, "myframework/agent/mary.md",
           _skill("mary-analyst", "analyst", "# Mary\nbody"))
    _write(tmp_path, "myframework/agents/winston.md", _skill("winston", "api engineer"))
    _write(tmp_path, "myframework/skills/expand.md", _skill("expand-contract", "expand"))
    _write(tmp_path, "myframework/skill/rollback.md", _skill("rollback", "rollback drill"))
    _write(tmp_path, "sdlc-pack/skills/research/SKILL.md", _skill("research", "market research"))
    _write(tmp_path, "acme/personas/sally.md", _skill("sally-ux", "ux", "# Sally\nb"))
    # Documentation that merely LOOKS like it lives in the right place
    _write(tmp_path, "docs/agents/overview.md", "# How our agents work\n\nProse.")
    _write(tmp_path, "docs/skills/notes.md", "# Notes\n\nProse, no frontmatter.")
    _write(tmp_path, "node_modules/x/agents/leak.md", _skill("leaked", "must not appear"))
    return tmp_path


def test_a_declaring_folder_works_under_any_top_level_name(any_folder):
    scan = scan_custom_agents(str(any_folder))
    agents = {a["name"] for a in scan["agents"]}
    skills = {s["name"] for s in scan["skills"]}
    assert {"mary-analyst", "winston", "sally-ux"} <= agents
    assert {"expand-contract", "rollback", "research"} <= skills


def test_a_folder_named_skills_full_of_prose_is_not_a_framework(any_folder):
    """`docs/skills/notes.md` has no frontmatter. The folder is a hint, not a
    declaration — without a declared name it stays documentation, or every
    docs tree would register itself as a skill pack."""
    scan = scan_custom_agents(str(any_folder))
    sources = {s.get("source") for s in scan["skills"]} | \
              {a.get("source") for a in scan["agents"]}
    assert not any((src or "").startswith("docs/") for src in sources)
    assert "notes" not in {s["name"] for s in scan["skills"]}
    assert "leaked" not in {s["name"] for s in scan["skills"]}


def test_named_skill_files_do_not_collide_on_their_folder(any_folder):
    """`skills/expand.md` and `skills/rollback.md` are two skills, not one
    named after the directory they share."""
    catalog = build_catalog(str(any_folder), include_builtin=False)
    assert find_entry(catalog, "expand-contract") is not None
    assert find_entry(catalog, "rollback") is not None
    assert find_entry(catalog, "skills") is None


def test_folder_declared_entries_are_loadable(any_folder):
    """The whole point: they reach the catalog, so the agent can load them."""
    catalog = build_catalog(str(any_folder), include_builtin=False)
    block = render_catalog(catalog)
    assert "mary-analyst" in block and "expand-contract" in block
    entry = find_entry(catalog, "mary-analyst")
    assert entry.kind == "agent" and entry.persona == "Mary"
    assert load_body(entry, str(any_folder)) is not None


# ── Persona from a "talk to X" description ───────────────────────────

@pytest.fixture
def bmad_stubs(tmp_path):
    """A stock BMAD v6 install: frontmatter with `description:` and NOTHING
    else. The human name exists only inside that sentence."""
    for slug, who, role in [
        ("bmad-agent-analyst", "Mary", "business analyst"),
        ("bmad-agent-architect", "Winston", "architect"),
        ("bmad-agent-dev", "Amelia", "developer agent"),
    ]:
        _write(tmp_path, f".devaccel/agents/{slug}.agent.md",
               f"---\ndescription: A {role}. Use when the user asks to talk to "
               f"{who} or requests the {role}.\n---\n\nLOAD the FULL SKILL.md.\n")
    return tmp_path


def test_persona_is_read_out_of_a_talk_to_description(bmad_stubs):
    """Without this every agent in a stock BMAD install is nameless, so
    "talk to Mary" has no persona to match and the UI shows a slug."""
    agents = {a["name"]: a["persona"]
              for a in scan_custom_agents(str(bmad_stubs))["agents"]}
    assert agents == {
        "bmad-agent-analyst": "Mary",
        "bmad-agent-architect": "Winston",
        "bmad-agent-dev": "Amelia",
    }


@pytest.mark.parametrize("description", [
    "Use when the user asks to talk to the architect.",
    "Use when you want to speak with your team lead.",
    "Handles migrations. No persona here at all.",
])
def test_a_role_or_pronoun_is_not_a_persona_name(tmp_path, description):
    _write(tmp_path, ".devaccel/agents/x.agent.md",
           f"---\ndescription: {description}\n---\nbody\n")
    agents = scan_custom_agents(str(tmp_path))["agents"]
    assert agents[0]["persona"] == ""


def test_an_explicit_persona_field_beats_the_description(tmp_path):
    _write(tmp_path, ".devaccel/agents/x.agent.md",
           "---\nname: x\npersona: Priya\n"
           "description: Use when the user asks to talk to Mary.\n---\nbody\n")
    agents = {a["name"]: a["persona"] for a in scan_custom_agents(str(tmp_path))["agents"]}
    assert agents["x"] == "Priya"


# ── Skill → owning agent ─────────────────────────────────────────────

def test_a_skill_knows_which_agent_owns_it(linked):
    """Frameworks author agent→skill only. Without the inverse, a match on a
    SKILL has no way back to the agent that runs it."""
    catalog = build_catalog(str(linked), include_builtin=False)
    skill = find_entry(catalog, "expand-contract")
    assert skill.used_by == ["lead"]
    assert skill.used_by_personas == ["Winston"]


def test_the_owner_is_rendered_in_the_catalog(linked):
    block = render_catalog(build_catalog(str(linked), include_builtin=False))
    assert "<used-by>lead (Winston)</used-by>" in block


def test_an_agent_is_not_marked_as_owned_by_itself(linked):
    catalog = build_catalog(str(linked), include_builtin=False)
    assert find_entry(catalog, "lead").used_by == []


# ── Bundle scoping ───────────────────────────────────────────────────

def test_a_shared_folder_is_not_anybody_s_bundle(tmp_path):
    """agents/priya.agent.md does not own agents/winston.agent.md. Listing
    siblings as "bundled files you can read" put every unrelated persona in
    front of the model each time one of them loaded."""
    _write(tmp_path, ".devaccel/agents/priya.agent.md", _skill("priya", "one"))
    _write(tmp_path, ".devaccel/agents/winston.agent.md", _skill("winston", "two"))
    catalog = build_catalog(str(tmp_path), include_builtin=False)
    assert find_entry(catalog, "priya").resources == []


def test_a_skill_folder_still_owns_its_bundle(tmp_path):
    """skills/<name>/SKILL.md DOES own everything beside it — the folder
    exists for that skill."""
    _write(tmp_path, ".devaccel/skills/migration/SKILL.md", _skill("migration", "d"))
    _write(tmp_path, ".devaccel/skills/migration/references/rollback.md", "notes")
    catalog = build_catalog(str(tmp_path), include_builtin=False)
    assert "references/" in " ".join(find_entry(catalog, "migration").resources)


# ── Co-location: one folder tells the whole story ────────────────────

@pytest.fixture
def colocated(tmp_path):
    """The layout generation now produces: everything a skill needs lives
    inside that skill's folder, so opening it shows the method, its gate and
    its template together."""
    _write(tmp_path, ".devaccel/agents/priya/AGENT.md", _skill(
        "java-python-migrator", "Migrates Java to Python. Talk to Priya.",
        "# Priya\nbody", persona="Priya", skills="java-python-translation"))
    _write(tmp_path, ".devaccel/agents/priya/tasks/module-migration.md",
           _skill("module-migration", "Per-module steps"))
    _write(tmp_path, ".devaccel/skills/java-python-translation/SKILL.md",
           _skill("java-python-translation", "Maps Java concepts to Python"))
    _write(tmp_path, ".devaccel/skills/java-python-translation/checklists/gate.md",
           _skill("equivalence-gate", "GO/NO-GO before declaring parity"))
    _write(tmp_path, ".devaccel/skills/java-python-translation/templates/map.md",
           _skill("mapping-table", "Java to Python mapping skeleton"))
    return tmp_path


def test_nested_artifacts_keep_their_own_kind(colocated):
    """A checklist inside a skill folder is a CHECKLIST. The nearest
    declaring ancestor wins, or every gate would register as a skill."""
    catalog = build_catalog(str(colocated), include_builtin=False)
    kinds = {e.name: e.kind for e in catalog}
    assert kinds["java-python-translation"] == "skill"
    assert kinds["equivalence-gate"] == "checklist"
    assert kinds["mapping-table"] == "template"
    assert kinds["module-migration"] == "task"


def test_an_artifact_knows_the_definition_whose_folder_holds_it(colocated):
    """Ownership is read off the path — that is the entire reason for
    nesting, and it means nobody has to declare the relationship twice."""
    catalog = build_catalog(str(colocated), include_builtin=False)
    assert find_entry(catalog, "equivalence-gate").used_by == ["java-python-translation"]
    assert find_entry(catalog, "mapping-table").used_by == ["java-python-translation"]
    assert find_entry(catalog, "module-migration").used_by == ["java-python-migrator"]


def test_loading_a_skill_surfaces_its_gate_and_template(colocated):
    """The payoff: load the method and you are told about the gate it is
    meant to be run under, without having gone looking."""
    catalog = build_catalog(str(colocated), include_builtin=False)
    text = resolve_closure(find_entry(catalog, "java-python-translation"), catalog).as_text()
    assert "equivalence-gate" in text and "mapping-table" in text


def test_the_whole_chain_resolves_from_the_agent(colocated):
    """agent → skill → the skill's gate and template, from folder structure
    alone. No file in this fixture references another by path."""
    catalog = build_catalog(str(colocated), include_builtin=False)
    closure = resolve_closure(find_entry(catalog, "java-python-migrator"), catalog)
    assert {e.name for e in closure.load_order} >= {
        "java-python-migrator", "java-python-translation",
        "equivalence-gate", "mapping-table",
    }


# ── Generation writes that layout ────────────────────────────────────

def test_generation_nests_artifacts_under_their_owner():
    from spec_driven.parsers import parse_roster, roster_text_from_plan
    from spec_driven.phases.base import PhaseContext
    from spec_driven.phases.scaffold import ScaffoldPhase

    plan = {
        "summary": "s", "target": "devaccel",
        "agents": [{"name": "migrator", "description": "d", "persona": "p",
                    "persona_name": "Priya", "title": "Engineer",
                    "skills": ["translation"]}],
        "skills": [{"name": "translation", "description": "d"}],
        "artifacts": [
            {"type": "checklist", "name": "gate", "description": "d", "owner": "translation"},
            {"type": "template", "name": "map", "description": "d", "owner": "translation"},
            {"type": "task", "name": "steps", "description": "d", "owner": "migrator"},
            {"type": "data", "name": "orphan", "description": "d", "owner": ""},
        ],
    }
    ctx = PhaseContext(feature_slug="x", feature_number="001", user_request="r",
                       spec_dir="", agents_dir="", artifacts_dir="")
    ctx.target = "devaccel"
    paths = {name: path for _, path, name
             in ScaffoldPhase()._plan(parse_roster(roster_text_from_plan(plan)), ctx)}

    assert paths["migrator"] == ".devaccel/agents/migrator/AGENT.md"
    assert paths["translation"] == ".devaccel/skills/translation/SKILL.md"
    assert paths["gate"] == ".devaccel/skills/translation/checklists/gate.md"
    assert paths["map"] == ".devaccel/skills/translation/templates/map.md"
    assert paths["steps"] == ".devaccel/agents/migrator/tasks/steps.md"
    # No owner → the workspace-level folder, rather than being dropped.
    assert paths["orphan"] == ".devaccel/data/orphan.md"


def test_generated_layout_is_discoverable_by_the_scanner(tmp_path):
    """The loop that matters: what generation writes, discovery must read
    back. A layout only one half agrees with is worse than either alone."""
    from spec_driven.parsers import parse_roster, roster_text_from_plan
    from spec_driven.phases.base import PhaseContext
    from spec_driven.phases.scaffold import ScaffoldPhase

    plan = {
        "summary": "s", "target": "devaccel",
        "agents": [{"name": "migrator", "description": "Talk to Priya.",
                    "persona": "p", "persona_name": "Priya", "title": "Eng",
                    "skills": ["translation"]}],
        "skills": [{"name": "translation", "description": "d"}],
        "artifacts": [{"type": "checklist", "name": "gate", "description": "d",
                       "owner": "translation"}],
    }
    ctx = PhaseContext(feature_slug="x", feature_number="001", user_request="r",
                       spec_dir="", agents_dir="", artifacts_dir="")
    ctx.target = "devaccel"
    for _, path, name in ScaffoldPhase()._plan(parse_roster(roster_text_from_plan(plan)), ctx):
        if path.endswith(".yaml"):
            continue
        _write(tmp_path, path, _skill(name, f"{name} description"))

    catalog = build_catalog(str(tmp_path), include_builtin=False)
    kinds = {e.name: e.kind for e in catalog}
    assert kinds["migrator"] == "agent"
    assert kinds["translation"] == "skill"
    assert kinds["gate"] == "checklist"
    assert find_entry(catalog, "gate").used_by == ["translation"]


# ── Hand-written files ───────────────────────────────────────────────

def test_a_file_without_fences_still_registers(tmp_path):
    """Someone typing an agent by hand writes the fields they were shown, not
    necessarily the `---` delimiters around them. The file is unmistakably a
    definition; rejecting it over punctuation made the agent vanish from the
    picker with no explanation."""
    _write(tmp_path, ".devaccel/agents/amar/AGENT.md",
           "name: python-to-golang-migrator\r\n"
           "persona:Amar\r\n"                      # no space after the colon
           "title: Principal Python-to-golang Migration Engineer\r\n"
           "description: Owns Python to golang migrations. Talk to Amar.\r\n"
           "skills: java-python-migration\r\n"
           "\r\n# Amar\r\nBody text.\r\n")
    agents = {a["name"]: a for a in scan_custom_agents(str(tmp_path))["agents"]}
    entry = agents["python-to-golang-migrator"]
    assert entry["persona"] == "Amar"
    assert entry["title"] == "Principal Python-to-golang Migration Engineer"
    assert entry["skills"] == ["java-python-migration"]
    assert "name:" not in entry["system_prompt"]


@pytest.mark.parametrize("body", [
    "# Heading\n\nSome prose about the project.\n",
    "Note: this is a document.\nAuthor: someone\n",   # keys, but not ours
    "name: lonely\n",                                  # one key is not a block
])
def test_prose_is_not_promoted_to_a_definition(tmp_path, body):
    _write(tmp_path, ".devaccel/agents/x/AGENT.md", body)
    scan = scan_custom_agents(str(tmp_path))
    assert [a["name"] for a in scan["agents"] if a["name"] not in ("x",)] == []


def test_a_principal_file_is_named_after_its_folder(tmp_path):
    """`agents/priya/AGENT.md` with no declared name is Priya's agent, not
    one called "AGENT" — the folder exists for it. That fallback showing up
    in the picker as "AGENT / AGENT" is how the bug was spotted."""
    _write(tmp_path, ".devaccel/agents/priya/AGENT.md",
           "---\ndescription: A migration engineer.\n---\nbody\n")
    agents = [a["name"] for a in scan_custom_agents(str(tmp_path))["agents"]]
    assert agents == ["priya"]


# ── Shared vs per-skill config ───────────────────────────────────────

def _scaffold_paths(plan, workspace=""):
    from spec_driven.parsers import parse_roster, roster_text_from_plan
    from spec_driven.phases.base import PhaseContext
    from spec_driven.phases.scaffold import ScaffoldPhase

    ctx = PhaseContext(feature_slug="x", feature_number="001", user_request="r",
                       spec_dir="", agents_dir="", artifacts_dir="",
                       workspace=str(workspace))
    ctx.target = "devaccel"
    return {name: path for _, path, name
            in ScaffoldPhase()._plan(parse_roster(roster_text_from_plan(plan)), ctx)}


_PLAN = {
    "summary": "s", "target": "devaccel",
    "agents": [{"name": "migrator", "description": "d", "persona": "p",
                "persona_name": "Priya", "title": "Eng", "skills": ["translation"]}],
    "skills": [{"name": "translation", "description": "d"}],
    "artifacts": [
        {"type": "checklist", "name": "gate", "description": "d", "owner": "translation"},
        {"type": "settings", "name": "translation-settings", "description": "d",
         "owner": "translation"},
    ],
}


def test_a_skill_s_own_settings_live_in_its_folder(tmp_path):
    """Settings that belong to ONE skill stay with that skill, so nothing
    about it is spread across the workspace."""
    paths = _scaffold_paths(_PLAN, tmp_path)
    assert paths["translation-settings"] == ".devaccel/skills/translation/config.yaml"
    assert paths["gate"] == ".devaccel/skills/translation/checklists/gate.md"


def test_the_shared_config_is_not_copied_into_each_skill(tmp_path):
    """core-config.yaml stays ABOVE the skills. Nesting it would mean the
    same `user_name` maintained once per skill, and a second skill could not
    see the first one's copy."""
    paths = _scaffold_paths(_PLAN, tmp_path)
    assert paths["core-config"] == ".devaccel/core-config.yaml"


def test_an_existing_shared_config_is_never_replanned(tmp_path):
    """Regenerating it would discard the settings of every agent built before
    this run — which is exactly what happens when you add a second skill."""
    _write(tmp_path, ".devaccel/core-config.yaml", "user_name: Charles\n")
    assert "core-config" not in _scaffold_paths(_PLAN, tmp_path)


def test_a_second_skill_inherits_shared_and_overrides_its_own(tmp_path):
    """The payoff of keeping the two apart: adding a skill cannot disturb the
    first one, and each still gets the shared values."""
    _write(tmp_path, ".devaccel/core-config.yaml",
           "user_name: Charles\noutput_folder: shared-out\n")
    _write(tmp_path, ".devaccel/skills/first/SKILL.md", _skill("first", "d"))
    _write(tmp_path, ".devaccel/skills/first/config.yaml", "output_folder: first-out\n")
    _write(tmp_path, ".devaccel/skills/second/SKILL.md", _skill("second", "d"))

    catalog = build_catalog(str(tmp_path), include_builtin=False)
    session = build_session_scope(str(tmp_path))
    scope_of = lambda n: module_scope_for(
        str(tmp_path), find_entry(catalog, n).parent_chain, session)

    assert scope_of("first")["output_folder"] == "first-out"    # its own wins
    assert scope_of("first")["user_name"] == "Charles"          # shared inherited
    assert scope_of("second")["output_folder"] == "shared-out"  # untouched
