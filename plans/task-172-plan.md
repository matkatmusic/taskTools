# Task 172 plan: typed failure results for cleanup, merge, and close (audit C86-07)

## Problem (from brief-172.md / task-86-codex-audit.md finding C86-07)

Three merge-stage failure paths in `skills/tackle-tasks/task.workflow.js`'s `runMerge` do not
produce a result matching what `recordStageOutcome` / `recordMergedNotClosed` / `buildMergeReport`
(in `scripts/runMergePhase.ts`) and the generated driver text (in `scripts/tackleTasksBrief.ts`)
already assume:

1. `cleanupPlanAndBriefFiles` (lines 664-676) can throw on a `git rm`/`git commit` failure. That
   throw is not caught anywhere in `runMerge`, so it escapes as a rejected promise with no
   structured result — the queue gets nothing to record.
2. When `mergeTaskDeepestFirst`'s report has `status !== 'merged'` (line 697), `runMerge` returns
   the report as-is, spreading its `failureReason` field but never copying it to a top-level
   `lastFailure`, which is the field the driver reads unconditionally on any non-`merged` /
   non-`merged-but-not-closed` status.
3. When `closeResult.closed` excludes `N` (lines 709-711), `runMerge` returns
   `status: 'merged-but-not-closed'` with no `closeError` field at all, so
   `recordMergedNotClosed(queue, taskNumber, mergedCommitHash, closeError)` (per the driver text
   in `tackleTasksBrief.ts`) is called with `closeError` undefined — `MergedNotClosedTask.lastFailure`
   ends up `undefined` instead of the `string` its type promises.

`scripts/runMergePhase.ts` needs no functional change: its logic already assumes a concrete
`lastFailure`/`closeError` on every result it's given. The fix is entirely in
`skills/tackle-tasks/task.workflow.js`'s `runMerge`.

Coverage gap: `tests/taskWorkflowMergeStage.test.ts`'s cleanup-failure test (lines 299-328)
currently asserts the workflow promise *rejects* — treating that as sufficient, even though a
rejected promise carries no structured result and so can never be queued or reported. Once fix 1
lands, that promise no longer rejects; the test must assert the new structured `blocked` result
instead. `tests/runMergePhase.test.ts` has a real success-path end-to-end test
(`test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`) but no
end-to-end *failure* test that feeds a real `task.workflow.js` merge-stage result through
`recordStageOutcome`/`buildMergeReport` — every existing failure-path test in that file injects a
synthetic reason string directly. Add one that does.

## Edits to `skills/tackle-tasks/task.workflow.js`

### Edit 1 — catch `cleanupPlanAndBriefFiles`'s throw (line 690)

Current text (line 690, inside `runMerge`):
```
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
```

Replace with:
```
  try {
    cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  } catch (error) {
    return { stage: 'merge', task: N, status: 'blocked', lastFailure: `cleanup failed: ${String((error && error.message) || error)}` }
  }
```

This returns before `manifest`, `rootOccurrence`, `mainRepoRoot`, and `sourceBranch` (lines
691-695) are computed, which is correct — none of them are needed to report a cleanup failure, and
none are used inside this new `catch` block.

### Edit 2 — copy `report.failureReason` to a top-level `lastFailure` (lines 697-699)

Current text:
```
  if (report.status !== 'merged') {
    return { stage: 'merge', task: N, failedAtStage, ...report }
  }
```

Replace with:
```
  if (report.status !== 'merged') {
    return { stage: 'merge', task: N, failedAtStage, ...report, lastFailure: report.failureReason }
  }
```

`...report` already spreads `failureReason` (per the brief) onto the result; this adds the
top-level `lastFailure` field the driver and `recordStageOutcome` read unconditionally, without
removing `failureReason`.

### Edit 3 — add a concrete `closeError` when `closeResult.closed` excludes `N` (lines 709-711)

Current text:
```
  if (!closeResult.closed.includes(N)) {
    return { stage: 'merge', task: N, failedAtStage, ...report, status: 'merged-but-not-closed', mergedCommitHash, closed: closeResult.closed, skipped: closeResult.skipped, unblocked: closeResult.unblocked }
  }
```

