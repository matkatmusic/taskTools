# Task 174: Build the archived record from the guarded removal snapshot so closeTasks cannot archive a stale task (audit C86-09)

## User request

`closeTasks` can archive a stale version of the task it closes. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-08.

This is finding C86-09 (HIGH) in plans/task-86-codex-audit.md.

closeTasks reads tasks.json once and freezes the closing task record early (scripts/closeTasks.ts:85 and :103-113), building a `resolved` map keyed by taskNumber whose `task` field comes from that initial read. The completedTasks.json hashGuardedRewrite then archives each record as { ...task, completionDate, commitHashes, closureNote } using that STALE task (:115-129).

Only afterward does the guarded removal reread the current tasks.json bytes (:132-136), and it merely filters the task out with parsedTasks.filter(...). It never re-derives the archived record from that fresh read.

So if another writer -- for example addTaskFiles widening the task's files, the C86-08 path in task 173 -- mutates the same task record between the initial read and the guarded removal, the NEW record is removed from active tasks while the OLD record is what lands in completedTasks.json. That violates task 152's requirement that a retry reapply the archive operation to the other writer's bytes without losing either change.

FIX DIRECTION, settled with the user: derive the archived record from the same successfully guarded current snapshot used for the removal -- one read, one truth -- rather than detecting the change and aborting the close. Take the record from inside the tasksPath hashGuardedRewrite mutate callback. closureNote and commitHashes can still come from `resolved`, since they are caller-supplied and are not part of the racing record. On a hash-guard retry the archive must be rebuilt from the retried bytes, never from the first read.

Existing coverage in tests/closeTasks.test.ts exercises the hash-guard helper and preservation of unrelated bytes. It does NOT cover a close race that mutates the closing record itself.

## Files

@scripts/closeTasks.ts
@tests/closeTasks.test.ts