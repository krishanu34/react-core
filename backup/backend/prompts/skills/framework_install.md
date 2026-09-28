---
name: framework_install
description: Fetch an external SDLC framework (BMAD, Spec Kit, an internal methodology, a published skill pack) and lay it out in this workspace so its agents and skills become loadable. Use when the user asks to install, import, pull in, or set up a framework or skill pack that is not in the workspace yet.
---

## Installing a framework into this workspace

A framework becomes usable the moment its files are on disk in a shape the
catalog recognises. There is no registration step and no database — discovery
is by filename, so the only real job is putting the right text in the right
place.

### 1. Find out what you are installing

If the user named a known framework, fetch its source: `web_search` for the
canonical repository or docs, then `web_fetch` the specific pages. If they
pointed at a URL or a repo, go straight there.

Do **not** invent a framework's content. If you cannot retrieve the real
definitions, say so and offer to generate a workspace-specific methodology
instead (that is the agent-builder's job, not this one). A plausible-looking
BMAD that isn't BMAD is worse than none.

### 2. Check what is already here

Run `workspace_tree` or `list_directory` on `.devaccel/`, `.claude/`,
`.agents/`, `.github/` and `_bmad/` first. If a framework is already present,
you are extending or upgrading it — tell the user which files you will
overwrite and what will be preserved before writing anything.

### 3. Lay it out

The default home is `.devaccel/`. Discovery reads any of these, at any depth:

```
.devaccel/skills/<name>/SKILL.md        one skill per folder  (preferred)
.devaccel/skills.md                     several skills in one stacked file
.devaccel/agents/<name>.agent.md        one agent per file
.devaccel/<anything>/SKILL.md           any nesting you like
```

Keep a framework's own internal structure when it has one — a BMAD install
that keeps `_bmad/<module>/agents/` is easier to update later than one
flattened into our layout. Discovery handles both.

Every file gets frontmatter, because the catalog is built from it:

```markdown
---
name: market-research
description: Competitive landscape and customer needs. Use when the user
  asks for market research or a competitive analysis.
---
```

Write `description` as a **trigger**, not a title: it is the only thing the
model sees before deciding whether to load the file. "Market research" says
nothing; "Use when the user asks for market research or a competitive
analysis" routes correctly.

For an agent, add the identity fields so the user can address it by name:

```markdown
---
name: analyst
persona: Mary
title: Senior Business Analyst
description: Requirements elicitation and market analysis. Use when the user
  asks to talk to Mary or requests the business analyst.
skills: market-research, domain-research
---

# Mary
```

### 4. Wire up the shared config

If the framework has settings its files refer to — output folders, the user's
name, a language — put them in a config file **above** the skills, so every
skill on that path can resolve them:

```yaml
# .devaccel/core-config.yaml
user_name: Charles
output_folder: "{project-root}/.devaccel/output"
planning_artifacts: "{project-root}/.devaccel/planning"
```

Skill bodies then reference `{planning_artifacts}` and it resolves when the
skill loads. Placeholders that resolve to nothing are reported to whoever
loads the file, so a missing key is visible rather than silent — but it is
still better to write the config.

### 5. Confirm it registered

List the folder you wrote to and tell the user what is now available by name.
The catalog is rebuilt per request, so the new entries appear on the next
message with no restart.
