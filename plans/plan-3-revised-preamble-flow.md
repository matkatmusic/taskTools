# PLAN 3 — the revised preamble flow

Needs: Plan 1 (plans/plan-1-generator-new-diagram-style.md) and Plan 2 (plans/plan-2-awaitingTesting-folder.md). Order of work: Plan 2, then Plan 1, then Plan 3.

## Rules for every plan
- Test first: write the failing test, run ONLY that test file with `node --test <file>` to see it fail for the stated reason, then write the code.
- The FULL suite runs only through `npm run test:baseline`. Edit agents never run the full suite. One later agent owns that run.
- Never commit. Never delete retired code; comment it out.
- No helper extraction, no refactor. Two near-identical blocks of code stay two blocks.
- One condition for each `if`; nest, do not chain with `&&`.
- A comment is one line, under 20 words. Never two stacked `//` lines.

## Context

Needs Plan 1 (new diagram style, 16 blocks renamed) and Plan 2 (`awaitingTesting` folder). The drawn flow is `plans/preamble-revised.mmd`, with the corrections named below.

User goal: the preamble exists to reach the planning stage. Only five things may stop a launch, all before `B_MARK_TASK_ACTIVE`, all to `REPORT_ONLY_EXIT`: number not valid, task blocked, task already active, preflight failed, the lock wait deadline passed. After `B_MARK_TASK_ACTIVE` no arrow leads to `FAILURES_EXIT`. Conflict-fix loops have no try limit. `staging` catches up with the current branch BEFORE a `task-N` branch is made; the merge direction is current branch INTO `staging` only; the user's checkout is never touched.

Revised order:

```
Q_PREFLIGHT_OK_Q (YES) -> B_LOCK_STAGING_FOR_CATCH_UP -> Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q
    YES: -> Q_CATCH_UP_STAGING
    NO: -> Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q
        NO: -> B_WAIT_FOR_CATCH_UP_LOCK -> B_LOCK_STAGING_FOR_CATCH_UP   (try again)
        YES: -> REPORT_ONLY_EXIT                                        (the lock wait deadline passed)
Q_CATCH_UP_STAGING
    YES (no conflict in any repository): release the lock -> B_MARK_TASK_ACTIVE -> ... as today
    NO: keep the lock -> B_FIX_CATCH_UP_CONFLICTS -> Q_COMMIT_CATCH_UP_MERGE
        YES: commit, move staging, remove the folder -> Q_CATCH_UP_STAGING   (next repository)
        NO:  -> B_FIX_CATCH_UP_CONFLICTS                                     (a new agent)
Q_IS_PREVIOUS_RUN_RESUMABLE_Q (YES and NO) -> Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING
    NO (conflicts) -> B_FIX_RESUMED_REBASE_CONFLICTS -> Q_CONTINUE_RESUMED_REBASE
        YES: release the source lock -> Q_DOES_FENCE_COVER_WORKTREE_Q
        NO:  -> B_FIX_RESUMED_REBASE_CONFLICTS
Q_DOES_FENCE_COVER_WORKTREE_Q (NO) -> B_AMEND_TASK_FILE_LIST -> Q_INIT_SUBMODULES_RECURSIVELY
Q_INIT_SUBMODULES_RECURSIVELY (NO) -> B_ADD_MISSING_FILES_TO_CREATES_FILES -> B_DOCUMENT_GENERATION
```

Facts from the code that shape the work:
1. `runId` is `""` before `B_MARK_TASK_ACTIVE` (`PREAMBLE_STATUS_CHECK.ts:22`; `MARK_TASK_ACTIVE.ts:11` makes the real one). So the lock owner of the catch-up blocks is `buildLockOwner("", N)` = `":N"`. The lock is released before `B_MARK_TASK_ACTIVE`. A launch of the same task again gets `already-held-by-me`. Tests pass `runId: ""`.
2. `hooks/hooks.json:17` gives the run-step hook `timeout: 1200`. User decision: copy the existing `lockSourceRepo` wait-and-deadline loop (Wave B, section B1). The loop ends at its own deadline, 5 minutes, inside ONE hook call; the hook's 1200-second (20-minute) limit is never approached.
3. The fix prompt forbids the agent to stage or commit (`FixConflictsBodyEmitter.ts`, FORBIDDEN ACTIONS). So git still lists unmerged files when the commit block starts. "Fixed" means: no unmerged file has a marker line (`/^(<{7}|={7}|>{7})/m`, as `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts:16`). The commit block runs `git add` itself. It never reads the agent's `resolved` flag.
4. `FIX_CONFLICTS.ts:26` passes `worktree` to `fixConflictsPrompt`, which throws at `FixConflictsBodyEmitter.ts:227` when that checkout has no unmerged path; a stop inside a submodule hits it. The new resumed-rebase prompt block passes `packet.stoppedCheckoutPath`. `FIX_CONFLICTS.ts` is not touched.
5. A fence violation inside a submodule arrives tagged, `child::src/a.ts` (`occurrences.ts:71,129`). `addTaskFiles` does not refuse that text and would write a path that never matches. `B_AMEND_TASK_FILE_LIST` converts it with `parseOccurrencePath` to `child/src/a.ts`.
6. `tests/stepTemplates.test.ts:76` RUNS each block that is not `mutating` against its template. All eleven new blocks get `"mutating": true` (the two prompt blocks write a prompt file and refresh the lock; the lock-loop blocks mutate the source repo lock). The generator copies the flag from the old config (`getMutatingFromPreviousConfig`, `generateSteps.ts:204-218`), and Plan 1 moves that function's line numbers, so: generate, hand-add the flag to the eleven new entries, generate again.
7. `tests/stepTemplates.test.ts:133`: a block's `template.input` keys must be a subset of each predecessor's `template.output` keys (`:106` is a different, stricter test that runs the real script). So `violations`, `missingFiles`, and the catch-up fields are ALWAYS in the producer's output (`[]` or `""` when not used).
8. The shared merge-time chain (`pipeline-rebase`, `fixConflicts`, `commitMergeConflictFixIfNeeded` diagrams and scripts) is NOT changed. Its arrow `IS_REBASE_FINISHED_Q --> Q_DOES_FENCE_COVER_WORKTREE_Q` still has a live target, and no script is removed, so neither generator guard fires. Only the producer retires `returnTo`: it is commented out in `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts`, and the key leaves that block's template.
9. `createsFiles` is a marker list; a created file stays in `modifiableFiles` too (`INIT_SUBMODULES_RECURSIVELY.ts:20-21`; the fence `shared/writableFiles.ts:27-30` reads only `modifiableFiles`; tasks 196, 190, 210). No code adds to `createsFiles` of a task that exists (`scripts/shared/appendTask.ts:61-62` writes it only when a task is made).