Replace with:
```
  if (!closeResult.closed.includes(N)) {
    const closeError = `closeTasks did not close task ${N}: closed [${closeResult.closed.join(', ')}], skipped [${closeResult.skipped.join(', ')}], unblocked [${closeResult.unblocked.join(', ')}]`
    return { stage: 'merge', task: N, failedAtStage, ...report, status: 'merged-but-not-closed', mergedCommitHash, closed: closeResult.closed, skipped: closeResult.skipped, unblocked: closeResult.unblocked, closeError }
  }
```

This gives `results[0].closeError` a concrete string in this branch, matching the branch at lines
706-707 (the `catch (error)` branch), which already sets `closeError`. No other line in `runMerge`
changes — the `catch (error)` branch at line 706-707 and the `removeWorktreeAndBranch` failure
branch at lines 712-717 (the intended non-fatal `cleanupWarning` for the final worktree removal)
are already correct and stay untouched.

No other edits are needed in this file: `cleanupPlanAndBriefFiles` itself (lines 664-676) keeps
throwing on failure — that's still correct, since Edit 1 is what converts the throw into a typed
result at its one call site.

## Edits to `tests/taskWorkflowMergeStage.test.ts`

### Edit 4 — assert the structured `blocked` result instead of a rejected promise (lines 311-328)

Current text (inside the test `'merge stage: a cleanup commit blocked by a hook leaves the source
branch unmoved and the worktree intact'`, taskNumber 9005):
```
    const headBefore = git(root, 'rev-parse', 'main')
    const worktreeHeadBefore = git(worktreePath, 'rev-parse', 'HEAD')

    await assert.rejects(() => runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest }))

    assert.equal(git(root, 'rev-parse', 'main'), headBefore)
    assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), worktreeHeadBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
```

Replace with:
```
    const headBefore = git(root, 'rev-parse', 'main')
    const worktreeHeadBefore = git(worktreePath, 'rev-parse', 'HEAD')

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.lastFailure, /cleanup failed/)

    assert.equal(git(root, 'rev-parse', 'main'), headBefore)
    assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), worktreeHeadBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
```

No other lines in this test (or this file) change — the test's setup (writing/committing the plan
and brief files at lines 304-307, installing the `pre-commit` hook at lines 309-310) already
produces exactly the throw Edit 1 now catches: the hook fires on `cleanupPlanAndBriefFiles`'s own
cleanup commit (line 674 of `task.workflow.js`), which is the only commit attempted after the hook
is installed.

## Edits to `tests/runMergePhase.test.ts`

### Edit 5 — import `chmodSync` (line 5)

Current text:
```
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
```

Replace with:
```
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
```

### Edit 6 — add a real end-to-end merge-failure test (append after line 315, i.e. after the closing
`});` of `test_shouldEndQueueReportsStuckWhenALapMergesNothingAndAPriorLapsFailureIsInUnmerged`)

Current text at the end of the file (lines 304-316):
```
test("test_shouldEndQueueReportsStuckWhenALapMergesNothingAndAPriorLapsFailureIsInUnmerged", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 91);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts again" });

    assert.deepEqual(queue.unmerged, [{ taskNumber: 91, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: i.ts again" }]);
    assert.deepEqual(queue.carryover, []);
    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "stuck");
});
```

