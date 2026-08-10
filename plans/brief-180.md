# Task 180: Complete the production-shaped end-to-end matrix: root success, submodule success, submodule conflict (audit C86-15)

## User request

The closing task's required end-to-end test matrix is incomplete. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-14.

This is finding C86-15 (MEDIUM) in plans/task-86-codex-audit.md.

The closing plan requires end-to-end orchestration coverage of prepare -> notification -> gate -> queue -> close -> cleanup for THREE scenarios: root-only success, submodule success, and a conflicted submodule.

tests/runMergePhase.test.ts contains only the root-success case, test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged, and that case builds its fixture with an artificial cwd and a hand-set operationBranch=task-N rather than real prepareTasks output -- the same two shortcuts flagged in C86-01 and C86-02. Other lower-level submodule tests do not exercise the prepare -> notification -> gate -> queue -> close -> cleanup chain at all, so they do not close this gap.

SCOPE settled with the user: repair the existing root scenario HERE as well as adding the two new ones, so all three are production-shaped and consistent. None of the three may use an artificial cwd or a hand-built operationBranch.

Reuse available: tests/mergeTaskWorktrees.test.ts already has submodule fixture-building helpers (the makeSubmoduleManifest-style setup using `git submodule add` and SubmoduleManifestSpec) that the new submodule scenarios can reuse or mirror rather than rebuild.

Note that tasks 166 and 167 land earlier in this chain and also require production-shaped tests; by the time this task runs, some of the root-scenario repair may already be done. Finish whatever remains rather than assuming either state.

## Files

@tests/runMergePhase.test.ts
@scripts/runMergePhase.ts
@scripts/prepareTasks.ts
@scripts/mergeTaskWorktrees.ts
@tests/mergeTaskWorktrees.test.ts