New files drop the `B_`/`Q_` prefix in their file name, as the 16 old files do: `preambleStatusCheck/LOCK_STAGING_FOR_CATCH_UP.ts`. Each new block: `box:` literal is the full id; `next` literals are full ids of the REAL target (choice boxes are folded); incoming `next` is dropped with `const { next: _next, ...packet } = JSON.parse(input)`; the file ends with the `realpathSync` self-exec lines; 4-space indent; one condition for each `if`; `const rootSourceBranch = "staging";` with the `rev-parse` line commented out above it, as `FIX_CONFLICTS.ts:22-23`.

## Wave A — shared code (four parallel owners)

### A1. `scripts/shared/prepareTasks.ts` + new `tests/catchUpStaging.test.ts`

Three new exported functions go directly below `resolveOrCreateStagingTipEverywhere` (`:303`). They are in the same file, so they call the private `moveStagingBranchTo` (`:217`) with no `export` added and no code moved. `resolveOrCreateStagingTip` and `resolveOrCreateStagingTipEverywhere` stay byte-identical; `CREATE_WORKTREE`, `RESET_WORKTREE`, and `ensureStagingWorktree` keep calling them, and each call finds nothing to do UNLESS the user's branch moved after the lock was released; then `resolveOrCreateStagingTip` still throws on that conflict, the same as today. The comment above it ("RETIRED (task 8, reversed 2026-09-08)") is stale; the function it sits above is live and stays called.

```ts
export type StagingCatchUpConflict = { repositoryPath: string; mergeFolder: string; conflictedFilePaths: string[] };
export function catchUpStagingInRepository(repoRoot: string, mergeFolder: string): StagingCatchUpConflict | null
export function catchUpStagingEverywhere(projectRoot: string, taskNumber: number): StagingCatchUpConflict | null
export function commitCatchUpMergeAndMoveStaging(repositoryPath: string, mergeFolder: string, fixedFilePaths: string[]): void
```

`catchUpStagingInRepository` = a copy of `:229-281` that returns `null` when it ends clean, with three differences:
1. The `mkdtempSync` + `worktree add` lines become: `git -C <repoRoot> worktree prune`; `mkdirSync(dirname(mergeFolder), { recursive: true })`; `git -C <repoRoot> worktree add --detach <mergeFolder> refs/heads/staging`.
2. The `throw` at `:271-274` stays above as a comment. After the gitlink loop run `git -C <mergeFolder> diff --name-only --diff-filter=U -z`. A list that is not empty returns `{ repositoryPath: repoRoot, mergeFolder, conflictedFilePaths }`; the folder stays; `staging` does not move.
3. Each early return returns `null`.
All other git commands are the same as today: `rev-parse --verify --quiet refs/heads/staging^{commit}`; `branch staging`; `rev-parse HEAD`; `merge-base --is-ancestor` in the two directions; `git -C <mergeFolder> merge --no-edit <headTip>`; `ls-files -u -z` + `update-index --cacheinfo 160000,<subTip>,<path>`; `git -C <mergeFolder> commit --no-edit`; `rev-parse HEAD`; `git -C <repoRoot> worktree remove --force <mergeFolder>`; `moveStagingBranchTo(repoRoot, mergedTip)`.

`catchUpStagingEverywhere`:
- `mergeFolder = join(resolveTaskWorktreeConventionDirectory(projectRoot), \`task-${taskNumber}-catchUpMerge\`)`.
- Walk list = a copy of `:289-296` (`git submodule foreach --recursive --quiet 'echo "$displaypath"'`, deepest first), then the main repository last. Return the first result that is not `null`; return `null` after the main repository.
- CLEANUP, before the walk. A leftover `mergeFolder` is derived again, never trusted:
  - Find its owner: for each repository path, compare `git -C <mergeFolder> rev-parse --path-format=absolute --git-common-dir` (with `spawnSync`; a non-zero status means no owner) with the same command in the repository.
  - Owner found: run `git -C <mergeFolder> rev-parse --verify --quiet MERGE_HEAD`. Status 0: run `diff --name-only --diff-filter=U -z`; a list that is not empty returns the conflict for that owner and folder (the flow goes to the fix agent with the SAME folder). In each other case: `git -C <owner> worktree remove --force <mergeFolder>`.
  - In each case that does not return a conflict, end with `rmSync(mergeFolder, { recursive: true, force: true })`.

`commitCatchUpMergeAndMoveStaging`, in order: if `fixedFilePaths.length > 0`, `git -C <mergeFolder> add -- <paths>`; `git -C <mergeFolder> commit --no-edit`; `git -C <mergeFolder> rev-parse HEAD`; `git -C <repositoryPath> worktree remove --force <mergeFolder>`; `moveStagingBranchTo(repositoryPath, mergedTip)`.