Append this new test immediately after it (same file, new final content):
```
test("test_shouldEndQueueReportsStuckWhenALapMergesNothingAndAPriorLapsFailureIsInUnmerged", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 91);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 91, "rebase-test", { status: "failure", reason: "rebase conflicted: i.ts again" });

    assert.deepEqual(queue.unmerged, [{ taskNumber: 91, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: i.ts again" }]);
    assert.deepEqual(queue.carryover, []);
    assert.equal(currentLapIsComplete(queue), true);
    assert.equal(shouldEndQueue(queue, false), "stuck");
});

test("test_endToEndQueueFeedsARealMergeStageCleanupFailureIntoRecordStageOutcomeAndBuildMergeReport", async () => {
    const taskNumber = 9102;
    const { root, worktreePath, repositoryManifest } = makeQueueFixtureRepo(taskNumber);
    try {
        writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n");
        git(worktreePath, "add", "taskfile.txt");
        git(worktreePath, "commit", "-q", "-m", "task change");

        writeFileSync(join(worktreePath, "plans", `task-${taskNumber}-plan.md`), "plan\n");
        writeFileSync(join(worktreePath, "plans", `brief-${taskNumber}.md`), "brief\n");
        git(worktreePath, "add", `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`);
        git(worktreePath, "commit", "-q", "-m", "plan and brief");

        let queue = createMergeQueue();
        queue = enqueueApprovedTask(queue, taskNumber);

        let step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "rebase-test" });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest });
        const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
        assert.equal(rebaseTestOutcome.status, "green");
        queue = recordStageOutcome(queue, taskNumber, "rebase-test", { status: "success" });

        step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "merge" });

        writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);

        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest });
        const mergeOutcome = mergeResult.results[0] as { status: string; lastFailure: string };
        assert.equal(mergeOutcome.status, "blocked");
        assert.match(mergeOutcome.lastFailure, /cleanup failed/);

        queue = recordStageOutcome(queue, taskNumber, "merge", { status: "failure", reason: mergeOutcome.lastFailure });

        assert.equal(shouldEndQueue(queue, false), "stuck");
        const report = buildMergeReport(queue);
        assert.deepEqual(report.unmerged, [
            { taskNumber, lastFailure: mergeOutcome.lastFailure, terminalReason: "zero-merge lap ended the queue" },
        ]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});
```

This drives the fixed `runMerge` for real (rebase-test stage green, then a merge stage whose
cleanup commit is blocked by a `pre-commit` hook shared with the worktree — the same mechanism
used in `tests/taskWorkflowMergeStage.test.ts`'s hook-based cleanup test), and feeds the real
`lastFailure` string the workflow produced into `recordStageOutcome` and then `buildMergeReport`,
rather than a synthetic reason string. `makeQueueFixtureRepo`, `runTaskWorkflowStage`, and `git`
(defined earlier in this same file, lines 202-256) are reused unchanged; no new imports beyond
`chmodSync` (Edit 5) are needed — `recordStageOutcome`, `buildMergeReport`, `shouldEndQueue`,
`createMergeQueue`, `enqueueApprovedTask`, and `nextQueueStep` are already imported at line 11.

## Files needing no edit

- `scripts/runMergePhase.ts`: no change. `recordStageOutcome`, `recordMergedNotClosed`, and
  `buildMergeReport` already assume a concrete `lastFailure`/`closeError` on every result passed
  to them — the mismatch is entirely on the producing side (`task.workflow.js`'s `runMerge`),
  fixed by Edits 1-3 above.
- `scripts/tackleTasksBrief.ts`: no change. Its generated driver text already reads
  `results[0].lastFailure` and `results[0].closeError` exactly as Edits 1-3 now guarantee they
  exist; the brief text itself needs no rewording since it was already describing the intended
  contract, not the buggy one.

## Verification

Run, from the repo root:

```
npm test
```

Expected: all tests pass, including:
- `tests/taskWorkflowMergeStage.test.ts` → `'merge stage: a cleanup commit blocked by a hook leaves the source branch unmoved and the worktree intact'` passes with the new structured-result assertions (no `assert.rejects` call remains in this test).
- `tests/runMergePhase.test.ts` → the new `test_endToEndQueueFeedsARealMergeStageCleanupFailureIntoRecordStageOutcomeAndBuildMergeReport` passes, proving a real `task.workflow.js` merge-stage failure (`status: 'blocked'`, `lastFailure` matching `/cleanup failed/`) flows through `recordStageOutcome` and `buildMergeReport` into a `report.unmerged` entry carrying that exact `lastFailure` text.
- Every other existing test in both files still passes unchanged (in particular the two `'merged'`/`'merged-but-not-closed'` success-path tests in `tests/taskWorkflowMergeStage.test.ts` and the pre-existing end-to-end success test in `tests/runMergePhase.test.ts`, none of which this plan's edits touch).

Also run a targeted pass to isolate these two files quickly during development:

```
node --test tests/taskWorkflowMergeStage.test.ts tests/runMergePhase.test.ts
```

Expected: `# pass` count includes all tests in both files, `# fail 0`.
