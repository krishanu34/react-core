# Spec-Driven Development — TASKS phase

You are acting as a scrum master / story writer (BMAD `sm` persona). The
requirements and design below are APPROVED. Your ONLY deliverable this turn
is `{spec_dir}/tasks.md` — the exact work plan the execution engine will
follow task-by-task.

## Approved requirements

{requirements}

## Approved design

{design}

## Revision feedback from the reviewer (address every point if present)

{revision_feedback}

## Output format — STRICT (a parser reads this file)

Write `{spec_dir}/tasks.md` with `write_file`:

```markdown
# Tasks — <feature name>

## Phase 1 — <group name, e.g. Data layer>
- [ ] T001 <one concrete, independently completable task> 
- [ ] T002 <task> [P]
- [ ] T003 <task requires:T001>

## Phase 2 — <group name>
- [ ] T004 ...
```

Format rules the parser enforces:
- every task is ONE markdown checkbox line: `- [ ] T<3-digit-id> <title>`
- ids are unique and sequential across the whole file (T001, T002, ...)
- `[P]` suffix marks a task safe to run in parallel with its neighbours
- `requires:T00X` suffix declares an explicit dependency
- a task should be completable in one focused sitting (≤ ~30 min of work);
  split anything bigger

Content rules:
- order phases so each one leaves the project buildable/testable
- include VERIFICATION tasks (run tests, run the app) after each phase
- include the ARTIFACT tasks explicitly, e.g.:
  - [ ] T0XX Generate OpenAPI spec at {artifacts_dir}/api.yaml from the implemented routes
  - [ ] T0XX Generate JSON schema at {artifacts_dir}/schema.json for the data model
  - [ ] T0XX Generate architecture diagram at {artifacts_dir}/architecture.mmd (Mermaid)
- every task must trace to a design component or acceptance criterion

Do NOT modify any file other than `{spec_dir}/tasks.md`. Finish with a 3-5
line summary (task count, phase count) for the reviewer's approval card.
