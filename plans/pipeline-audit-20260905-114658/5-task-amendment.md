# Amendment: Task 5 plan — steps.json regeneration test, then monolith doc cleanup

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/5-task.md
- Reviewed against: the live tackle-tasks pipeline implementation, diagrams, and tests
Sections: 5 | Fixes: 1
Efficacy: 80%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/5-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The handoff to task 10 would remove the only durable source and drift guard for mutating metadata

- Evidence: `[scripts/generateSteps.ts:182-196, scripts/generateSteps.ts:311-367, plans/pipeline-audit-20260905-114658/10-task.md:369-411]`
- The plan claims: once task 10 writes `steps.json` per task, this test should change its committed input path to whatever per-task location task 10 chooses.
- Actually true: every per-task path is initially absent, while `generateSteps` obtains `mutating: true` only from the previous contents of the output path. Task 10's proposed call generates directly into that absent path, so the flags disappear. A per-task runtime artifact is also not a committed reference that this regeneration test can compare against.

## Durable fixes

### Fix for issue 1

- Change: replace the task-10 handoff note with a cross-plan contract: retain `scripts/steps.json` (or introduce another committed manifest) as the canonical generated routing and mutating baseline; keep this test pointed at that committed baseline. Require task 10 to seed each new per-task `steps.json` from the canonical baseline before regeneration, or move mutating declarations into a separate committed source that `generateSteps` reads independently of its output path.
- Durable because: every fresh task receives the same reviewed mutation policy, while the test continues to detect diagram/config drift instead of depending on an ephemeral runtime file.

## Sections that hold up

- Scope confirmation — verified against `tests/generateSteps.test.ts:1-25`, `scripts/generateSteps.ts:199-218`, and `diagrams/tackle-tasks/_pipeline-monolith.mmd:1-193`
- Step 1 regeneration-test mechanics — verified against `scripts/generateSteps.ts:182-196` and `scripts/generateSteps.ts:311-367`
- Step 2 monolith documentation corrections — verified against `diagrams/tackle-tasks/pipeline-whatDidThePlannerReturn.mmd:14-22`, `diagrams/tackle-tasks/pipeline-commitImplementationIfNeeded.mmd:17-29`, and `diagrams/tackle-tasks/pipeline-fixImplementTaskTests.mmd:1-14`
- Verification — verified against `package.json:1-20`
