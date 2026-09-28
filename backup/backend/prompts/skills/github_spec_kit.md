---
name: github_spec_kit
description: The GitHub Spec Kit method — specify, clarify, plan, tasks, implement, driven by files under a numbered feature folder. Use when the user types /specify, /clarify, /plan, /tasks or /implement, asks for spec-driven development, or wants requirements and a task list before any code is written.
---

## GitHub Spec Kit — Spec-Driven Development

The premise: **the specification is the source of truth, and code is generated
from it.** Nothing gets built from a chat message alone. Each feature earns a
numbered folder, and each phase writes one file that the next phase reads.

```
.devaccel/spec/001-user-auth/
    requirements.md    WHAT and WHY   — user stories + acceptance criteria
    design.md          HOW            — architecture, contracts, data model
    tasks.md           IN WHAT ORDER  — numbered, checkable, dependency-aware
```

### The five commands

| Command | Phase | Produces | The question it answers |
|---|---|---|---|
| `/specify` | requirements | `requirements.md` | What are we building, for whom, and how do we know it works? |
| `/clarify` | requirements | `requirements.md` | Which assumptions are still unresolved? |
| `/plan` | design | `design.md` | What is the architecture and which contracts does it need? |
| `/tasks` | tasks | `tasks.md` | What is the ordered, verifiable work list? |
| `/implement` | execution | code | Walk `tasks.md` top to bottom, ticking as you go. |

Each phase is a **gate**: the file is written, the user reviews it, and only an
approval moves the workflow on. A revision at a gate re-runs that phase with
the feedback — it does not patch the file behind the user's back.

### requirements.md

Numbered user stories, each with acceptance criteria written so they can be
checked rather than argued about.

```markdown
## US-001 — Sign in with email
As a returning user, I want to sign in with my email and password
so that I can reach my workspace.

### Acceptance criteria
- [ ] AC-001.1  A valid credential pair returns a session token
- [ ] AC-001.2  An invalid pair returns 401 with no user-existence hint
- [ ] AC-001.3  Five failures in 15 minutes locks the account for 15 minutes

### Open questions
- Q1  Is SSO in scope for this release?
```

Write down what you do **not** know as an open question instead of choosing
for the user. An unasked question becomes a wrong assumption in `design.md`
and a wasted task in `tasks.md`.

### design.md

Architecture, component responsibilities, data model, API contracts, and the
error and edge-case behaviour. Every decision traces to a requirement id — a
design element that maps to no `US-xxx` is scope you invented.

### tasks.md

The checkbox convention is machine-read, so the format is not cosmetic:

```markdown
## Phase 1 — Data layer
- [ ] T001 Create the users table migration
- [ ] T002 Add the User model and repository requires:T001
- [ ] T003 Unit-test the repository [P] requires:T002
- [ ] T004 Unit-test the password hasher [P] requires:T002
```

- `T###` — the id later tasks depend on
- `[P]` — safe to run in parallel with its neighbours
- `requires:T001,T002` — hard dependencies; the task will not start until
  they are ticked

A task is one verifiable change: one file or one tight group, with a stated
way to prove it worked. "Implement authentication" is an epic, not a task.

### Working with an existing spec

Read the folder before writing anything. If `requirements.md` exists, the
current request is either an amendment to it or a new feature that deserves
its own numbered folder — decide which and say which. Never silently rewrite
an approved requirement: add, supersede, and note what changed.
