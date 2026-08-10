# Task 170: Wait for an outstanding workflow instead of starting another lap against an unchanged tip (audit C86-05)

## User request

The outstanding-workflow exception immediately retries against an unchanged tip. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-04.

This is finding C86-05 (HIGH) in plans/task-86-codex-audit.md.

After task A fails a zero-merge lap while task B is still planning, shouldEndQueue(queue, true) correctly does not terminate (scripts/runMergePhase.ts:91-93 -- the outstanding-workflow exception added by task 148). The next generated instruction is the wrong one.

In scripts/tackleTasksBrief.ts step 3 (around line 147), when shouldEndQueue prints false and queue.carryover is non-empty, the instructions unconditionally call beginNextLap(queue) with no check on workflowOutstanding / outstandingEntries.size. Task A therefore consumes lap 2 against the same source tip and can reach its retry ceiling before B is ever approved and merged.

That defeats the entire purpose of task 148's outstanding-workflow exception, which exists to wait for another approval that may advance the source tip.

Fix: gate the beginNextLap branch on outstandingEntries.size === 0. Start the next lap only when nothing is outstanding; otherwise wait for the next completion notification, the same as the empty-carryover branch already does. The generated driver must therefore distinguish "wait for an outstanding workflow" from "start another lap" as two different next actions.

Existing coverage is inadequate by design: tests/runMergePhase.test.ts:104-111 checks only that shouldEndQueue returns false and never executes or models the erroneous next action.

Watch out: tests/tackleTasksBrief.test.ts asserts the generated brief text byte-for-byte, so the new branch wording must land in step with those assertions.

## Files

@scripts/tackleTasksBrief.ts
@tests/tackleTasksBrief.test.ts
@tests/runMergePhase.test.ts