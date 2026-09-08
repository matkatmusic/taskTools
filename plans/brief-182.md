# Task 182: Restore the two retired instruction paragraphs as commented text beneath the RETIRED marker (audit C86-16)

## User request

Required retired instruction text was deleted instead of retained as comments. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-15.

This is finding C86-16 (LOW) in plans/task-86-codex-audit.md.

The closing plan's Edit 1.3 requires the two superseded instruction paragraphs to remain verbatim as //-prefixed text beneath a RETIRED marker. scripts/tackleTasksBrief.ts:164 currently contains only a one-line tombstone:

  // RETIRED (task 163): old close-tasks-skill text superseded by task 152's closeTasks.ts call; see git history.

That does not meet the task-86 spec's transitional rule, which says retired code stays commented out and only wholly superseded FILES are removed.

The expected pattern already exists in this codebase: scripts/runMergePhase.ts carries several `// RETIRED (task 147): ...` comments that retain the full superseded logic rather than pointing at git history. Follow that shape.

DIRECTION settled with the user: restore the commented text. Do not amend the spec -- the transitional rule stands, and changing it would loosen the rule for every other retirement in the codebase, not just this one spot.

THE EXACT TEXT TO RESTORE is recoverable from commit 6948357, which removed it from scripts/tackleTasksBrief.ts. The two paragraphs are:

1. "Close every task that is not problematic and was completed successfully, rendering its `tasks.json` entry stale, with **one** invocation of the `close-tasks` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces -- `[268,270,281]` -- followed by your reasoning for the `closureNote`s, naming each task (`#268 ...`, `#270 ...`) when the reasons differ."

2. "During implementation, you (the orchestrator) run typecheck only -- no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside `close-tasks`, after the user approves closing."

Recover them from `git show 6948357 -- scripts/tackleTasksBrief.ts` rather than retyping, so they are byte-for-byte verbatim, and place them beneath the existing RETIRED marker, each line //-prefixed.

Watch out: tests pin the generated brief output byte-for-byte. These are comments in the emitter source, not brief output, so they must NOT change what the brief emits.

## Files

@scripts/tackleTasksBrief.ts
@tests/tackleTasksBrief.test.ts