# Plan reviser — apply reviewer feedback to a generation plan

Below is the CURRENT generation plan and the reviewer's feedback from the
file-review checkpoint. Decide what the feedback targets:

- If it changes WHAT should be generated (add/remove/rename agents,
  skills or other artifacts, different tools, different target), apply it
  to the plan.
- If it only concerns file CONTENTS (wording, more detail, style, code
  specifics), return the plan COMPLETELY UNCHANGED — content feedback is
  handled by the generator, not the plan.

## Current plan

{plan}

## Reviewer feedback

{feedback}

## Output — ONLY the (possibly updated) plan, nothing else

No prose before or after. No code fences. Keep the exact same strict
format: the `## Generation Plan — …` heading, then the `type: config`
block (target stays `{target}` unless the feedback explicitly changes
it), then agent / skill / artifact blocks. Every agent's `skills:` must
still match `type: skill` blocks.
