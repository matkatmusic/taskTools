# Amendment: Task 29 plan — commit the known-failing-test baseline as a tracked file

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/29-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/29.json and the live tackle-tasks workflow and skill
Sections: 6 | Fixes: 2
Efficacy: 67%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/29-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The existing tests do not prove that the tracked baseline is used

- Evidence: `[tests/taskTestsRunner.test.ts:39-47, scripts/taskTestsRunner.ts:53-73, plans/pipeline-audit-20260905-114658/29-task.md:31-43]`
- The plan claims: the two `judgeSuite` unit tests already prove a run whose only failures are in the baseline passes and a new failure reports red.
- Actually true: those tests manually pass either `[]` or the complete failure array as the already-computed `newFailures` argument. They never read `.taskTools/knownFailingTests.json`, call `readKnownFailingTests`, compare through `newFailingTests`, or run a suite. They would keep passing if the tracked baseline were missing, malformed, or ignored.

### 2. The full-suite verification command bypasses baseline handling

- Evidence: `[package.json:2-8, scripts/taskTestsRunner.ts:28-36, scripts/taskTestsRunner.ts:66-73, plans/pipeline-audit-20260905-114658/29-task.md:126-144]`
- The plan claims: the raw `npm test | awk` verification should print `all passing` after committing the known-failing baseline.
- Actually true: `npm test` invokes Node's test runner directly. The baseline is consulted only by `taskTestsRunner`/pipeline judging after the suite output is parsed; the shell pipeline in Verification does not read it. If the baseline's named pre-existing test is still failing, the proposed verification remains red even though the baseline-aware result is correctly green.

## Durable fixes

### Fix for issue 1

- Change: Add an integration-level test that creates a temporary project baseline, reads it with `readKnownFailingTests`, parses or supplies the observed failures, computes `newFailingTests`, and passes that result to `judgeSuite`; assert baseline-only is green and baseline-plus-new is red. Include a malformed/missing-baseline behavior assertion if those states are part of the contract.
- Durable because: The committed file path and the complete baseline decision pipeline are exercised, not just the final pure boolean function with precomputed inputs.

### Fix for issue 2

- Change: Keep raw `npm test` as an informational suite run if desired, but verify the acceptance requirement through the baseline-aware runner/hook and state the two outcomes separately. Do not require raw npm output to say `all passing` when a deliberately baselined test remains red.
- Durable because: Verification uses the same path whose behavior this task changes and cannot confuse raw test health with the baseline policy decision.

## Sections that hold up

- The four requested paths and current tracked/untracked states — verified against `.taskTools/knownFailingTests.json:1-8`, `scripts/taskTestsRunner.ts:1-74`, `skills/task-tests/SKILL.md:1-8`, and `tests/taskTestsRunner.test.ts:1-47`
- Explicit-path staging avoids sweeping unrelated working-tree changes — verified against `plans/pipeline-audit-20260905-114658/29-task.md:59-83`
- The plan correctly leaves the commit itself to the user — verified against `plans/pipeline-audit-20260905-114658/29-task.md:1-4` and `plans/pipeline-audit-20260905-114658/29-task.md:85-105`
