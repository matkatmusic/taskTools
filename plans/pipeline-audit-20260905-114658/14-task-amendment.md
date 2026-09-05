# Amendment: Task 14 plan — run-step hook needs explicit timeouts and a lock-wait deadline below them

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/14-task.md
- Reviewed against: the live tackle-tasks codebase and task 14 requirements
Sections: 5 | Fixes: 3
Efficacy: 40%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/14-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. An existing test will fail on the changed exit note

- Evidence: `[plans/pipeline-audit-20260905-114658/14-task.md:43-47, plans/pipeline-audit-20260905-114658/14-task.md:77-96, scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.test.ts:25-33, scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts:24-33]`
- The plan claims: both existing deadline tests remain correct and need no edit, while the production `exitNote` changes from “15 minutes” to “8 minutes.”
- Actually true: `test_have15MinutesPassed_exitsRunFailedAfterTheCap` asserts exact equality with the old 15-minute message, so the planned production change makes the stated verification fail.

### 2. The 600-second timeout does not bound the whole hook walk

- Evidence: `[plans/pipeline-audit-20260905-114658/14-task.md:98-162, scripts/runStepHook.ts:146-172, scripts/runStepHook.ts:265-310, scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.ts:10-13, diagrams/tackle-tasks/pipeline-commitImplementationIfNeeded.mmd:22-30]`
- The plan claims: `LOCK_WAIT_DEADLINE_MS < hook timeout` proves the hook cannot still be running when Claude Code kills it, and 120 seconds is available for surrounding work.
- Actually true: the hook timeout covers the entire `while (true)` walk, not just time since `LOCK_SOURCE_REPO` first ran. One real path runs task tests before entering the lock loop, and each block subprocess may consume up to the hook's five-minute per-step cap. Five minutes of tests plus eight minutes of lock waiting already exceeds the proposed ten-minute hook timeout. The static comparison test therefore proves an irrelevant inequality.

### 3. User-visible 15-minute contracts remain stale

- Evidence: `[diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd:6-23, diagrams/tackle-tasks/_pipeline-monolith.mmd:65-82, scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts:1-8, plans/pipeline-audit-20260905-114658/14-task.md:68-96]`
- The plan claims: replacing the constant and exit note completes the move to an eight-minute deadline.
- Actually true: the live box/file name and Mermaid label remain `HAVE_15_MINUTES_PASSED_Q` / “have 15 minutes passed?”, while the specification diagram still says “wait up to 15 minutes.” That leaves the routing contract and implementation describing different deadlines.

## Durable fixes

### Fix for issue 1

- Change: Update the existing exact `exitNote` assertion to the new message (or derive the message from one exported deadline label), and retain the existing 16-minute case as an above-cap regression test.
- Durable because: production wording and its behavioral test change together instead of making the full suite predictably red.

### Fix for issue 2

- Change: Replace the lock-local static inequality with a hook-wide safe design. Prefer the task brief's durable-retry option: on an unavailable lock, persist the original wait-start/checkpoint and yield an outcome to the workflow so the next retry occurs in a new hook invocation; enforce the elapsed cap across those invocations. At minimum, budget from hook-process start rather than lock-start and stop with enough reserved time for the failure tail. Add the required held-lock integration tests for both `UserPromptSubmit` and `PostToolUse:Skill`, using shortened wait/deadline values, and assert they produce a durable report instead of being killed.
- Durable because: correctness no longer depends on how much of the same hook invocation was consumed by tests or other preceding blocks, and the two actual registration paths are exercised rather than only inspecting JSON numbers.

### Fix for issue 3

- Change: Rename the decision box/script/template/test to deadline-neutral names such as `HAS_LOCK_WAIT_DEADLINE_PASSED_Q`, update the live Mermaid label and generated routing, and update the monolith/spec wording to eight minutes (or a symbolic configured deadline). Regenerate `steps.json` after the rename.
- Durable because: future deadline changes no longer require another semantic filename migration, and diagrams, generated config, tests, and runtime messages describe one policy.

## Sections that hold up

- Both hook registrations currently lack explicit timeouts — verified against `hooks/hooks.json:3-26` and `hooks/hooks.json:56-71`
- The current lock loop stays inside one hook invocation — verified against `scripts/tackle-tasks/lockSourceRepo/WAIT_FOR_LOCK.ts:7-25`, `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts:24-33`, and `scripts/runStepHook.ts:306-310`
- Hook timeout values are expressed in seconds in the existing manifest — verified against `hooks/hooks.json:22-26` and `hooks/hooks.json:68-71`