RED tests (real repositories; `process.env.GIT_ALLOW_PROTOCOL = "file"`; `makeCommittedRepo` and `makeLayeredSubmoduleFixture` from `tests/support/gitFixtures.ts`; each starts as step comments + `assert.fail()`):
- `test_catchUpStagingInRepository_createsStagingAtHeadWhenStagingIsAbsent`
- `test_catchUpStagingInRepository_movesStagingForwardWhenStagingIsBehindHead`
- `test_catchUpStagingInRepository_leavesStagingAloneWhenStagingIsAheadOfHead`
- `test_catchUpStagingInRepository_mergesHeadIntoStagingWhenTheyHaveSplitApart` — the `staging` tip has 2 parents and the two files.
- `test_catchUpStagingInRepository_neverMovesTheUsersCheckout` — main checkout `HEAD`, branch, and `status --porcelain` do not change.
- `test_catchUpStagingInRepository_returnsTheConflictedFilesAndKeepsTheMergeFolderOnABothSidesEdit` — `shared.txt` committed with different text on `staging` and on `main`; result `["shared.txt"]`; folder exists; `MERGE_HEAD` exists; `staging` tip did not change.
- `test_catchUpStagingInRepository_removesTheMergeFolderAfterACleanMerge`
- `test_catchUpStagingInRepository_prunesAMissingButRegisteredMergeFolderBeforeAddingIt` — `worktree add` the folder, `rmSync` it, run on a split repository: no throw.
- `test_catchUpStagingEverywhere_catchesUpTheDeepestSubmoduleBeforeTheRoot`
- `test_catchUpStagingEverywhere_resolvesAGitlinkConflictToTheSubmodulesStagingTip`
- `test_catchUpStagingEverywhere_returnsTheSubmodulePathWhenTheConflictIsInsideASubmodule`
- `test_catchUpStagingEverywhere_resumesALeftoverMergeFolderThatStillHasUnmergedFiles` — the same folder comes back; the `MERGE_HEAD` hash did not change.
- `test_catchUpStagingEverywhere_removesALeftoverMergeFolderThatHasNoMergeInProgress`
- `test_catchUpStagingEverywhere_removesALeftoverMergeFolderWhoseMergeHasNoUnmergedFiles`
- `test_catchUpStagingEverywhere_removesALeftoverFolderThatIsNotAWorktree`
- `test_commitCatchUpMergeAndMoveStaging_commitsTheMergeAndMovesStagingToIt`
- `test_commitCatchUpMergeAndMoveStaging_removesTheMergeFolder`
- `test_commitCatchUpMergeAndMoveStaging_fastForwardsTheAwaitingTestingCheckoutWhenItHoldsStaging`

### A2. new `scripts/shared/addTaskCreatesFiles.ts` + `tests/addTaskCreatesFiles.test.ts`
A near-identical copy of `scripts/shared/addTaskFiles.ts`: the same private `rejectionReason` and `firstRejectedPath`; `appendFiles` writes `task.createsFiles`; no run-arguments snapshot code (the snapshot holds `files` only); same pattern `resolveTaskFiles` -> `withTaskStateLock` -> read, change, `writeJsonAtomically`. Signature: `addTaskCreatesFiles(taskNumbers: number[], paths: string[], sourceRoot: string): TaskRecord[]`.
RED: `test_addTaskCreatesFiles_appendsThePathsToCreatesFiles`, `..._createsTheCreatesFilesArrayWhenTheTaskHasNone`, `..._doesNotAddAPathTwice`, `..._leavesModifiableFilesUnchanged`, `..._rejectsAnAbsolutePath`, `..._rejectsAPathOutsideTheRepo`, `..._throwsWhenTheTaskNumberIsNotInTasksJson`.

### A3. new `scripts/tackle-tasks/shared/FixCatchUpConflictsBodyEmitter.ts` + test; `shared/greenBoxPolicy.ts`
`fixCatchUpConflictsPrompt(mergeFolder: string): string`. One template literal. Its own private `conflictedPaths` copy. Throws `fix-catch-up-conflicts: no unmerged paths in <folder>` when the list is empty.
- Import and call `absolutePathsSection` and `whatToReturnSection` (both exported); copy only the text that changes. WHAT TO READ, HOW TO RESOLVE, and the three "Returning `resolved: false`" lines come from `FIX_CONFLICTS_SECTIONS` word for word.
- Different text: YOUR JOB says "A merge of the user's current branch into `staging` inside `<root>` is stopped on live conflict markers ... so a later box can commit the merge." WHAT YOU MAY EDIT: only the list, plus "Never search the repository for more conflicted files." No submodule paragraph. DO NOT DRIVE THE MERGE: "Never run `git merge --continue`, `git merge --abort` or `git commit`." FORBIDDEN: the rebase line becomes the merge-and-commit line.
- Add `"FixCatchUpConflictsBodyEmitter"` to `NON_DISPATCHED_SCRIPTS` in `greenBoxPolicy.ts`.
RED: `test_fixCatchUpConflictsPrompt_listsEveryUnmergedFileByAbsolutePath`, `..._saysAMergeIsStoppedAndNeverSaysRebase`, `..._forbidsMergeContinueAbortAndCommit`, `..._throwsWhenTheFolderHasNoUnmergedFiles`.

### B0. `preambleStatusCheck/_packet.ts` gets one type
```ts
export type CatchUpPacket = EntryPacket & { catchUpRepositoryPath: string; catchUpMergeFolder: string; conflictedFilePaths: string[] };
```

### B0b. edit `PREFLIGHT_OK_Q.ts` + its test + its template; edit `MARK_TASK_ACTIVE.template.json`
`PREFLIGHT_OK_Q.ts:130` returns `next: "MARK_TASK_ACTIVE"` on its YES path. Change that literal to `next: "B_LOCK_STAGING_FOR_CATCH_UP"`.
`PREFLIGHT_OK_Q.template.json` output `next` changes from `"MARK_TASK_ACTIVE"` to `"B_LOCK_STAGING_FOR_CATCH_UP"`.
`PREFLIGHT_OK_Q.test.ts`: change the test that asserts the YES-path `next` (its name states what it checks; rename it to say it chooses `B_LOCK_STAGING_FOR_CATCH_UP`, not `MARK_TASK_ACTIVE`).
`MARK_TASK_ACTIVE.template.json` `input.box` is `"IS_TASK_ACTIVE_Q"` today; that is already wrong (the real predecessor is `PREFLIGHT_OK_Q`). After this plan the real predecessor is `Q_CATCH_UP_STAGING` (its YES exit; the only predecessor). Set `input.box` to `"Q_CATCH_UP_STAGING"`.

## Wave B — blocks (one owner for each triple `BLOCK.ts` + `BLOCK.test.ts` + `BLOCK.template.json`, in `scripts/tackle-tasks/preambleStatusCheck/`)

