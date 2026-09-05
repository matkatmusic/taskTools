# Amendment: Task 15 plan — resume into ARCHIVE_TASK can never succeed (missing closureNote)

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/15-task.md
- Reviewed against: the live tackle-tasks codebase and task 15 requirements
Sections: 5 | Fixes: 0
Efficacy: 100%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/15-task.md can be used as is.

## Issues

None found.

## Sections that hold up

- The inactive completed-run branch supplies no `closureNote` to `ARCHIVE_TASK` — verified against `scripts/tackle-tasks/shared/resumeRun.ts:29-38` and `scripts/tackle-tasks/mergeSucceededExit/ARCHIVE_TASK.template.json:1-15`
- `BUILD_CLOSURE_NOTE` accepts the existing five-field resume packet and produces `closureNote` — verified against `scripts/tackle-tasks/mergeSucceededExit/BUILD_CLOSURE_NOTE.ts:7-23` and `scripts/tackle-tasks/mergeSucceededExit/BUILD_CLOSURE_NOTE.template.json:1-16`
- Replaying task inactivation is idempotent for the same ended run — verified against `scripts/tackle-tasks/shared/markTaskInactive.ts:9-18`
- The proposed contract test reuses the same shape checker as the hook — verified against `scripts/templateShape.ts:17-52` and `scripts/runStepHook.ts:228-240`
- The existing inactive-case test pins the broken destination and is the correct replacement target — verified against `scripts/tackle-tasks/shared/resumeRun.test.ts:166-181`
