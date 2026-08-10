# Task 86 implementation audit

Audit baseline: `945eb22650d593bdcab2584460c58ef4bad04a3c`

Audited branch/worktree: `task-86-chain`

Audited against:

- `plans/task-86-spec.md`
- the task 131-153 and closing-task plans/records (referred to as task 157 in the request and plan filename)
- the implementation and tests added after the baseline above

The `new-usage-graph` worktree was not inspected.

## Verdict

**Do not merge yet.** The implementation has three blockers that prevent the intended workflow from operating in production, plus queue, failure-reporting, concurrency, and cleanup defects. Several tests pass only because their harness supplies conditions that the generated production workflow never supplies; one required test hangs indefinitely.

Finding IDs below are intentionally stable so a later audit can restrict itself to verifying these exact items.

## Findings

### C86-01 — BLOCKER — Prepared per-task worktrees are never selected by the generated workflows

`prepareTasks` returns a `groups[].worktree` for every task (`scripts/prepareTasks.ts:156-182`), but the generated launch instructions discard it:

- Initial plan/implement launch arguments contain only `{ task, typecheckCommand }` and explicitly say to pass nothing else (`scripts/tackleTasksBrief.ts:65-87`).
- Tail-stage launches contain only `{ task, stage, repositoryManifest }` (`scripts/tackleTasksBrief.ts:143-146`).
- `task.workflow.js` derives the repository root from `process.cwd()` in its plan/implement, rebase-test, and merge paths (`skills/tackle-tasks/task.workflow.js:330-347`, `:552-557`, and `:670-682`). Nothing in the production instructions changes cwd to `groups[n].worktree`.

Consequently, the six background workflows would all plan, edit, commit, rebase, and clean up in the source/orchestrator checkout. The prepared `task-N` worktrees are unused, so the primary isolation requirement is not implemented.

The VM tests mask this defect. `tests/taskWorkflowMergeStage.test.ts:23-39` and `tests/runMergePhase.test.ts:189-203` explicitly change cwd to a fixture worktree and compile the workflow as though its filename were at that worktree root. Production does neither. The artificial filename also makes relative imports such as `./scripts/taskFiles.ts` resolve, whereas the real workflow lives under `skills/tackle-tasks/`, where that relative path does not exist. The repository's sandbox test also documents that module imports are forbidden (`tests/tackleTasksRetry.test.ts:65-68`), but the new workflow dynamically imports project modules throughout.

Required fix/test: give every workflow an explicit prepared-worktree identity and make all filesystem/git operations execute there using a mechanism supported by the actual workflow runtime. Add a production-shaped prepare -> launch -> workflow test that does not call `process.chdir` or relocate the compiled filename in its harness.

### C86-02 — BLOCKER — The repository manifest names branches that `prepareTasks` never creates

The prepared root and submodule worktrees use branch `task-N` (`scripts/prepareTasks.ts:133-152`). However, `prepareTasks` rewrites the repository manifest with `buildOperationPushOccurrences` (`scripts/prepareTasks.ts:219-228`), whose `operationBranch` values are `operations/<runId>/...` (`scripts/operationBranches.ts:89-101`). Those operation branches are names only; this path does not create them from the `task-N` worktrees.

The tail workflow passes that manifest unchanged (`skills/tackle-tasks/task.workflow.js:552-557` and `:677-682`). `mergeTaskDeepestFirst` then uses `occurrence.operationBranch` for `rev-list`, fetch, and merge operations (`scripts/mergeTaskWorktrees.ts:527-535` and `:598-600`). A production-shaped run therefore asks Git for an `operations/...` ref even though the task's commits are on `task-N`.

The tests hide the mismatch by hand-building manifests where `operationBranch` is `task-N` (`tests/taskWorkflowMergeStage.test.ts:52-86` and `tests/runMergePhase.test.ts:208-249`).

Required fix/test: use one consistent branch identity end to end, including submodules, and exercise the actual manifest returned by `prepareTasks` in an integration test.

### C86-03 — BLOCKER — The required parent gitlink-conflict rebase path hangs indefinitely

When a parent rebase has only permitted gitlink conflicts, `rebaseParentOntoSourceAndTest` stages them and invokes `git rebase --continue` (`scripts/mergeTaskWorktrees.ts:195-206`). That command is run without disabling Git's editor. In a noninteractive test/workflow, Git waits forever for an editor.

