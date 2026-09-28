# BMAD-METHOD Reference (knowledge base — injected, never shown to the user)

BMAD (Breakthrough Method for Agile AI-Driven Development): AI agents,
tasks, templates, checklists and workflows are plain Markdown + YAML text
files. Do not invent conventions — follow this spec exactly.

## Philosophy
1. Agentic planning first (rich documents), context-engineered development
   second (documents sharded into small self-contained story files).
2. Everything is a text file — any LLM that reads Markdown can "run" it.
3. Lazy loading: agents declare `dependencies:` and load a file only when
   a command needs it. Never preload everything.
4. Templates are self-executing: they contain BOTH the output structure
   AND the instructions for interviewing the user to fill it.

## Layout in THIS product
BMAD's `.bmad-core/` maps to `.devaccel/` (DevSphere's agent workspace):

```
.devaccel/
  core-config.yaml         # project config & doc paths (emit when the
                           # plan includes templates/tasks/workflows)
  agents/<id>.agent.md     # one file per agent persona
  skills/<name>/SKILL.md   # reusable know-how an agent loads (maps to
                           # BMAD data/ knowledge; linked via `skills:`)
  templates/<name>-tmpl.yaml
  tasks/<name>.md
  checklists/<name>.md
  workflows/<name>.yaml
  data/<name>.md           # knowledge bases / reference material
```

Naming (STRICT): every filename kebab-case; templates end `-tmpl.yaml`;
stories `{epicNum}.{storyNum}.story.md`; workflows named
`greenfield-*`/`brownfield-*` when applicable.

## Agent files
Frontmatter (name, description, tools, skills) + BMAD-style body:
persona (role, style, identity, focus, core principles), On Activation
steps, commands section (`*help`, `*exit` always; `*` prefix convention),
gated workflow, dependencies list naming ONLY files that exist in the
plan. Agents stay ~100-200 lines.

## Template files (`templates/<name>-tmpl.yaml`)
```yaml
template:
  id: <kebab-id>
  name: <Human Name>
  version: 1.0
  output:
    format: markdown
    filename: docs/<name>.md
    title: "{{project_name}} <Document Title>"
workflow:
  mode: interactive            # interactive | yolo
sections:
  - id: <kebab-id>
    title: <Heading>
    instruction: |             # directive to the LLM — never copied to output
      <how to draft this section>
    elicit: true               # HARD STOP: show draft + numbered options, wait
    type: bullet-list          # bullet-list | numbered-list | table |
                               # paragraphs | code-block | mermaid
    prefix: FR                 # numbered items FR1, FR2, …
    repeatable: true           # instantiated N times
    condition: <expr>          # emit only when condition holds
    owner: <agent-id>          # who creates/edits the section afterwards
    editors: [<agent-ids>]
    sections: [...]            # recursive nesting → ##, ###, #### headings
```
`{{var}}` = placeholder substituted at generation time. The FINAL generated
document must contain ZERO markers (`instruction:`, `[[LLM: …]]`,
`{{…}}`, `@{example…}` are all consumed during generation).

## Task files (`tasks/<name>.md`)
Executable procedures, not reference material:
```markdown
# <Task Name>
## Purpose
## CRITICAL EXECUTION NOTICE
- Executable workflow; complete each step fully; HALT on user interaction
## SEQUENTIAL Task Execution
### 1. <step>  … numbered steps, explicit HALT/elicit points,
### 2. <step>  cite sources as [Source: <file>#<section>]
```

## Checklist files (`checklists/<name>.md`)
```markdown
# <Checklist Name>
[[LLM: work through each item; mark [x] done, [ ] not done, [N/A] + reason;
end with pass-rate summary and GO/NO-GO recommendation]]
## 1. <Group>
- [ ] <verifiable item>
```

## Workflow files (`workflows/<name>.yaml`)
```yaml
workflow:
  id: <kebab-id>
  name: <Human Name>
  description: <one line>
  type: greenfield | brownfield | other
  sequence:
    - agent: <agent-id>
      creates: <output file>
      requires: [<inputs>]
      condition: <optional>
    - repeat_development_cycle:
        - agent: <id>
          action: <verb_phrase>
  handoff_prompts:
    <from>_to_<to>: "<what to tell the next agent>"
```
Every `agent:` in a sequence MUST be an agent in the plan; every
`creates:`/`requires:` must map to a real template output or file.

## core-config.yaml
```yaml
docs:
  location: docs
devLoadAlwaysFiles: []       # files an implementing agent loads every session
storyLocation: docs/stories
slashPrefix: BMad
```

## Story files (when a workflow produces them): docs/stories/{e}.{s}.story.md
Sections: Status / Story (As a…, I want…, so that…) / Acceptance Criteria
(numbered) / Tasks-Subtasks (checkboxes, ref AC numbers) / Dev Notes (all
architecture context inline with [Source: …] citations) / Change Log /
Dev Agent Record / QA Results. Section ownership is enforced.

## HARD RULES
- Never leak `instruction:`, `[[LLM: ]]`, elicitation menus or
  `@{example}` into a generated DOCUMENT (templates themselves contain
  them by design).
- Never reference a file the plan does not create.
- User choices are numbered lists; user replies with a number.
- `{project-root}` and `{user_input}` are literal runtime placeholders.
- Keep every file lean and focused on one purpose.
