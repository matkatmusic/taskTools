# Amendment: Plan: task 61 — move the owned-file existence check after submodule init

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/plan-task-61.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/61.json
Sections: 9 | Fixes: 0
Efficacy: 100%
Ruling: plans/plan-task-61.md can be used as is.

## Issues

None found.

## Sections that hold up

- Behavior in plain English — verified against `scripts/tackle-tasks/preambleStatusCheck/PREFLIGHT_OK_Q.ts:110-128` (the parent-repo `git cat-file` check) and `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd:42-54` (INIT_SUBMODULES_RECURSIVELY sits on every path after the worktree exists; FAILURES_EXIT is the post-worktree exit at lines 48 and 52).
- Files this plan touches — verified against `scripts/tackle-tasks/generateSteps.ts:178,352,358,374` (the generator writes only diagram-steps.json for an existing box with an existing template) and `scripts/tackle-tasks/generateWorkflow.ts:139-140` (its CLI is retired, so `npm run steps` writes no workflow file).
- Step 1 — verified against `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd:54`, `scripts/tackle-tasks/generateSteps.ts:61-106,254-258` (cross-diagram targets become `pipeline-failuresExit.mmd::FAILURES_EXIT`, edges keep file order), and the current entry `{"box":"INIT_SUBMODULES_RECURSIVELY","mutating":true,"next":["DOCUMENT_GENERATION"]}` from `jq` on `scripts/tackle-tasks/diagram-steps.json`. The hand-written `mutating` flag survives regeneration per `scripts/tackle-tasks/generateSteps.ts:188-189`.
- Step 2 — verified against `scripts/tackle-tasks/preambleStatusCheck/INIT_SUBMODULES_RECURSIVELY.test.ts:4,10-12,19,37` (fixture key is `files: []`, `seedTasksFile` writes at the fixture root), `scripts/shared/prepareTasks.ts:115-122` (`modifiableFiles` throws on `files`), `scripts/shared/taskFiles.ts:37-45` (`resolveTaskFiles` finds a root-level tasks.json), and `scripts/tackle-tasks/preambleStatusCheck/INIT_SUBMODULES_RECURSIVELY.ts:8-15` (today's `main` returns no `next`, so both new tests fail RED).
- Step 3 — verified against `scripts/hooks/runStepHook.ts:468-475` (a box with two successors must name one in `next`, and it must be a declared edge), `tests/stepTemplates.test.ts:75-78,133-151` (mutating blocks skip the contract test; every `next:` literal must be a declared edge, which the new edge supplies), `tests/stepTemplates.test.ts:98-115` with `scripts/shared/templateShape.ts:18-36` and `scripts/tackle-tasks/failuresExit/FAILURES_EXIT.template.json` (the new edge test passes: FAILURES_EXIT's input keys are all in the existing INIT_SUBMODULES_RECURSIVELY template output; `next` is stripped by `withoutNext`), and `scripts/tackle-tasks/shared/preparedTask.ts:74-77` (the same `createsFiles`-aware `existsSync` check runs later in `loadPreparedTask`).
- Step 4 — verified against `scripts/tackle-tasks/preambleStatusCheck/PREFLIGHT_OK_Q.ts:7-9,110-128` (line range is exact; `spawnSync`, `modifiableFiles`, `readStagingTip`, `readTaskFile`, `resolveTaskFiles` have no other use in the file).
- Step 5 — verified against `scripts/tackle-tasks/preambleStatusCheck/PREFLIGHT_OK_Q.test.ts:92-142` (the two named tests exist; the everything-passes test still expects `next: "MARK_TASK_ACTIVE"`, which `PREFLIGHT_OK_Q.ts:129` returns once the tree check is gone). `tests/hookDuplicateRegistration.test.ts:8` imports only `checkDuplicateHookRegistration`, which the plan leaves alone.
- Step 6 — verified against `package.json` (`test:baseline` is `node --no-inspect scripts/shared/checkTestBaseline.ts`); no test under `tests/` pins the removed PREFLIGHT_OK_Q tree check (`rg "not in the tree the worktree is cut from"` hits only the block and its own test file).
- Report shape — nothing to verify.