Template bases, keyed as `IS_PREVIOUS_RUN_RESUMABLE_Q.template.json:3-13`:
- PRE: `runId: ""`, `worktree: ""`, `projectRoot: "{{PROJECT_ROOT}}/scripts/tackle-tasks/preambleStatusCheck/fixtures/mutating-example"`, `branch: "task-1"`, each other text field `""`.
- POST: the same with `runId: "run-1"` and `worktree: "{{PROJECT_ROOT}}/.../mutating-example-worktree"`.
- CATCHUP: `"catchUpRepositoryPath": "", "catchUpMergeFolder": "", "conflictedFilePaths": [""]`.
- REBASE: `"rebased": false, "conflicted": false, "stoppedOccurrenceId": "", "stoppedCheckoutPath": "", "conflictedFilePaths": [""], "failureReason": ""`.

### B1. Four blocks copy the pipeline's own lock-wait loop (`diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd`, `scripts/tackle-tasks/lockSourceRepo/`)
The pipeline already solved "wait for the source repo lock, with a deadline" as four blocks: `LOCK_SOURCE_REPO --> WAS_LOCK_ACQUIRED_Q -- NO --> HAS_LOCK_WAIT_DEADLINE_PASSED_Q -- NO --> WAIT_FOR_LOCK --> LOCK_SOURCE_REPO`. No block names itself, so the hook walks the whole loop inside ONE hook call; no `runStepHook.ts` change is needed for this. The four preamble copies keep that shape and that many hook-call-internal turns, with three differences everywhere: they build their output with `{ ...packet }` (never field by field), because the preamble packet carries `docsMode` and `planFile`, which a field-by-field copy would drop; their `box` literal is the new id; and the deadline block's YES exit goes to `pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT` (a fifth stop reason), not `FAILURES_EXIT`, following the shape `PREFLIGHT_OK_Q.ts:100-107` already uses to reach that exit (`exitType`, `exitNote`, `next` all set together).

#### B1a. `B_LOCK_STAGING_FOR_CATCH_UP` (`LOCK_STAGING_FOR_CATCH_UP.*`)
Copies `LOCK_SOURCE_REPO.ts`. Differences: `{ ...packet }` in place of the field-by-field object (so `docsMode`, `planFile` survive); `box: "B_LOCK_STAGING_FOR_CATCH_UP"`; input type is `EntryPacket & { lockWaitStartedAt?: string }` (absent on the first entry, present on the loop-back from `B_WAIT_FOR_CATCH_UP_LOCK`); the preamble `EntryPacket` (`preambleStatusCheck/_packet.ts`) has no `lockWaitStartedAt` field, unlike `lockSourceRepo/_packet.ts`, so do not add it there; no `next` key (one successor, `Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q`).
```ts
export function main(input: string): EntryPacket & { acquired: boolean; heldByOwner: string } {
    const parsed = JSON.parse(input) as Input;
    const projectRoot = requireAbsolutePath("projectRoot", parsed.projectRoot);
    const lockWaitStartedAt = parsed.lockWaitStartedAt ?? new Date().toISOString();
    const owner = buildLockOwner(parsed.runId, parsed.taskNumber);
    const outcome = acquireSourceRepoLock(projectRoot, owner);
    const acquired = outcome.status === "acquired" || outcome.status === "already-held-by-me";
    return {
        ...parsed,
        box: "B_LOCK_STAGING_FOR_CATCH_UP",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        lockWaitStartedAt,
        acquired,
        heldByOwner: "owner" in outcome ? outcome.owner : "",
    };
}
```
Template: input = PRE with `box: "Q_PREFLIGHT_OK_Q"`, no `lockWaitStartedAt` key (absent on first entry); output = PRE with `box: "B_LOCK_STAGING_FOR_CATCH_UP"`, plus `lockWaitStartedAt`, `acquired: true`, `heldByOwner: ""`.
RED: `test_lockStagingForCatchUp_takesTheLockWhenNobodyHoldsIt` — `readSourceRepoLock(root).owner === ":1"`; `..._returnsAtOnceWhenAnotherRunHoldsTheLock`; `..._stampsTheWaitClockOnceOnFirstEntry`; `..._rejectsARelativeProjectRoot`; `test_LOCK_STAGING_FOR_CATCH_UP_runsTwiceWithTheSameInput`; `..._passesThroughDocsModeAndPlanFileUnchanged`.

#### B1b. `Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q` (`WAS_CATCH_UP_LOCK_ACQUIRED_Q.*`)
Copies `WAS_LOCK_ACQUIRED_Q.ts`. Differences: `{ ...packet }`; `box` literal; YES `next` is `"Q_CATCH_UP_STAGING"` (not the next-diagram rebase target); NO `next` is `"Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q"`.
Template: input = the B1a output shape with `box: "B_LOCK_STAGING_FOR_CATCH_UP"`; output = the same fields minus `acquired`/`heldByOwner`, plus `next: "Q_CATCH_UP_STAGING"`.
RED: `test_wasCatchUpLockAcquired_routesToCatchUpStagingWhenAcquired`; `..._routesToHasCatchUpLockWaitDeadlinePassedWhenNotAcquired`.

#### B1c. `Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q` (`HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q.*`)
Copies `HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts`. Differences: `{ ...packet }`; `box` literal; the YES return sets `exitType: "catch-up-lock-wait-deadline-passed"`, `exitNote: "the source repo lock did not come free within 5 minutes"`, `next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT"` (not `FAILURES_EXIT`); the NO return's `next` is `"B_WAIT_FOR_CATCH_UP_LOCK"`. Reuses `LOCK_WAIT_DEADLINE_MS` from `lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts` (import it; do not redefine it).
Template: input = the B1b output shape with `box: "Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q"`; output = the same fields with `box: "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q"`, `next: "B_WAIT_FOR_CATCH_UP_LOCK"`.
RED: `test_hasCatchUpLockWaitDeadlinePassed_waitsAgainBeforeTheCap`; `..._choosesReportOnlyExitAfterTheCap`; `..._setsExitTypeAndExitNoteAfterTheCap`.

#### B1d. `B_WAIT_FOR_CATCH_UP_LOCK` (`WAIT_FOR_CATCH_UP_LOCK.*`)
Copies `WAIT_FOR_LOCK.ts`. Differences: `{ ...packet }`; `box` literal; no `next` key (one successor, `B_LOCK_STAGING_FOR_CATCH_UP`). Reuses the same overridable `WAIT_FOR_LOCK_MS` environment variable name, so the acceptance test's existing pattern of shortening it still works.
Template: input = the B1c NO-path output shape with `box: "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q"`; output = the same fields with `box: "B_WAIT_FOR_CATCH_UP_LOCK"`.
RED: `test_waitForCatchUpLock_waitsThenLoopsBackToLockStagingForCatchUp` (the test file sets `process.env.WAIT_FOR_LOCK_MS = "20"`, then `await import`, as `WAIT_FOR_LOCK.test.ts:5-6`).

