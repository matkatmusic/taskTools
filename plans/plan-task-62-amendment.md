# Amendment: Plan: task 62 — fold handoffFilePaths into readFilePaths

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/plan-task-62.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/62.json
Sections: 6 | Fixes: 0
Efficacy: 100%
Ruling: plans/plan-task-62.md can be used as is.

## Issues

None found.

## Sections that hold up

- Behavior in plain English — verified against `scripts/shared/appendTask.ts:22,69-71` (the only writer) and `rg handoffFilePaths` over `scripts/` and `tests/` (no reader outside skill prose and one `appendTask.test.ts` assertion). The planner, implementer, and both fix prompts build their `/read-file` line from `readFilePaths`: `scripts/tackle-tasks/shared/planPrompt.ts:529`, `scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.ts:394`, `scripts/tackle-tasks/fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.ts:224`, `scripts/tackle-tasks/fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.ts:226`. FIX_CONFLICTS reads only the conflict files (`scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts:228`), which is outside this task's intent.
- Files this plan touches — verified against `tests/prepareTasks.test.ts:6-30` (`mkdirSync`, `writeFileSync`, `join`, `writeTaskBriefFile`, `loadPreparedTask` are already imported) and `scripts/tackle-tasks/shared/preparedTask.ts:58-116`.
- Step 1 — verified against `tests/prepareTasks.test.ts:38-47,744-758` (`makeTempRepoWithCommit` returns a path with no trailing slash; the mirrored test's setup matches line for line). Against `scripts/tackle-tasks/shared/preparedTask.ts:69-70,102` today: `readOnlyFiles` defaults to `["*"]` and is filtered out, so the second test's `readFilePaths` has no read-only entry and nothing throws; the first test yields two entries, not three. Both tests fail RED as the plan says.
- Step 2 — verified against `scripts/tackle-tasks/shared/preparedTask.ts:27,71-74,102` (line numbers are exact; the `Array.isArray((task as any).x)` shape is the one line 74 uses; `root` at line 68 is the trailing-slash-stripped worktree, so the expected absolute paths in the first test match). The thrown message shape matches the second test's regex.
- Step 3 — verified against `package.json` (`test:baseline` script) and `scripts/tackle-tasks/shared/promptSections.test.ts:24`, `scripts/tackle-tasks/shared/dumpPromptShapes.ts:27`, `scripts/tackle-tasks/shared/CodexReviewBodyEmitter.ts:790` (all build a hand-written `PreparedTask` with a fixed `readFilePaths` and no `handoffFilePaths`, so `loadPreparedTask` never runs there).
- Report shape — nothing to verify.
