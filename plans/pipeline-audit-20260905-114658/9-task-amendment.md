# Amendment: Task 9 plan — fix split run logs, then recount mid-agent deaths by runId

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/9-task.md
- Reviewed against: the live run-log, packet, checkpoint, and task-run state implementation
Sections: 5 | Fixes: 3
Efficacy: 40%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/9-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The recount classifies successful STOP runs as open

- Evidence: `[scripts/runStepHook.ts:123-128, scripts/runStepHook.ts:361-366, scripts/tackle-tasks/reportOnlyExit/STOP.ts:1-12]`
- The plan claims: only a final `FAILURE` or `HOOK EXCEPTION` log entry is terminal; every other last entry is open.
- Actually true: normal exits run a real step whose logged key ends in `::STOP`, and `SCRIPT_SIGNAL.STOP` then returns success. These logs have neither of the two proposed markers, so completed, report-only, and successfully cleaned-up runs would all be counted as open.

### 2. The algorithm cannot compare open runIds with terminal-failure runIds

- Evidence: `[scripts/runStepHook.ts:146-173, scripts/runStepHook.ts:203-210]`
- The plan claims: extract `runId` only for stamps classified open, then detect when an open runId matches a stamp classified as agent failure.
- Actually true: no `runId` is extracted for the failure stamps, so that comparison has no data to operate on. Parsing the shell-rendered `command` with a trailing-single-quote regex is also unnecessary and breaks on shell-escaped apostrophes; the diagnostic packet already stores the block's parsed result under `output.result`.

### 3. Missing worktree does not mean session cancellation

- Evidence: `[scripts/tackle-tasks/shared/taskRunState.ts:60-90, scripts/tackle-tasks/shared/taskRunState.ts:251-267, scripts/runStepHook.ts:315-331, scripts/runStepHook.ts:385-424]`
- The plan claims: an unmatched open run whose worktree is gone should be classified as `session cancel`, while a surviving worktree or checkpoint distinguishes `in progress`.
- Actually true: successful cleanup deliberately removes the worktree, and task-run history already has authoritative `endedAt` and `exitType` fields. A missing checkpoint can also mean cleanup progressed past worktree removal. Filesystem absence alone cannot distinguish completion, cancellation, cleanup failure, or reset, and the proposed algorithm does not specify how it recovers the worktree path for a stamp.

## Durable fixes

### Fix for issue 1

- Change: treat a final step key ending in `::STOP` as terminal and categorize it by diagram (`mergeSucceededExit`, `reportOnlyExit`, or `failuresExit`) and the matching task-run record. Keep `FAILURE` and `HOOK EXCEPTION` as operational terminal markers, not as synonyms for agent failure.
- Durable because: terminality follows the walker's actual stop protocol and remains correct when an exit tail changes its preceding boxes.

### Fix for issue 2

- Change: extract `runId`, task number, project root, and worktree from the newest usable packet for every stamp before classification. Prefer structured `output.result` or packet fields; if historical command parsing is required, reuse the repository's shell-quote parser rather than a trailing regex. Then group runIds across both terminal and open stamps.
- Durable because: deduplication operates on structured durable identity for the entire population and handles packet values containing apostrophes.

### Fix for issue 3

- Change: join each runId to `tasks.json` and `completedTasks.json` run history and classify from `active`, `endedAt`, and `exitType`; use checkpoint and worktree existence only as supporting evidence. Emit an explicit `unknown` bucket when durable history is unavailable instead of inferring cancellation.
- Durable because: completion and cancellation are decided from the state machine's authoritative lifecycle record, not from disposable artifacts that successful cleanup removes.

## Sections that hold up

- Split-log root cause — verified against `scripts/runStepHook.ts:34-45` and `scripts/runStepHook.ts:265-285`
- Step 1 production fix and regression shape — verified against `tests/runStepHook.test.ts:669-715` and `scripts/runStepHook.ts:251-285`
- Grouping historical sibling filenames by stamp — verified against `scripts/runStepHook.ts:34-45`
- Full-suite verification command — verified against `package.json:1-20`