### B2. `Q_CATCH_UP_STAGING` (`CATCH_UP_STAGING.*`)
Input EntryPacket (from the lock block and from the commit block). Output CatchUpPacket + `next`.
1. `refreshOwnedSourceRepoLockOrThrow(projectRoot, owner)`.
2. `const conflict = catchUpStagingEverywhere(projectRoot, packet.taskNumber)`.
3. `conflict === null`: `releaseSourceRepoLock(projectRoot, owner)`; return CATCHUP empty (`""`, `""`, `[]`) and `next: "B_MARK_TASK_ACTIVE"`.
4. Else: return the three fields from `conflict` and `next: "B_FIX_CATCH_UP_CONFLICTS"`. The lock stays.
Template: input PRE (`box: "Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q"`); output PRE + CATCHUP.
RED (setup `acquireSourceRepoLock(root, ":N")`): `test_CATCH_UP_STAGING_releasesTheLockAndChoosesMarkTaskActiveWhenStagingCaughtUp`; `..._keepsTheLockAndPassesTheConflictedFilesOnABothSidesEdit` (folder basename is `task-N-catchUpMerge`); `..._passesTheSubmodulePathWhenTheConflictIsInASubmodule`; `..._goesStraightToTheAgentWhenALeftoverMergeFolderStillHasUnmergedFiles`; `..._throwsWhenThisTaskDoesNotHoldTheLock`; `..._outputMatchesItsTemplate`.

### B3. `B_FIX_CATCH_UP_CONFLICTS` (`FIX_CATCH_UP_CONFLICTS.*`, class `returns_a_prompt`)
1. `requireAbsolutePath` on `projectRoot` and `catchUpMergeFolder`. 2. Refresh the lock. 3. `const promptFile = \`${mergeFolder}.FIX_CATCH_UP_CONFLICTS.prompt.md\`` — BESIDE the folder, not in it: a file inside would be an untracked file in a merge, and `shared/rebaseIntent.ts:8` already puts a file beside a worktree. 4. `writeFileSync(promptFile, fixCatchUpConflictsPrompt(mergeFolder))`. 5. Return `{ box: "B_FIX_CATCH_UP_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: \`invoke '/read-file "${promptFile}"' and follow the instructions.\` }`.
Template: `input` = PRE + CATCHUP (`box: "Q_CATCH_UP_STAGING"`); `agentAnswer` = `{ "message": "", "additionalData": { "resolved": true, "unresolvedPaths": [] } }`; no `output` key.
RED: `..._writesThePromptFileBesideTheMergeFolder` (`git -C <folder> status --porcelain` shows no `??` line); `..._returnsAPromptThatNamesThePromptFile`; `..._refreshesTheLockHeartbeat`; `..._throwsWhenTheLockIsNotHeld`.

### B4. `Q_COMMIT_CATCH_UP_MERGE` (`COMMIT_CATCH_UP_MERGE.*`)
Input CatchUpPacket + `message` + `additionalData` (never read).
1. Refresh the lock. 2. `unmergedFilePaths` from `git -C <catchUpMergeFolder> diff --name-only --diff-filter=U -z`. 3. `stillMarked` = the unmerged paths whose file text matches `/^(<{7}|={7}|>{7})/m`.
4. `stillMarked.length > 0`: return `conflictedFilePaths: unmergedFilePaths`, `next: "B_FIX_CATCH_UP_CONFLICTS"`. The lock stays.
5. Else: `commitCatchUpMergeAndMoveStaging(packet.catchUpRepositoryPath, packet.catchUpMergeFolder, unmergedFilePaths)`; `rmSync(\`${folder}.FIX_CATCH_UP_CONFLICTS.prompt.md\`, { force: true })`; return CATCHUP empty and `next: "Q_CATCH_UP_STAGING"`. The lock stays; `Q_CATCH_UP_STAGING` releases it when each repository is done.
Template: input = PRE + CATCHUP + `"message": "", "additionalData": {}` (`box: "B_FIX_CATCH_UP_CONFLICTS"`); output = the same keys with its own `box`.
RED: `..._commitsTheMergeAndMovesStagingWhenNoMarkersRemain`; `..._removesTheMergeFolderAndThePromptFile`; `..._choosesCatchUpStagingAndKeepsTheLockAfterTheCommit`; `..._choosesTheAgentAgainWhenAFileStillHasAMarkerEvenIfTheAgentSaidResolved`; `..._commitsWhenTheAgentSaidUnresolvedButNoMarkerRemains`; `..._neverTouchesTheUsersCheckout`; `..._outputMatchesItsTemplate`.

### B5. edit `IS_PREVIOUS_RUN_RESUMABLE_Q.ts`
Comment out `:10-21`. New body: `const { implementationNotesFile, leaseEstablished } = isTaskRunResumable(...)` (it still adopts the lease first, `shared/isTaskRunResumable.ts:40-42`); first `if (!leaseEstablished) { throw new Error("IS_PREVIOUS_RUN_RESUMABLE_Q: the worktree lease could not be taken"); }` (`scripts/tackle-tasks/shared/isTaskRunResumable.ts:34-56` confirms the field name and that `NOT_RESUMABLE` carries `leaseEstablished: false`); then output gets `implementationNotesFile: implementationNotesFile ?? ""`; the two answers both return `next: "Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING"`. No arrow to `FAILURES_EXIT`. The line-1 comment takes the new question. Template output gets `"implementationNotesFile": ""`.
Tests: comment out `:40 ...choosesFailuresExit...`; add `..._continuesToTheRebaseWithNoNotesFileWhenNoEndedRunRecordedAStoppingPoint`, `..._passesTheNotesFileWhenTheEndedRunLeftOne`, `..._stillAdoptsTheLeaseWhenThereIsNoNotesFile`, `test_IS_PREVIOUS_RUN_RESUMABLE_Q_throwsWhenTheWorktreeLeaseCannotBeTaken` — setup: seed another run's live lease on the worktree the same way `tests/prepareTasks.test.ts` (`test_createWorktreeForGroupStillThrowsWhenTheLeaseOwnerProcessIsAlive`) does, with `writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "other-run", pid: process.pid, createdAt: Date.now() }))` (`taskWorktreeLeasePath` from `scripts/shared/prepareTasks.ts`).

