# Task 102: Add a no-argument /split-task mode that lists open tasks qualifying as should-be-split

## Goal

**This task is considered done when all of these are true:**

- `/split-task` with no arguments prints the open tasks with difficulty >= 3 OR more than 3 files
- the list is sorted ascending by task number
- a qualifying task with fewer than 2 files is listed and marked unsplittable, carrying its real file count
- closed tasks never appear in the list
- the no-argument run reports the list and stops without attempting any split

## User request

run split-tasks with no args to see a list of task numbers that qualify as 'should be split'

Today the skill is two-argument-only. skills/split-task/SKILL.md:7 runs `node scripts/splitTask.ts info $ARGUMENTS[0] $ARGUMENTS[1]` unconditionally in its frontmatter, and with no arguments that reaches runInfo (scripts/splitTask.ts:145-151) with rest[0] undefined, so toPositiveInt (:137-143) throws `taskNum must be a positive integer, got "undefined"`. main() (:178-192) recognises only `info` and `close`, printing a usage line and setting exitCode 1 for anything else. So a no-arg invocation currently produces a raw error, not a list.

Work: add a third CLI mode to scripts/splitTask.ts (e.g. `candidates`) that reads the open task list via readTaskLists — already imported at splitTask.ts:1 from ./getTaskDetails.ts — filters it, and prints the qualifying tasks. Then branch in skills/split-task/SKILL.md so an empty $ARGUMENTS runs that mode, reports the list, and stops without attempting a split; the argument-hint on SKILL.md:4 (`"<taskNum> <numSplits> [guidance]"`) needs the no-arg form added, and the line-13 instruction that treats a failed `info` command as fatal must not swallow the new path.

Qualifying rule decided with the user: an open task qualifies when `difficulty >= 3` OR its file count is greater than 3. Read the count from the current `files` array. Task 58 is the one that renames that field to `modifiableFiles`/`readOnlyFiles`, and 58's own work updates this call site — the same pending rename is already flagged at scripts/addTaskFiles.ts:6. Deliberately NOT recorded as a blocker so this can ship first.

A candidate is not necessarily splittable: partitionFiles (:27-42) throws when files.length < numSplits, so a qualifying task with fewer than 2 files must still appear in the list, marked as unsplittable with its file count, rather than being silently dropped. Sorting ascending by task number keeps the output stable.

Data point at the time of writing: of 30 open tasks, 8 sit at difficulty 4, and task 91 qualifies on difficulty while declaring a single file. Existing coverage lives in tests/splitTask.test.ts.

## Files

@scripts/splitTask.ts
@skills/split-task/SKILL.md
@tests/splitTask.test.ts