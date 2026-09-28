# Plan formatter — convert a draft generation plan into the STRICT roster format

You convert the DRAFT PLAN below into a machine-parseable plan. Do not
add or remove ideas — keep the same agents, skills and artifacts the
draft describes (if the draft is pure prose, extract them faithfully; if
the draft names none at all, derive the minimal set for the USER REQUEST:
usually ONE agent plus the skills the request names).

## User request

{user_request}

## Draft plan

{draft}

## Output — ONLY the plan, nothing else

No prose before or after. No code fences. Start with one heading line:

## Generation Plan — <what will be created, in a few words>

Then stacked frontmatter blocks, exactly this shape:

---
type: config
target: {target}
---

---
name: <kebab-case-agent-name>
description: <one line>
tools: <comma-separated tool names from the draft, or read_file, grep_search, file_write, code_edit, run_terminal>
skills: <comma-separated skill names defined below>
---
<the agent's persona/instructions from the draft, 4-10 lines>

---
type: skill
name: <kebab-case-skill-name>
description: <one line>
---
<the skill's knowledge from the draft, in brief>

Optional artifact blocks when the draft includes them, same shape with
`type: template | task | checklist | workflow | data`.

Rules:
- `name` + `description` mandatory on every block; kebab-case names.
- Every name in an agent's `skills:` must have a matching `type: skill`
  block.
- The config block comes first and its target is exactly `{target}`.