The isolated required test, `test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested` (`tests/mergeTaskWorktrees.test.ts:1071`), completed fixture setup and then remained pending until interrupted. The larger focused test run was likewise stuck for more than six minutes. The workflow's separate continuation helper correctly sets `GIT_EDITOR: 'true'` (`skills/tackle-tasks/task.workflow.js:487-496`), confirming the safeguard is missing from this path.

Required fix/test: make this continuation unconditionally noninteractive and require the isolated test to terminate normally.

### C86-04 — HIGH — The merge queue cannot finish after its final successful merge

`shouldEndQueue` returns true only for a zero-merge lap (`scripts/runMergePhase.ts:86-97`). After the final successful task, the normal state is `pending=[]`, `carryover=[]`, `mergedThisLap=1`, and no outstanding workflow, so it returns false. The generated driver then says that false plus empty carryover means to wait for another enqueue/notification (`scripts/tackleTasksBrief.ts:143-147`). No workflow remains to send one.

The tests enshrine the defect: `tests/runMergePhase.test.ts:113-121` and the purported end-to-end case at `:277-281` explicitly expect false after the final successful merge.

Required fix/test: represent and test the all-work-complete terminal state independently from the zero-merge failure ceiling.

### C86-05 — HIGH — The outstanding-workflow exception immediately retries against an unchanged tip

After task A fails a zero-merge lap while task B is still planning, `shouldEndQueue(queue, true)` correctly does not terminate. The next generated instruction is wrong: whenever carryover exists, it immediately calls `beginNextLap` (`scripts/tackleTasksBrief.ts:143-147`). Task A therefore consumes lap 2 against the same source tip, potentially reaching the retry ceiling before B can be approved and merged.

This defeats task 148's purpose for the outstanding-workflow exception: wait for another approval that may advance the source tip. `tests/runMergePhase.test.ts:104-111` checks only that `shouldEndQueue` returns false and never executes or models the erroneous next action.

Required fix/test: distinguish “wait for an outstanding workflow” from “start another lap,” and test the complete transition sequence.

### C86-06 — HIGH — The generated driver reads the wrong workflow result envelope

`task.workflow.js` returns `{ task, stage, results: [...] }` (`skills/tackle-tasks/task.workflow.js:712-727`). The generated tail says to inspect the workflow result's `status` and `lastFailure` directly (`scripts/tackleTasksBrief.ts:143-146`) instead of reading the relevant member of `results`. The approval gate instructions likewise do not map the plan/implement results array to the verifier result and fence violations.

A literal executor therefore observes undefined status/failure fields and records the wrong queue outcome. The tests know the true shape and manually use `workflowResult.results[0]` (`tests/runMergePhase.test.ts:266-275`), masking the instruction/API mismatch.

Required fix/test: define one documented result type for each stage and drive the generated orchestration against the actual returned envelope.

### C86-07 — HIGH — Real cleanup, merge, and close failures do not satisfy the queue's failure contract

The spec requires a concrete `lastFailure` for every unmerged result and a terminal reason in the final report. The implemented stage paths do not provide it:

- Plan/brief cleanup can throw out of the workflow entirely (`skills/tackle-tasks/task.workflow.js:656-681`), producing no queue outcome.
- A failed `mergeTaskDeepestFirst` report is forwarded with `failureReason`, but no `lastFailure` (`:687-690`).
- A skipped/failed close returns `merged-but-not-closed` without the `closeError` or `lastFailure` that the generated driver expects (`:697-701`).
- The driver unconditionally reads `lastFailure`/`closeError` (`scripts/tackleTasksBrief.ts:143-146`); `recordStageOutcome` then stores the undefined value and `buildMergeReport` can omit the reason from JSON (`scripts/runMergePhase.ts:100-114` and `:136-147`).

The queue tests inject synthetic, compliant reasons directly into `recordStageOutcome`; they do not pass real workflow results through the driver. The cleanup test (`tests/taskWorkflowMergeStage.test.ts:304-330`) treats a rejected workflow promise as sufficient coverage, even though that rejection cannot be queued, retried, or reported.

Required fix/test: return a discrete, typed failure result for cleanup, merge, and close failures, then feed each real result through the queue and final-report path. Preserve the intended warning-only behavior for failure of the final worktree removal.