### B6. edit `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts`
Comment out: `RETURN_TO` (`:13`), the `returnTo` type field, `returnTo: ""` in `notRebased`, the `returnTo:` line (`:75`) and the `next:` line (`:76`) of the conflict return. Add `next: "B_FIX_RESUMED_REBASE_CONFLICTS"` to the conflict return. Remove the `returnTo` key from the template (JSON has no comments).
Tests: comment out `:94` and `:150`; add `..._routesConflictsToFixResumedRebaseConflictsAndKeepsTheLock`, `..._leavesARetainedIntentInPlaceOnConflict`.

### B7. `B_FIX_RESUMED_REBASE_CONFLICTS` (`FIX_RESUMED_REBASE_CONFLICTS.*`, class `returns_a_prompt`)
A near-copy of `FIX_CONFLICTS.ts:17-51` (without its retired comment blocks). Differences: the `box` literal; the prompt file is `<worktree>/plans/FIX_RESUMED_REBASE_CONFLICTS.prompt.md`; the call is `fixConflictsPrompt(packet.stoppedCheckoutPath, ...)`.
Template: `input` = POST + REBASE (`box: "Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING"`); `agentAnswer` as B3.
RED: `..._writesThePromptFileInTheWorktreePlansFolder`; `..._listsTheSubmodulesConflictedFilesWhenTheStopIsInASubmodule` (layered fixture); `..._throwsWhenTheLockIsNotHeld`.

### B8. `Q_CONTINUE_RESUMED_REBASE` (`CONTINUE_RESUMED_REBASE.*`)
Input POST + REBASE + `message` + `additionalData`.
1. Refresh the lock. 2. `unmergedFilePaths` from `git -C <stoppedCheckoutPath> diff --name-only --diff-filter=U -z`. 3. Marker check: copy the regex from `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts:16` and the filter from `:30-32`. 4. A marked file: return `next: "B_FIX_RESUMED_REBASE_CONFLICTS"`, packet not changed. 5. `unmergedFilePaths.length > 0`: `git -C <stoppedCheckoutPath> add -- <paths>`. 6. `advanceTaskRebase({ ..., stepId: "continue-resumed-rebase", rootSourceBranch: "staging", stoppedAt: { occurrenceId, checkoutPath } })` (copy of `CONTINUE_REBASE.ts:18-26`). 7. `failureReason !== null`: throw (as `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:65-67`). 8. `!outcome.finished`: return the new `stopped*` / `conflictedFilePaths` fields and `next: "B_FIX_RESUMED_REBASE_CONFLICTS"`. 9. Finished: `releaseSourceRepoLock`; then a copy of `IS_REBASE_FINISHED_Q.ts:15-25` (a retained intent: `clearRebaseIntent`, return `{ ...JSON.parse(intent.targetInput), ...own, next: intent.targetBlock }`); with no intent return `next: "Q_DOES_FENCE_COVER_WORKTREE_Q"`. No counter, no try limit.
Wave H2 (`runStepHook.ts`, `walkFromStep`) is what makes the hook accept `intent.targetBlock` here even when it is outside `Q_CONTINUE_RESUMED_REBASE`'s two drawn targets (`B_FIX_RESUMED_REBASE_CONFLICTS`, `Q_DOES_FENCE_COVER_WORKTREE_Q`); with no H2 the hook would refuse it with "is not one of".
Template: input and output = POST + REBASE + `"message": "", "additionalData": {}`.
RED: `..._finishesTheRebaseReleasesTheLockAndChoosesTheFenceCheck`; `..._choosesTheAgentAgainWhenAMarkerRemains`; `..._choosesTheAgentAgainWhenTheNextCommitAlsoConflicts` (two task commits that both conflict); `..._ignoresTheAgentsResolvedFlag`; `..._outputMatchesItsTemplate`. `..._honorsARetainedRebaseIntentWhenTheRebaseFinishes` calls the block's own `main()` directly for its own assertion, then drives the SAME fixture through `runStepHook.ts` (as `tests/runStepHook.test.ts` drives a fixture config) to prove the hook accepts the dynamic `next`, via Wave H2.

### B9. edit `DOES_FENCE_COVER_WORKTREE_Q.ts`; new `B_AMEND_TASK_FILE_LIST` (`AMEND_TASK_FILE_LIST.*`)
Fence edit: output always has `violations`. The YES return adds `violations: []`. Comment out the NO return (`:19-26`). New NO return: `{ ...packet, box, scriptSignal, violations, next: "B_AMEND_TASK_FILE_LIST" }`. Template output gets `"violations": [""]`. Tests: comment out `:50`; add `..._choosesAmendTaskFileListAndPassesTheViolations`.
Amend block: 1. for each violation call `parseOccurrencePath`; `occurrenceId === ""` gives `relativePath`, else `` `${occurrenceId}/${relativePath}` ``. 2. `addTaskFiles([packet.taskNumber], paths, packet.projectRoot)` (`scripts/shared/addTaskFiles.ts:67-72`; it also updates the run-arguments snapshot). 3. Return EntryPacket with `docsMode: "UPDATE"`; `violations` is dropped; no `next` (one successor).
Template: input POST + `"violations": [""]`; output POST with `docsMode: "UPDATE"`.
RED: `..._addsEachViolationToModifiableFiles`; `..._writesASubmoduleViolationAsARepoRelativePath` (layered fixture; `tasks.json` holds `child/<file>`; a second `checkResumedWorktreeFence` call returns `inside: true`); `..._setsDocsModeUpdate`; `..._refreshesTheRunArgumentsSnapshot`; `..._doesNotAddAPathTwice`.

