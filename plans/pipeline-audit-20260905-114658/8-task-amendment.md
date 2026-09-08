# Amendment: Task 8 plan — resolveOrCreateStagingTip must never force-move an existing staging ref

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/8-task.md
- Reviewed against: the live staging-branch and worktree implementation and tests
Sections: 7 | Fixes: 1
Efficacy: 86%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/8-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The checked-out-staging regression test should be inverted, not retired

- Evidence: `[scripts/prepareTasks.ts:186-210, tests/prepareTasks.test.ts:161-176]`
- The plan claims: once the fallback is removed, staging being checked out in another worktree is no longer a distinguishable scenario, so its test should be commented out.
- Actually true: it remains a distinct Git topology with an attached worktree whose branch and working tree must both remain unchanged. Retiring the only test for it leaves future code free to reintroduce a side effect specifically when staging is checked out elsewhere.

## Durable fixes

### Fix for issue 1

- Change: replace the old fallback assertions with assertions that the staging ref and the staging worktree's `HEAD` both remain at the original staging tip after `createWorktreeForGroup`, while the new task worktree is also created from that tip.
- Durable because: both the ordinary ref case and Git's checked-out-branch case continuously enforce the invariant that preparation never advances an existing staging branch.

## Sections that hold up

- Scope confirmation — verified against `scripts/prepareTasks.ts:175-210` and `tests/prepareTasks.test.ts:143-176`
- Step 1 staging-tip regression — verified against `tests/prepareTasks.test.ts:143-159`
- Step 3 production change — verified against `scripts/prepareTasks.ts:186-210`
- Step 4 unaffected behavior — verified against `tests/prepareTasks.test.ts:130-141` and `tests/prepareTasks.test.ts:204-222`
- Verification — verified against `package.json:1-20`
