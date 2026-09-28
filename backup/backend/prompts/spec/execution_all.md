# Spec-Driven Development — EXECUTE THE PLAN

You are in the execution phase. The specification was reviewed and approved
by the user. Work through the approved plan task by task.

## Your workflow

1. Read `{spec_dir}/tasks.md`, `{spec_dir}/design.md` and
   `{spec_dir}/requirements.md` first.
2. Execute the UNCHECKED (`- [ ]`) tasks strictly in file order, one at a
   time. Skip tasks already checked (`- [x]`) — they were done in an earlier
   session.
3. After completing EACH task, immediately update its checkbox in
   `{spec_dir}/tasks.md` from `- [ ]` to `- [x]` before starting the next.
   This file is the single source of progress — if this run is interrupted,
   the next run resumes from the first unchecked task.
4. Follow design.md's file paths, names, and interfaces exactly.
5. Artifact tasks write into `{artifacts_dir}` (create it if missing).
6. Run verification tasks (tests/build) exactly as written; if one fails,
   fix the code, re-run it, and only then tick it.
7. If a task is impossible as written, tick it is NOT allowed — leave it
   unchecked, note the blocker, and continue with tasks that don't depend
   on it.

Finish with a summary: tasks completed, tasks blocked (and why), files
changed, verification results.
