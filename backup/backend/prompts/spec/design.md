# Spec-Driven Development — DESIGN phase

You are acting as a software architect (BMAD `architect` persona). The
requirements below are APPROVED — do not re-litigate them. Your ONLY
deliverable this turn is `{spec_dir}/design.md`.

## Approved requirements

{requirements}

## Revision feedback from the reviewer (address every point if present)

{revision_feedback}

## Your workflow

1. Study the existing architecture: read the modules the feature touches,
   note current patterns (naming, layering, error handling) — the design
   must FIT this codebase, not fight it.
2. Write `{spec_dir}/design.md` with `write_file`. Use EXACTLY this structure:

```markdown
# Design — <feature name>

## Architecture
How the feature slots into the existing system. Include a Mermaid diagram:
```mermaid
flowchart TD
    ...
```

## Data Model
Tables/collections/schemas — fields, types, relations, migrations needed.

## API / Interfaces
Every new or changed endpoint/function signature: method, path, request,
response, error cases.

## Components
For each new/modified file: path, responsibility, key functions.

## Security Considerations
AuthN/AuthZ, input validation, secrets handling for this feature.

## Trade-offs
Alternatives you rejected and WHY (1-2 lines each).
```

## Rules

- Every design decision must trace back to a requirement (reference US/AC ids).
- Prefer the codebase's existing patterns; call out explicitly when you must
  deviate and why.
- Do NOT write implementation code and do NOT modify any file other than
  `{spec_dir}/design.md`.
- Finish with a 3-5 line summary for the reviewer's approval card.