### B10. edit `INIT_SUBMODULES_RECURSIVELY.ts`; new `B_ADD_MISSING_FILES_TO_CREATES_FILES` (`ADD_MISSING_FILES_TO_CREATES_FILES.*`)
Init edit: output always has `missingFiles`. Comment out `:23-30`. New NO return: `{ ...packet, box, scriptSignal, missingFiles, next: "B_ADD_MISSING_FILES_TO_CREATES_FILES" }`. The YES return adds `missingFiles: []`. Template output gets `"missingFiles": [""]`. Tests: comment out `:72`; add `..._choosesAddMissingFilesToCreatesFilesAndPassesTheMissingFiles`.
New block: `addTaskCreatesFiles([taskNumber], packet.missingFiles, projectRoot)`; return EntryPacket. Template: input POST + `"missingFiles": [""]` with `docsMode: "UPDATE"`; output POST.
RED: `..._addsEachMissingFileToCreatesFiles`; `..._keepsEachMissingFileInModifiableFiles`; `..._makesInitSubmodulesRecursivelyPassOnTheNextRun` (run the `INIT_SUBMODULES_RECURSIVELY` `main` after; `next` is `"B_DOCUMENT_GENERATION"`).

## Wave H — two `scripts/hooks/runStepHook.ts` changes (one owner, with `tests/runStepHook.test.ts`)

### H1. `buildFailure` releases an orphaned source-repo lock
Read first: `buildFailure` (`runStepHook.ts:268-319`), in particular the `!worktreeExists` early return at `:284-285`; `releaseSourceRepoLock` (`scripts/tackle-tasks/shared/sourceRepoLock.ts:246-258`).
Problem: `buildFailure` returns at `:284-285` when a block throws before a worktree exists (every catch-up block runs with `worktree: ""`, and B2 and B4 run git commands that can fail). It never reaches `FAILURES_EXIT`, so the `":N"` source lock this packet holds is never released.
Rule to add: `:284-285` is the braceless line `if (!worktreeExists) return { ok: false, ran: boxesRun, errors, outcome: null, report };`. Give that `if` braces. Inside it, before the `return`, nest a second `if`: `if (projectRoot !== "") { releaseSourceRepoLock(projectRoot, buildLockOwner(packet.runId, packet.taskNumber)); }`, where `projectRoot` is `context.packet.projectRoot` (read the same way `worktree` is read at `:282`). Add no `try`/`catch`. Reason for the nested `if`: the existing test `test_runStepHook_failsWhenTheStartInputBreaksTheBlocksInputContract` (`tests/runStepHook.test.ts:257-269`) reaches this path with an empty packet, and `sourceRepoLock.ts:29-37` would then resolve `.git` against the hook's cwd.
RED: `test_runStepHook_releasesTheSourceLockWhenABlockThrowsBeforeAWorktreeExists` — a fixture config with a block whose script throws, worktree `""`, this run's owner holding the lock; after the failure, `readSourceRepoLock(root)` is `null`. `test_runStepHook_leavesAnotherOwnersLockAloneWhenABlockThrowsBeforeAWorktreeExists` — the same failure, but a DIFFERENT owner holds the lock; after the failure, `readSourceRepoLock(root)?.owner` is still that other owner. `test_runStepHook_touchesNoLockWhenAFailingPacketHasNoProjectRoot` — the same failure, but `packet.projectRoot` is `""`; no call to `releaseSourceRepoLock` runs.
GREEN: the one `releaseSourceRepoLock` call described above, guarded by the nested `if`.

### H2. `walkFromStep` accepts a saved rebase intent's target as `next`
Read first: `walkFromStep` (`runStepHook.ts:450-544`, in particular the `worktree`/`worktreeExists` read at `:462-463`, the `runStepScript` call at `:489`, and the "is not one of" failure at `:537-538`); `readRetainedRebaseIntent` and `clearRebaseIntent` (`scripts/tackle-tasks/shared/rebaseIntent.ts:15-24`); `IS_REBASE_FINISHED_Q.ts:15-25`; `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:36-42` (`retainedDestination`).
Trap: both of those blocks call `clearRebaseIntent(worktree)` BEFORE they return `next: intent.targetBlock`. By the time the hook reads the block's output at `:533`, the intent file is already gone. The hook must read the intent BEFORE `runStepScript` runs the block, not after.
Rule to add: right after `:463` (`worktreeExists` is already computed there; reuse it, do not recompute it), read `const retainedIntentTargetBlock = worktreeExists ? readRetainedRebaseIntent(worktree)?.targetBlock ?? null : null;`. Then at the `:537-538` failure, nest one more check before failing: when `chosenNextBox` is not in `step.next`, first check whether `retainedIntentTargetBlock` is `null` (fail as today when it is); when it is not `null`, check whether `String(chosenNextBox) === retainedIntentTargetBlock` (fail as today when they differ); when they match, accept `chosenNextBox` and fall through to the existing `nextStepKey = getStepKey(String(chosenNextBox), step.diagram)` line — no separate mapping step is needed, because `intent.targetBlock` is already a full `diagram.mmd::BOX` key (`resetTask.ts:422`: `writeRebaseIntent(worktreePath, { ..., targetBlock: stepKey, ... })`, and `stepKey` there is already `${diagram}::${box}`), and `getStepKey` returns a string unchanged when it already contains `"::"` (`runStepHook.ts:119-121`). The existing `STEPS_BY_KEY.has(nextStepKey)` check (`:542-544`) still runs afterward, unchanged. One condition per `if`, nested, no `&&`; add no `try`/`catch`.
RED (in `tests/runStepHook.test.ts`, `test_runStepHook_...` style):
- `test_runStepHook_acceptsANextThatMatchesTheRetainedRebaseIntentEvenWhenNotInTheDrawnList` — a fixture config with a block whose drawn `next` list does not contain some box `X`; a rebase-intent file beside the fixture worktree names `targetBlock: "X"`; the block's script returns `next: "X"`; the walk continues into `X` with no failure.
- `test_runStepHook_stillRefusesANextThatMatchesNeitherTheDrawnListNorTheRetainedIntent` — the same setup, but the intent names a DIFFERENT box `Y`, and the script still returns `next: "X"`; the hook fails with the existing "is not one of" message.
- `test_runStepHook_stillRefusesAnUndrawnNextWhenNoIntentFileExists` — no rebase-intent file beside the worktree; the script returns `next: "X"`; the hook fails with the existing "is not one of" message.
GREEN: the one `readRetainedRebaseIntent` read plus the two nested `if`s described above.
This rule also covers the two existing dynamic returns, `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:36-42` and `IS_REBASE_FINISHED_Q.ts:15-25`, which the hook could refuse today and which only `main()` tests cover.

