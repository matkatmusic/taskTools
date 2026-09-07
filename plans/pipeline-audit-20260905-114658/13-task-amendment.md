# Amendment: Task 13 plan — preflight disk-space check before MARK_TASK_ACTIVE

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/13-task.md
- Reviewed against: the live tackle-tasks codebase and task 13 requirements
Sections: 11 | Fixes: 1
Efficacy: 91%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/13-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The test does not prove the task remains inactive

- Evidence: `[plans/pipeline-audit-20260905-114658/13-task.md:130-160, scripts/tackle-tasks/preambleStatusCheck/IS_TASK_ACTIVE_Q.ts:8-13, diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd:29-35, scripts/tackle-tasks/shared/taskRunState.ts:270-294]`
- The plan claims: the task requirement “a fake statfs under 2GB routes to REPORT_ONLY_EXIT and the task is never marked active” is covered.
- Actually true: the proposed tests call only `IS_DISK_SPACE_SUFFICIENT_Q.main` with a synthetic `/tmp` packet and assert returned fields. They create no task record, do not traverse from `IS_TASK_ACTIVE_Q`, and never inspect run state. A future ordering or integration regression could mark the task active while both tests remain green.

## Durable fixes

### Fix for issue 1

- Change: Replace or supplement the low-space unit case with a route-level test using a temporary task project: pass the inactive task through `IS_TASK_ACTIVE_Q`, feed that output to `IS_DISK_SPACE_SUFFICIENT_Q` with fake low-space stats, assert the report-only destination, and finally assert `readTaskRunState(...).active === false`. Also assert the first decision's `next` is the disk check so the tested sequence matches the diagram.
- Durable because: it pins the safety property that motivated the box's placement, not merely the decision box's return strings.

## Sections that hold up

- Placement before task claiming is correct — verified against `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd:29-37` and `scripts/tackle-tasks/preambleStatusCheck/IS_TASK_ACTIVE_Q.ts:8-13`
- The intended worktree volume is derived from the shared convention — verified against `scripts/prepareTasks.ts:377-385`
- Report-only exit is safe without a worktree — verified against `scripts/tackle-tasks/reportOnlyExit/REPORT_ONLY_EXIT.ts:7-10`
- Generator ownership and predecessor-template behavior are correctly traced — verified against `scripts/generateSteps.ts:311-367`
