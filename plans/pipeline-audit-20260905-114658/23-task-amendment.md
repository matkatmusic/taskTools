# Amendment: Task 23 plan — hard block failures inside the failures-exit chain resume the cleanup, not the task work

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/23-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/23.json and the live tackle-tasks workflow and skill
Sections: 6 | Fixes: 3
Efficacy: 50%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/23-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The plan explicitly leaves the task's ordinary hard-failure loop unfixed

- Evidence: `[plans/pipeline-audit-20260905-114658/23-task.md:3-25, scripts/runStepHook.ts:336-359]`
- The plan claims: retrying the worktree checkpoint is tolerable for a hard failure during normal task work, so only failures after entry into `FAILURES_EXIT` are in scope.
- Actually true: the plan's own source specification says a deterministic hard failure retries forever and requires every hard failure after activation to reach a terminal report or precise resumable cleanup state. The current timeout, non-zero-exit, missing-result, bad-signal, and contract-error returns all bypass the exit chain. Narrowing the task to failures already inside the tail leaves the first and broader half of task 23 unresolved.

### 2. A tail-cursor resume starts with `inFailureChain` false

- Evidence: `[scripts/runStepHook.ts:296-317, plans/pipeline-audit-20260905-114658/16-task.md:295-309, plans/pipeline-audit-20260905-114658/23-task.md:205-219]`
- The plan claims: once a resumed tail box succeeds, the added `if (inFailureChain)` write keeps advancing the cursor for each later cleanup box.
- Actually true: `findResumeEntry` returns the cursor's block directly, but every `walkFromStep` invocation initializes `inFailureChain = false`. A direct resume at `pipeline-failuresExit.mmd::MIDDLE` therefore writes a normal worktree checkpoint, does not update the tail cursor, and never flips the flag unless it traverses the `nextStepKey === FAILURES_EXIT_KEY` edge again. If `MIDDLE` succeeds and the following box fails, the cursor remains at `MIDDLE` and the frozen work checkpoint has also been overwritten.

### 3. The proposed tests do not inject failure at each failures-exit box

- Evidence: `[plans/pipeline-audit-20260905-114658/23-task.md:150-203, plans/pipeline-audit-20260905-114658/23-task.md:225-314]`
- The plan claims: it fulfills the directive to inject a failure at each failures-exit box and prove precise continuation.
- Actually true: Step 1 uses one synthetic `MIDDLE` crash and only asserts the first block selected by the second invocation. It never lets that resumed block succeed and proves the cursor advances, and it does not exercise the real failure-exit boxes. Step 2 only tests cursor clearing at `REPORT_EXIT_TYPE_AND_NOTE`.

## Durable fixes

### Fix for issue 1

- Change: Expand the plan so every `buildFailure` path reached after a run is active constructs/persists a failure-tail entry before returning, or immediately drives `FAILURES_EXIT` when safe. Define behavior before worktree creation separately, and test deterministic script, timeout, missing output, signal, and contract failures.
- Durable because: Hard failures have one lifecycle rule regardless of which block fails, so retry cannot loop forever outside cleanup.

### Fix for issue 2

- Change: Initialize failure-tail state from the starting step (for example, whether its resolved diagram is `pipeline-failuresExit.mmd`) or carry an explicit resume kind into `walkFromStep`. Suppress normal checkpoint writes and advance `tailCursor` on resumed tail walks. Extend the test so the first resumed box succeeds, a later box fails, and the next invocation starts at that later box.
- Durable because: Tail behavior is derived on every invocation, not only from observing the transition edge during the same process.

### Fix for issue 3

- Change: Add a table-driven test over every actual box in `pipeline-failuresExit.mmd`, injecting a hard failure at that box and verifying the retained cursor, next-invocation start, lock/lease outcome, and final cursor clear. Keep the focused synthetic transition test as a unit test if useful.
- Durable because: Diagram additions or reorderings cannot silently reintroduce an uncheckpointed cleanup box.

## Sections that hold up

- Reuse of task 16's run-record cursor — verified against `plans/pipeline-audit-20260905-114658/16-task.md:154-232`
- The existing worktree checkpoint is intentionally frozen on entry to the failure chain — verified against `scripts/runStepHook.ts:385-408`
- `REPORT_EXIT_TYPE_AND_NOTE` carries the identity needed to clear a run-record cursor — verified against `scripts/tackle-tasks/failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts:1-14` and `scripts/tackle-tasks/failuresExit/_packet.ts:1-24`