## Wave C — the live diagram (two owners, after Wave B)

### C1. `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd`, a byte copy to `diagrams/tackle-tasks-fast/`, `scripts/tackle-tasks/diagram-steps.json`
`plans/preamble-revised.mmd` already carries every correction (folded, corrected, `file:`/`block:` lines added, prompt classes added, `newBlock`/`NEW:`/`CHANGED:` text removed — see that file). So this step is a copy, not a merge-by-thought:
1. Copy `plans/preamble-revised.mmd` byte for byte to `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` and to `diagrams/tackle-tasks-fast/pipeline-preambleStatusCheck.mmd`.
2. `npm run steps` (it writes no stub; each file named by a `file:` line already exists).
3. Hand-add `"mutating": true` to these eleven new entries: `B_LOCK_STAGING_FOR_CATCH_UP`, `Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q`, `Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q`, `B_WAIT_FOR_CATCH_UP_LOCK`, `Q_CATCH_UP_STAGING`, `B_FIX_CATCH_UP_CONFLICTS`, `Q_COMMIT_CATCH_UP_MERGE`, `B_FIX_RESUMED_REBASE_CONFLICTS`, `Q_CONTINUE_RESUMED_REBASE`, `B_AMEND_TASK_FILE_LIST`, `B_ADD_MISSING_FILES_TO_CREATES_FILES`.
4. `npm run steps` again.
5. Check the diagram: every arrow source and target id is defined; every `Q_` node reaches its targets only through `Q_CHOICE_` boxes; no leftover reference to a removed node (`Q_LOCK_STAGING_FOR_CATCH_UP`, `B_MOVE_MISSING_FILES_TO_CREATES_FILES`).

### C1b. `tests/tackleTasksAcceptance.test.ts`
`driveRun` (`:91-110`) and the six tests that call it walk the REAL preamble from `PREAMBLE_STATUS_CHECK` through the real hook, so they now cross the lock-wait loop and the catch-up block too. In every fixture repository `staging` is absent at the start, so `catchUpStagingEverywhere` creates it at `HEAD` with no conflict on the first pass; these tests need no new fixture setup, only a read-through to confirm that. `test_acceptance_releasesTheSourceLockWhenAFailureHappensWhileItIsHeld` sets `staging` to an all-zero SHA before driving; the catch-up block itself now fails on that invalid ref (worktree still `""` at that point), so this test now exercises the SAME `buildFailure` lock-release path Wave H adds, not a later stage; its assertion (`readSourceRepoLock(root) === null`) still holds and needs no change. Confirm no test in this file asserts an exact `result.ran` array (none do today; only the last element or named boxes are checked), so no test needs a literal box-list update. A test that checks a retired route (there is none checking `Q_LOCK_STAGING_FOR_CATCH_UP` or `B_MOVE_MISSING_FILES_TO_CREATES_FILES` by name) would be updated or commented out here, not sent to a code owner; D1 never routes a failure in this file to any Wave B or Wave H agent.

## Work split (edit agents never run tests, never commit; each owns only its files)

| Wave | Agent | Files |
|---|---|---|
| A | A1 | `scripts/shared/prepareTasks.ts`, `tests/catchUpStaging.test.ts` |
| A | A2 | `scripts/shared/addTaskCreatesFiles.ts`, `tests/addTaskCreatesFiles.test.ts` |
| A | A3 | `shared/FixCatchUpConflictsBodyEmitter.ts` + test, `shared/greenBoxPolicy.ts` |
| A | B0 | `preambleStatusCheck/_packet.ts` |
| A | B0b | `PREFLIGHT_OK_Q.ts` + test + template, `MARK_TASK_ACTIVE.template.json` |
| A | H (H1 + H2) | `scripts/hooks/runStepHook.ts`, `tests/runStepHook.test.ts` |
| B | B1a, B1b, B1c, B1d, B2, B3, B4, B7, B8 | one new triple each |
| B | B5, B6 | the three files of the edited block |
| B | B9, B10 | the edited block's three files + the new triple |
| C | C1 | the two `.mmd` files, `diagram-steps.json` |
| C | C1b | `tests/tackleTasksAcceptance.test.ts` |
| D | D1 | runs `npm run test:baseline` only; sends each failure back to the agent that owns the file; code changes, not test changes |

## Verification

1. `npm run steps`: `git status` shows no new stub. `cmp` on the two preamble diagram files: no difference. `rg -c FAILURES_EXIT diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` prints nothing.
2. `npm run test:baseline` (D1 only). These pass: `test_generateSteps_theCommittedStepsJsonIsUpToDate`, each `test_stepEdge_*` for the new edges, `..._everyNextLiteralIsADeclaredEdge`, `..._neverHandsOnAStaleNext` for the two blocks that follow a prompt block, the Wave H1 lock-release tests, and the Wave H2 retained-intent `next` tests.
3. Launch by hand in a scratch repository (step 3 is a hand launch of the real hook chain; nothing here is scripted): `git init`, one commit, `git branch staging`, one task in `.taskTools/tasks.json`; commit `shared.txt` = "staging side" on `staging` and "main side" on `main`; stay on `main`; run `/tackle-tasks [1]`.
   - The walk stops at `B_FIX_CATCH_UP_CONFLICTS`. `<tmp>/taskTools-wt/<repo>-<hash>/task-1-catchUpMerge` exists with `MERGE_HEAD`. The prompt file is beside it. The lock owner is `":1"`. `git status` on `main` is clean.
   - After the agent returns: `staging` is a 2-parent merge; the folder and the prompt file are gone; `git worktree list` shows no catchUpMerge line; the lock file is gone; the walk reaches `B_MARK_TASK_ACTIVE`, then the planning stage.
   - Do it again, but end the session during the agent step and launch again: the launch goes to `B_FIX_CATCH_UP_CONFLICTS` with the SAME folder.
   - Paste each command and its raw output in the report.
4. Run task 29 again in `~/Programming/relationship-mermaid` (`/tackle-tasks [29]`): it gets past the preamble.