### C86-08 — HIGH — `addTaskFiles` is unsafe under the newly introduced planning concurrency

Up to six workflows may widen task ownership concurrently, but `addTaskFiles` performs unlocked whole-file read/modify/write operations on both `tasks.json` and `run-arguments.json` (`scripts/addTaskFiles.ts:41-51` and `:64-76`). Two planners can read the same bytes and have the last writer erase the first planner's additions.

There is also a close/widen race: a planner can read `[A, B]`, task A can close atomically to `[B]`, and the planner can then write its stale `[A, B]` snapshot, resurrecting an already completed task. The guarded writer in `closeTasks` cannot protect against this unguarded writer.

Fixing C86-01 by merely running inside the private worktree would introduce another failure: the private checkout has its own `tasks.json`, while the authoritative source snapshot and source-created `run-arguments.json` would not receive the widening.

Required fix/test: identify a single authoritative coordination location, make every writer participate in the same lock/CAS protocol, and add adversarial concurrent widen/widen and widen/close tests.

### C86-09 — HIGH — `closeTasks` can archive a stale version of the task it closes

`closeTasks` reads `tasks.json` and freezes the closing task record early (`scripts/closeTasks.ts:85` and `:103-113`). It writes `completedTasks.json` from that snapshot (`:115-129`). Only afterward does the guarded removal reread current `tasks.json` bytes (`:132-136`), where it simply filters the task out.

If another writer changes the same task record between the initial read and guarded removal, the new record is removed from active tasks but the old record is archived. This violates task 152's requirement that retry reapply the archive operation to the other writer's bytes without losing either change.

The tests cover the hash-guard helper and preservation of unrelated bytes, not a close race that mutates the closing record itself.

Required fix/test: construct the archived record from the same successfully guarded current snapshot used for removal, and add an injected-race test that changes the closing record.

### C86-10 — HIGH — Successful cleanup leaks every fetched task branch in source submodules

The merge path fetches each submodule's `task-N` branch into the canonical source submodule (`scripts/mergeTaskWorktrees.ts:419-428`). On success, the workflow calls `removeWorktreeAndBranch` once for the root (`skills/tackle-tasks/task.workflow.js:703-705`). That helper removes only the root worktree and root branch (`scripts/mergeTaskWorktrees.ts:439-442`); it does not delete the fetched `task-N` refs from the source submodules.

The required cleanup test is a false positive. `tests/mergeTaskWorktrees.test.ts:1508-1530` manually runs `git branch -D` inside the submodule near the end of the test, thereby supplying the production behavior it should have asserted.

Required fix/test: after successful close, delete the task branch at every repository layer as well as the root worktree/branch; make the test assert those refs are absent without manually deleting them.

### C86-11 — MEDIUM — Worktree recovery/discovery still recognizes only the retired naming convention

`listTaskWorktrees` filters worktree basenames with `/^group-\d+$/` (`scripts/mergeTaskWorktrees.ts:47-56`), while the new preparer creates `task-N`. The `--discover`/`findUnmergedTaskWorktrees` recovery path therefore cannot see worktrees created by this implementation.

The administrative worktree list currently contains multiple legacy `group-*` worktrees and `task-group-*` branches left by the previous tackle-tasks implementation. No automatic migration/cleanup path handles those leftovers. They were observed only; this audit did not delete them.

Required fix/test: update discovery for `task-N`, test recovery of a failed new-format task, and decide explicitly whether the migration should report or clean legacy `group-*` artifacts rather than leaving them indefinitely.

### C86-12 — MEDIUM — Re-preparing a failed task destroys the work that failure handling intentionally retained

If a `task-N` worktree already exists, `createWorktreeForGroup` runs `checkout --force -B task-N <source>` (`scripts/prepareTasks.ts:136-142`). That discards the task commits and files retained after a two-lap failure for inspection or recovery.

`tests/prepareTasks.test.ts:84-103` explicitly expects the prior commit/file to disappear, so the test validates the data loss rather than the failure-retention contract. The artifact survives only until the next tackle-tasks invocation.

Required fix/test: preserve/reuse failed work or require an explicit cleanup/reset decision; do not silently force-reset it during normal preparation.

