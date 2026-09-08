# Amendment: Task 17 plan — one process-tree-aware suite runner, used by both unbounded test runners

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/17-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/17.json and the live codebase
Sections: 8 | Fixes: 5
Efficacy: 38%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/17-task.md must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The timeout tests cannot change the module-level timeout

- Evidence: `[scripts/tackle-tasks/shared/runFullSuite.test.ts:1-13, scripts/tackle-tasks/shared/runTaskTestsImpl.test.ts:1-13, plans/pipeline-audit-20260905-114658/17-task.md:120-121, plans/pipeline-audit-20260905-114658/17-task.md:167-195, plans/pipeline-audit-20260905-114658/17-task.md:250-273]`
- The plan claims: assigning `process.env.SUITE_TIMEOUT_MS = "200"` after the import block makes imported `SUITE_TIMEOUT_MS` equal 200.
- Actually true: static ESM dependencies are evaluated before the importing module's body, so the proposed exported constant has already read the environment before that assignment runs. The assignment inside the task-tests case is later still. These tests would wait for the 240-second default and collide with the outer 300-second block timeout.

### 2. The process runner has unhandled spawn and kill races

- Evidence: `[plans/pipeline-audit-20260905-114658/17-task.md:126-147]`
- The plan claims: the proposed helper always resolves a timeout or exit result without throwing.
- Actually true: it installs no `error` listener for spawn failures, assumes `child.pid` exists, and calls `process.kill(-pid)` without guarding `ESRCH` when the child closes at the timeout boundary. Any of those paths can raise an uncaught exception instead of resolving the promised result.

### 3. A timed-out suite can be reclassified as passing

- Evidence: `[scripts/taskTestsRunner.ts:66-73, scripts/tackle-tasks/shared/runTaskTestsImpl.ts:133-145, scripts/tackle-tasks/shared/runFullSuite.ts:60-75, plans/pipeline-audit-20260905-114658/17-task.md:151-160, plans/pipeline-audit-20260905-114658/17-task.md:203-209]`
- The plan claims: `timedOut: true` is persisted as an unconditional red or operational result.
- Actually true: both callers still feed a non-passing run through `judgeSuite`, which returns true when all parsed failures are known. If a suite prints a known failure and then hangs, the timeout can therefore become green. `runTaskTestsImpl` does not inspect the new `timedOut` field at all, and `runFullSuite` discards it in `runCompleteSuite`.

### 4. A per-command 240-second timeout does not fit a multi-layer 300-second block

- Evidence: `[scripts/runStepHook.ts:46-47, scripts/runStepHook.ts:146-173, scripts/tackle-tasks/shared/runFullSuite.ts:47-76, plans/pipeline-audit-20260905-114658/17-task.md:120-121]`
- The plan claims: a 240-second inner timeout safely reports before the outer 300-second kill.
- Actually true: `runFullSuite` executes every occurrence sequentially. One slow layer can consume nearly 240 seconds and a later layer can then outlive the remaining outer budget, causing `runStepHook` to kill the block before it persists the full-suite result.

### 5. The replacement introduces an unbounded in-memory output buffer

- Evidence: `[scripts/tackle-tasks/shared/runFullSuite.ts:11-21, plans/pipeline-audit-20260905-114658/17-task.md:132-145]`
- The plan claims: the shared runner is safe for a command that can run for up to four minutes.
- Actually true: both stdout and stderr append without a cap for the entire process lifetime. The existing full-suite code deliberately truncates persisted output, but that happens only after the child exits; a noisy hung process can exhaust memory before then.

## Durable fixes

### Fix for issue 1

- Change: Pass timeout milliseconds as an explicit runner/caller option with `SUITE_TIMEOUT_MS` only as the production default. Tests must pass 200 directly. Make the win32 test async and `await assert.rejects`; do not mutate `process.platform` globally—inject the platform check or test a pure support predicate.
- Durable because: test behavior no longer depends on ESM evaluation order or shared process globals.

### Fix for issue 2

- Change: Specify a settle-once lifecycle for `runCommandInProcessGroup`: handle `error`, `exit`/`close`, timeout, missing PID, and guarded group-kill failures; clear the timer on every terminal path; treat `ESRCH` as already dead and surface other kill errors in the result.
- Durable because: every process lifecycle transition resolves exactly once with diagnostic state instead of escaping as an uncaught exception.

### Fix for issue 3

- Change: Preserve `timedOut` through both call stacks and make timeout override the known-failure waiver. Add task-test and full-suite cases that print a reporter-shaped known failure and then hang, asserting the persisted result remains red and explicitly names the timeout.
- Durable because: operational incompleteness can never be mistaken for a completed baseline-only test run.

### Fix for issue 4

- Change: Give `runFullSuite` one total deadline below `STEP_TIMEOUT_MS`, pass only the remaining budget to each occurrence, and stop/persist red immediately when that budget is exhausted. Alternatively raise and centralize the outer ceiling, but prove with a two-occurrence test that the result is persisted before the outer deadline.
- Durable because: the bound applies to the whole block that the outer watchdog observes, regardless of repository depth.

### Fix for issue 5

- Change: Bound captured stdout/stderr while streaming, retaining a fixed diagnostic tail (and optionally a bounded log file), and report truncation. Add a noisy-child test that verifies the result size stays bounded.
- Durable because: runtime memory consumption is capped independently of child duration and output volume.

## Sections that hold up

- Identification of both unbounded runners — verified against `scripts/taskTestsRunner.ts:28-36` and `scripts/tackle-tasks/shared/runFullSuite.ts:24-35`
- Need to kill the POSIX process group rather than only the direct child — verified against `scripts/runStepHook.ts:146-173`
- Async propagation through direct callers — verified against `scripts/tackle-tasks/shared/runTaskTestsImpl.ts:84-161`, `scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.ts:10-17`, and `scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts:25-39`

