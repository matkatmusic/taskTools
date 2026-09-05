# Amendment: Task 19 plan — lift the difficulty >= 7 agent choice out of PLAN_THE_TASK into a decision box

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/19-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/19.json and the live codebase
Sections: 11 | Fixes: 1
Efficacy: 91%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/19-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The replan script still returns the removed route

- Evidence: `[scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.ts:11-29, scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.test.ts:37-69, scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.template.json:17-31, scripts/runStepHook.ts:372-380, plans/pipeline-audit-20260905-114658/19-task.md:282-309]`
- The plan claims: renaming the dashed replan edge in `pipeline-whatIsReviewVerdict.mmd` is sufficient to route every replan through `IS_DIFFICULTY_7_PLUS_Q`.
- Actually true: `TWO_CODEX_REVIEWS_COMPLETED_Q.ts` explicitly returns `pipeline-planTheTask.mmd::PLAN_THE_TASK` on both replan paths. After regeneration, that value is no longer one of the decision box's configured edges, so `runStepHook` rejects it as an invalid `next`. Its tests and output template also pin the old value.

## Durable fixes

### Fix for issue 1

- Change: Add `TWO_CODEX_REVIEWS_COMPLETED_Q.ts`, its test, and its template to Step 3c. Change both production replan returns and all three replan assertions/template samples to `pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q`. Add a generated-config or walk-level assertion that the value returned by this real script is included in the regenerated step's `next` array.
- Durable because: the executable route, its declared contract, its tests, and the Mermaid-derived graph all name the same decision entry rather than relying on a diagram-only rename.

## Sections that hold up

- Difficulty lookup and script split — verified against `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:19-66`
- Owner-folder map requirement — verified against `scripts/generateSteps.ts:11-53` and `scripts/generateSteps.ts:300-367`
- Both external diagram entry declarations need renaming — verified against `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd:21-57` and `diagrams/tackle-tasks/pipeline-whatIsReviewVerdict.mmd:10-31`
- Regeneration and targeted tests — verified against `package.json:3-7`