### C86-13 — MEDIUM — Rebase-test does not rerun the claimed typecheck

The generated brief promises that every rebase-test runs “typecheck + each layer's complete test suite” (`scripts/tackleTasksBrief.ts:155`). The rebase functions run only `discoverTestPolicy().completeSuiteCommand` (`scripts/mergeTaskWorktrees.ts:295-304` and `:370-379`), which is `npm run test` in this repository. `package.json`'s test script does not include a typecheck. `TYPECHECK_COMMAND` is used only by the implementation worker (`skills/tackle-tasks/task.workflow.js:215-230`) and is omitted from tail launches.

Conflict resolution or rebase fixes can therefore introduce type errors after the implement-stage check and still be merged.

Required fix/test: run the configured typecheck after every rebase/fix at the layer required by the contract, and prove a rebase-introduced type error blocks merge.

### C86-14 — MEDIUM — A merged-but-not-closed retry can archive the wrong commit hash

When an operation branch is already merged, `mergeTaskDeepestFirst` reports a no-op using the current source tip (`scripts/mergeTaskWorktrees.ts:527-549`). The workflow records that root-layer oid as the task's `mergedCommitHash` (`skills/tackle-tasks/task.workflow.js:691-696`).

If task A merged but close failed, task B then advanced the source, and A was retried, A would be archived with B's later source tip rather than the commit that merged A. Existing retry coverage retries before any intervening source advance (`tests/taskWorkflowMergeStage.test.ts:174-179`).

Required fix/test: retain/recover the actual merge commit for the task and test retry after another task advances the source.

### C86-15 — MEDIUM — The closing task's required end-to-end test matrix is incomplete

The closing plan requires end-to-end orchestration coverage for root-only success, submodule success, and a conflicted submodule. `tests/runMergePhase.test.ts` contains only the root-success orchestration case, and that case uses the artificial cwd and `operationBranch=task-N` setup described in C86-01 and C86-02. Other lower-level submodule tests do not exercise prepare -> notification -> gate -> queue -> close -> cleanup.

Required fix/test: add the missing production-shaped submodule-success and submodule-conflict scenarios, plus repair the root scenario so it uses real prepared outputs.

### C86-16 — LOW — Required retired instruction text was deleted instead of retained as comments

The closing plan's Edit 1.3 requires the two superseded instruction paragraphs to remain verbatim as `//`-prefixed text beneath a `RETIRED` marker. `scripts/tackleTasksBrief.ts:164` contains only a one-line tombstone directing readers to Git history. This does not meet the task-86 spec's transitional rule that retired code remain commented out, with only wholly superseded files removed.

Required fix/test: restore the specified commented text or amend the governing plan/spec explicitly; add an assertion for the required retirement marker/body if the transitional constraint still applies.

### C86-17 — LOW — Closing-task numbering is internally inconsistent

The request and plan filename identify the closing task as 157, while the current spec and completed task data identify the closing work as task 163. There is no task 157 record corresponding cleanly to the plan. This makes task-to-commit and follow-up-audit traceability ambiguous.

Required fix: normalize the task number in the plan/spec/task records or document the renumbering explicitly.

## Worktree-cleanup answer

The new implementation does **not** clean up task worktrees/branches completely:

- The intended success path removes the root `task-N` worktree and root branch last, but C86-01 prevents the production driver from reliably operating on that prepared worktree.
- Source submodules retain their fetched `task-N` branches after success (C86-10).
- Failed worktrees are invisible to the existing discovery path (C86-11).
- A later preparation force-resets an existing failed worktree, destroying its retained work rather than recovering or explicitly cleaning it (C86-12).
- Legacy `group-*` worktrees from the previous implementation are still present and have no migration/cleanup handling in this change.

No worktrees or branches were removed during this audit.

## Verification performed

- `npx tsc --noEmit` passed.
- Targeted queue, workflow-stage, close-task, prepare-task, and merge tests were run.
- 80 focused assertions completed successfully before the required gitlink-conflict test left the merge test file pending; the run was interrupted after more than six minutes.
- The isolated gitlink-conflict test reproduced the same indefinite wait.
- A separate `mergeTaskDeepestFirst`-focused run completed seven tests successfully.

The passing tests do not change the merge verdict because the production-shape gaps and false-positive harness conditions above bypass the broken integrations.
