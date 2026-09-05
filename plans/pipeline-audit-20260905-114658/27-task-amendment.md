# Amendment: Task 27 plan — read-only health-check script for a tackle-tasks run

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/27-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/27.json and the live tackle-tasks workflow and skill
Sections: 7 | Fixes: 5
Efficacy: 29%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/27-task.md must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Three promised helper tests are absent and cannot import the helpers

- Evidence: `[plans/pipeline-audit-20260905-114658/27-task.md:27-98, plans/pipeline-audit-20260905-114658/27-task.md:125-166, plans/pipeline-audit-20260905-114658/27-task.md:228-295]`
- The plan claims: Steps 1-3 add test-first coverage for `listWorktrees`, `newestRunLog`, and `freeBytesOnVolumeOf`.
- Actually true: the full proposed test file contains only two `buildHealthCheckReport` tests. The three helpers are not exported, so the named tests cannot be added in a separate test module without changing the proposed production code.

### 2. The staging-owner assertion contradicts its fixture

- Evidence: `[plans/pipeline-audit-20260905-114658/27-task.md:241-254, plans/pipeline-audit-20260905-114658/27-task.md:272-286]`
- The plan claims: the fixture proves the report names the worktree that has `staging` checked out and expects `checked out by: ...task-1`.
- Actually true: the fixture creates `staging` as an unassociated branch, then creates the linked worktree with `-b task-1`. No worktree has `staging` checked out, so the production code prints `no worktree has it checked out` and the proposed regex fails.

### 3. Newest-log selection ignores task identity and split logical runs

- Evidence: `[scripts/runStepHook.ts:40-44, scripts/runStepHook.ts:265-284, plans/pipeline-audit-20260905-114658/27-task.md:58-74, plans/pipeline-audit-20260905-114658/27-task.md:196-203]`
- The plan claims: lexicographically selecting one newest `*-run-log.json` yields the newest run's last five entries.
- Actually true: `buildHealthCheckReport` ignores its `taskNumber` while selecting the log, so an unrelated task can win. The hook can also write an unnumbered file before learning the task number and a `-task-N-` sibling afterward under the same stamp. Reading only one file can omit the preamble or continuation entries of the same logical run.

### 4. Orphan worktree leases are invisible

- Evidence: `[scripts/prepareTasks.ts:267-279, scripts/prepareTasks.ts:376-384, plans/pipeline-audit-20260905-114658/27-task.md:188-194]`
- The plan claims: the worktree-leases section prints the pipeline's worktree lease files with owners.
- Actually true: it derives leases only from `git worktree list`. A crash can leave `<convention-path>.lease` after its worktree directory or Git registration is gone; that is precisely an orphan lease operators need a health check to reveal, but it never appears in `worktrees` and is omitted.

### 5. A partially written run log crashes a script advertised as safe mid-run

- Evidence: `[scripts/runStepHook.ts:120-128, scripts/runStepHook.ts:203-208, scripts/runStepHook.ts:281-284, plans/pipeline-audit-20260905-114658/27-task.md:196-203]`
- The plan claims: the script is safe to run mid-run and prints all diagnostic sections in one pass.
- Actually true: run logs are currently rewritten with plain `writeFileSync`, while the proposed reader performs an unguarded `JSON.parse`. Observing the file during truncation/write, or encountering a retained corrupt log after a crash, aborts the entire health check instead of reporting the remaining state and naming the unreadable log.

## Durable fixes

### Fix for issue 1

- Change: Export the three helpers (or test them through an explicitly injectable report builder) and include the three named tests in the proposed test file. Update the verification count to cover all tests actually specified.
- Durable because: Each parser/platform boundary has direct regression coverage rather than existing only as plan prose.

### Fix for issue 2

- Change: Either create a dedicated linked worktree that checks out `staging` and assert its path, or retain the current fixture and assert the explicit no-owner text. Prefer two tests covering both owned and unowned staging states.
- Durable because: The test fixture genuinely exercises the branch-ownership distinction shown in the report.

### Fix for issue 3

- Change: Define a logical-run discovery helper that groups numbered and unnumbered siblings by stamp, filters to the requested task when one is supplied, and merges entries in a documented order. Add fixtures with a newer unrelated task and split siblings for one run.
- Durable because: Diagnosis follows a run rather than an arbitrary filename and remains correct as hook passes split their logs.

### Fix for issue 4

- Change: In addition to registered worktrees, scan the target repository's convention directory for `task-*.lease` siblings and report owners, missing worktree directories, and whether Git registers each path. Deduplicate leases already found from `git worktree list`.
- Durable because: The health check exposes the orphan state created by interrupted creation/reset instead of depending on the artifact it is diagnosing to remain registered.

### Fix for issue 5

- Change: Read diagnostic JSON through a non-mutating safe reader that reports path plus parse error/raw-byte metadata and continues building other sections. Optionally retry once when file metadata changes during the read. Add empty, truncated, non-array, and concurrently replaced run-log tests.
- Durable because: The diagnostic remains available when state is corrupt or in flight—the conditions under which it is most needed.

## Sections that hold up

- Porcelain worktree parsing handles attached and detached worktrees — verified against `plans/pipeline-audit-20260905-114658/27-task.md:27-56`
- Disk-free lookup walks to an existing ancestor and uses available blocks — verified against `plans/pipeline-audit-20260905-114658/27-task.md:76-98`
- Source-lock and worktree-path helpers are reused rather than rederived — verified against `scripts/tackle-tasks/shared/sourceRepoLock.ts:37-49` and `scripts/prepareTasks.ts:267-280`
- The script performs no intended state mutation — verified against `plans/pipeline-audit-20260905-114658/27-task.md:113-225`
