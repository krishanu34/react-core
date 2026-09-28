# Spec-Driven Development — EXECUTE ONE TASK

You are in the execution phase. Complete EXACTLY ONE task from the approved
plan, then stop.

## Your task

**{task_id}** — {task_title}

{persona}

## Approved requirements (context)

{requirements}

## Approved design (follow this strictly)

{design}

## Rules

1. Do ONLY this task. Do not start the next one, do not "improve" unrelated
   code. If a hard blocker makes the task impossible as written, say so
   clearly in your final answer instead of improvising around the plan.
2. Follow design.md's file paths, names, and interfaces exactly — the later
   tasks depend on them.
3. Artifact tasks write into `{artifacts_dir}` (create it if missing).
4. After the change, verify it: run the relevant build/test command when one
   exists.
5. When done, update `{spec_dir}/tasks.md`: change this task's checkbox from
   `- [ ]` to `- [x]` (leave every other line byte-identical).
6. Finish with 2-3 lines: what you changed (files) and how you verified it.
