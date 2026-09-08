# Amendment: Task 7 plan — path-aware JSON reader, atomic writes, and validated agent-owned reads

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/7-task.md
- Reviewed against: the live tackle-tasks pipeline implementation and failure-recovery requirements
Sections: 10 | Fixes: 5
Efficacy: 50%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/7-task.md must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The proposed reader deliberately preserves the failure it is meant to fix

- Evidence: `[plans/pipeline-audit-codex-20260905-113523.md:103-115, scripts/runStepHook.ts:235-249, scripts/runStepHook.ts:265-285]`
- The plan claims: a non-empty malformed JSON file cannot name its path without violating the no-catch rule, so a new test should require that the path remain absent.
- Actually true: the required correction explicitly calls for a path-aware reader and a non-empty truncated-file case. Catching a `SyntaxError` inside the shared reader solely to throw a new error with the path and the original error as `cause` does not swallow or recover from the failure. The plan's proposed negative assertion permanently enshrines the diagnosed bug.

### 2. Truncated packet input is routed to HOOK EXCEPTION instead of the required normal FAILURE result

- Evidence: `[scripts/runStepHook.ts:18-26, scripts/runStepHook.ts:203-210, scripts/runStepHook.ts:265-285, scripts/runStepHook.ts:493-504]`
- The plan claims: tests should assert that empty and truncated packet files produce a top-level `HOOK EXCEPTION` entry.
- Actually true: `buildFailure` is the hook's ordinary structured failure result, whereas the process-level handler is a last-resort crash path. The task calls for malformed agent state to become a `FAILURE` naming the file; sending expected validation failures through the global exception handler leaves no durable cleanup transition and reports process success after a crash.

### 3. The uncaught-exception handler remains unable to report the corrupt-log failure named in scope

- Evidence: `[scripts/runStepHook.ts:18-26, plans/pipeline-audit-codex-20260905-113523.md:107-115]`
- The plan claims: a second throw while the uncaught-exception handler reads a corrupt run log is a known out-of-scope limitation.
- Actually true: that handler and that precise recursive failure are among the audited sites this task is supposed to close. Replacing its parse with the same strict reader makes the handler fail again before it can persist `HOOK EXCEPTION`; atomic rewriting does not repair an already corrupt file.

### 4. Several pipeline-owned packet and checkpoint writes remain non-atomic

- Evidence: `[scripts/tackle-tasks/shared/writeAgentAnswer.ts:1-12, scripts/runStepHook.ts:146-173, scripts/tackle-tasks/resetTask.ts:167-172, scripts/tackle-tasks/shared/checkpoint.ts:19-33]`
- The plan claims: it applies `writeJsonAtomically` to every pipeline-owned packet, checkpoint, and run-log state file.
- Actually true: the proposed steps omit the agent-answer packet writer, the per-block diagnostic packet writer, and reset's direct checkpoint writer. Any of these can still be truncated on interruption; reset also bypasses the shared `writeCheckpoint` function the plan hardens.

### 5. Agent-owned plan and review files are parsed and cast, not validated

- Evidence: `[scripts/tackle-tasks/shared/readReviewJson.ts:4-15, scripts/tackle-tasks/whatIsReviewVerdict/WHAT_IS_REVIEW_VERDICT.ts:11-17, scripts/tackle-tasks/whatIsReviewVerdict/WHAT_IS_REVIEW_VERDICT.ts:24-55]`
- The plan claims: agent-owned files are validated by the consuming block before the next transition.
- Actually true: the proposed changes only parse and TypeScript-cast these values. Casts perform no runtime validation. `decideVerdict` immediately dereferences `plan.sections`, and review fields are trusted as `PlanReview`, so valid JSON with missing or wrong-shaped fields can still throw or corrupt a transition without a useful file-specific contract error.

## Durable fixes

### Fix for issue 1

- Change: make `readJsonFile(path)` catch only `JSON.parse` failure and throw a new error that names `path` and preserves the original exception as `cause`. Replace the proposed test that requires the path to be absent with non-empty truncated packet and plan tests that require the path.
- Durable because: every caller receives consistent file identity for both empty and syntactically corrupt JSON without converting a failure into a fallback.

### Fix for issue 2

- Change: validate/read the incoming packet inside an orchestration-boundary function that converts expected state-file errors to `buildFailure`, and assert a `FAILURE` log plus `ok:false` hook result. Reserve `uncaughtException` for genuinely unexpected defects.
- Durable because: malformed cross-process state follows the workflow's normal observable failure protocol and can be connected to durable cleanup instead of masquerading as a process crash.

### Fix for issue 3

- Change: give the exception logger an append-only emergency record independent of parsing the damaged JSON array, or atomically move the corrupt log aside and start a replacement that records both the corruption and the exception. Add a corrupt-existing-run-log test that proves the hook still emits valid hook output and durable diagnostics.
- Durable because: recording a failure no longer depends on successfully parsing the state whose corruption triggered the handler.

### Fix for issue 4

- Change: use `writeJsonAtomically` in `writeAgentAnswer` and for diagnostic packets, and replace reset's direct checkpoint write with `writeCheckpoint`. Inventory the remaining pipeline-owned JSON writes explicitly in the plan and either convert each one or state why it is not resumable state.
- Durable because: all files used by a later process or resume boundary become rename-atomic through one shared implementation.

### Fix for issue 5

- Change: add runtime validators for `plan.json` and the review result after parsing, with errors that name the file and missing or wrong fields; test syntactically valid but structurally invalid inputs as well as truncation.
- Durable because: TypeScript assertions can no longer conceal malformed agent output at a state transition.

## Sections that hold up

- Scope inventory of the current raw JSON sites — verified against `scripts/runStepHook.ts:18-43`, `scripts/runStepHook.ts:123-128`, `scripts/runStepHook.ts:203-214`, and `scripts/tackle-tasks/shared/checkpoint.ts:19-33`
- Reuse of the established atomic writer — verified against `scripts/taskStateLock.ts:55-65`
- Fence-aware review parsing requirement — verified against `scripts/tackle-tasks/shared/readReviewJson.ts:1-15`
- Shared checkpoint conversion — verified against `scripts/tackle-tasks/shared/checkpoint.ts:19-33`
- Verification command — verified against `package.json:1-20`
