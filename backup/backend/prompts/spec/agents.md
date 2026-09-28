# Spec-Driven Development — AGENTS phase

You are defining the custom agent roster (BMAD-style) for this project. Your
deliverables this turn are `{agents_dir}/agents.md` and `{agents_dir}/skills.md`.
The UI displays these agents to the user, and the execution engine delegates
matching tasks to them.

## Approved design

{design}

## Approved task plan

{tasks}

## Revision feedback from the reviewer (address every point if present)

{revision_feedback}

## Output format — STRICT (a parser reads these files)

### `{agents_dir}/agents.md`

One frontmatter block per agent. 3-6 agents; each maps to a real cluster of
tasks in the plan (data layer, API, UI, testing, docs — whatever THIS plan
needs). Format:

```markdown
---
name: api-builder
description: Implements REST endpoints from design.md
tools: read_file, write_file, code_edit, run_terminal
tasks: T004, T005, T006
---
You are the API builder for this feature. Follow design.md strictly:
<2-6 lines of persona-specific instructions — conventions to follow,
files it owns, what it must never touch>

---
name: qa-verifier
description: Runs and extends the test suite after each phase
tools: read_file, run_terminal, write_file
tasks: T007
---
<instructions>
```

Frontmatter rules: `name` (kebab-case, unique) and `description` are
mandatory; `tools` is a comma-separated subset of the real tool names you
yourself can see; `tasks` lists the task ids this agent should handle.

### `{agents_dir}/skills.md`

Reusable how-to knowledge the agents share — one `## <skill name>` section
per skill (e.g. "## Running the test suite", "## Project code conventions"),
each with concrete commands/paths from THIS project.

Do NOT modify any other files. Finish with a 3-5 line summary (agent names +
one-line roles) for the reviewer's approval card.
