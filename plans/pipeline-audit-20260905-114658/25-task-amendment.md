# Amendment: Task 25 plan — lock mutation-guard recovery (LOCK-2)

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/25-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/25.json and the live tackle-tasks workflow and skill
Sections: 6 | Fixes: 1
Efficacy: 83%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/25-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Compare-then-unlink can delete a newly acquired live guard

- Evidence: `[scripts/tackle-tasks/shared/sourceRepoLock.ts:65-99, plans/pipeline-audit-20260905-114658/25-task.md:208-241, plans/pipeline-audit-20260905-114658/25-task.md:294-342]`
- The plan claims: rereading equal bytes immediately before `unlinkSync(guardPath)` means recovery can never remove a guard that changed underneath the check.
- Actually true: equality and unlink are separate path operations. Two timed-out contenders can both read and recheck the same dead guard. The first unlinks it and acquires a new live guard; the second can then execute its already-authorized `unlinkSync` against the new guard at the same path, enter the retry, and overlap the live holder. The proposed live-owner test has only one recovery contender and cannot expose this race.

## Durable fixes

### Fix for issue 1

- Change: Replace the compare-then-unlink recovery with a protocol that serializes recovery and acquisition as one ownership transition, so authorization is bound to the exact guard object rather than only its pathname. Add a deterministic two-reclaimer test paused after both validate the dead guard; prove only one enters the guarded action and the other never removes its successor. Do not claim “never” until that interleaving is covered.
- Durable because: Safety is established under the concurrent recovery case that can otherwise turn stale cleanup into loss of mutual exclusion.

## Sections that hold up

- Guard creation uses exclusive create and fsync — verified against `scripts/tackle-tasks/shared/sourceRepoLock.ts:71-80`
- PID liveness is conservative on errors other than `ESRCH` — verified against `plans/pipeline-audit-20260905-114658/25-task.md:198-206`
- The plan covers acquisition, publication, refresh, release, and a live holder — verified against `plans/pipeline-audit-20260905-114658/25-task.md:99-193` and `plans/pipeline-audit-20260905-114658/25-task.md:255-289`
