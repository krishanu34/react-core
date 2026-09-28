---
name: bmad_method
description: The BMAD-METHOD: agents, tasks, templates, checklists and workflows as Markdown+YAML. Use when the user mentions BMAD, a story file, a PRD, sharding, or wants BMAD-style artifacts generated.
---

# Skill: BMAD-METHOD (Breakthrough Method for Agile AI-Driven Development)

BMAD defines AI agents, tasks, templates, checklists and workflows as plain
Markdown + YAML files. When the user asks about BMAD or wants BMAD-style
artifacts, follow these conventions exactly — do not invent your own.

## Folder conventions
- Canonical BMAD install: `.bmad-core/` (or `_bmad/` in v6) with `agents/`,
  `templates/`, `tasks/`, `checklists/`, `workflows/`, `data/`,
  `core-config.yaml`. Generated documents live in `docs/` (prd.md,
  architecture.md, sharded `docs/prd/`, `docs/stories/{e}.{s}.story.md`).
- In THIS product the same artifact types live under `.devaccel/`
  (agents/, skills/, templates/, tasks/, checklists/, workflows/, data/).
- All filenames kebab-case; templates end `-tmpl.yaml`.

## File formats (essentials)
- **Agent**: persona (role, style, identity, focus, core principles),
  commands with `*` prefix (`*help`, `*exit` always), lazy `dependencies:`
  — only load a dependency when a command needs it.
- **Template** (`*-tmpl.yaml`): `template:` metadata + `sections:` tree.
  Per section: `instruction:` (LLM-only, never emitted), `elicit: true`
  (hard stop — show draft + numbered options, wait for the user),
  `repeatable`, `condition`, `type` (bullet-list/numbered-list/table/…),
  `owner`/`editors`. `{{var}}` placeholders are substituted at generation
  time; the final document contains ZERO markers.
- **Task**: executable numbered procedure with explicit HALT points,
  `[Source: file#section]` citations.
- **Checklist**: `- [ ]` items grouped under numbered headings; result is
  a pass-rate summary + GO/NO-GO.
- **Workflow** (`.yaml`): `sequence:` of `agent / creates / requires`
  steps plus optional `repeat_development_cycle` and `handoff_prompts`.
- **Story**: Status / Story / Acceptance Criteria / Tasks / Dev Notes
  (self-contained context with source citations) / Dev Agent Record / QA
  Results — with per-agent section ownership.

## Hard rules
- Never leak `instruction:`, `[[LLM: …]]` or elicitation menus into a
  generated document.
- Never reference files that don't exist.
- Present user choices as numbered lists.
