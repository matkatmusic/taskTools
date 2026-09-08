# Task 171: Drive the generated orchestration against task.workflow.js's real result envelope (audit C86-06)

## User request

The generated driver reads the wrong workflow result envelope. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-05.

This is finding C86-06 (HIGH) in plans/task-86-codex-audit.md.

task.workflow.js returns { task, stage, results: [...] } (skills/tackle-tasks/task.workflow.js:712-727). The generated driver text in scripts/tackleTasksBrief.ts (the merge-queue loop step, around lines 143-146) tells the executor to inspect the workflow result's status and lastFailure DIRECTLY, instead of reading the relevant member of results. The approval gate instructions likewise never map the plan/implement results array to the verifier result and the fence violations.

A literal executor therefore observes undefined status and failure fields and records the wrong queue outcome.

The tests mask the mismatch: tests/runMergePhase.test.ts:266-275 knows the true shape and manually unwraps workflowResult.results[0]. That hand-indexing is exactly what hides the instruction/API gap, so a fix must remove the need for it rather than keep it.

Fix: define ONE documented result type per stage, then rewrite the driver prose in tackleTasksBrief.ts to name which results member each stage reads -- rebase-test, merge, and the plan/implement stage's plan, implement and verifier outputs plus fence violations -- matching the envelope task.workflow.js actually returns. Add or extend a test that drives the generated instructions against a real, non-synthetic workflow result.

Watch out: tests pin the generated brief text byte-for-byte, so the new driver wording and those assertions must land together.

## Files

@scripts/tackleTasksBrief.ts
@skills/tackle-tasks/task.workflow.js
@tests/runMergePhase.test.ts
@tests/tackleTasksBrief.test.ts