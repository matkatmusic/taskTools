# Amendment: Task 11 plan — comment out planPrompt's dead `extra` parameter

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/11-task.md
- Reviewed against: the live tackle-tasks codebase and task 11 requirements
Sections: 5 | Fixes: 1
Efficacy: 80%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/11-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Retirement leaves the block-only helpers live

- Evidence: `[scripts/tackle-tasks/shared/planPrompt.ts:20-29, scripts/tackle-tasks/shared/planPrompt.ts:38-66, plans/pipeline-audit-20260905-114658/11-task.md:107-132]`
- The plan claims: the `extra` facility and its three block builders are retired.
- Actually true: after commenting the builders, `WRITE_CLARIFY_REQUEST_PATH`, `RECORD_PLAN_REVIEW_PATH`, `UPDATE_TASK_DOCS_PATH`, and `shellQuote` remain as live declarations with no consumer. The plan also replaces the retired assembly with a live `leadingBlocks = ""` and retains its interpolation, leaving new dead scaffolding behind in a cleanup-only task.

## Durable fixes

### Fix for issue 1

- Change: Comment out the three path constants and `shellQuote` with the same retirement note as their builders. Remove the live empty `leadingBlocks` replacement and change the return prefix from `${leadingBlocks}${codexNotes}` to `${codexNotes}`. Extend the verification grep to cover the retired helper identifiers as well as `extra`.
- Durable because: no executable remnant of the retired feature remains to be mistaken for a supported path or silently revived later.

## Sections that hold up

- No live caller supplies `extra` — verified against `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:19-28` and `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:53-65`
- Clarify data still reaches the planner through the task brief — verified against `scripts/tackle-tasks/shared/planPrompt.ts:102-108` and `scripts/tackle-tasks/shared/planPrompt.ts:150-158`
- The payload-specific test is obsolete with the feature — verified against `scripts/tackle-tasks/shared/planPrompt.test.ts:27-53`
