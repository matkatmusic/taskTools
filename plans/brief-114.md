# Task 114: checkBlockers halts the run when the open-task blockedBy graph contains a cycle

## Goal

**This task is considered done when all of these are true:**

checkBlockers walks the open-task blockedBy graph and finds any cycle.
On a cycle it prints every task number in that cycle.
On a cycle it exits non-zero, so the tackle-tasks run halts before any planning cost.
A self-blocking task (1 blockedBy 1) is reported the same way.
Acyclic data produces unchanged output and exit code zero.
A blockedBy entry naming a completed or nonexistent task is ignored, not reported as a cycle.

## User request

Add a blockedBy cycle check to scripts/checkBlockers.ts so a tackle-tasks run halts loudly instead of silently mis-reporting. Today no script anywhere detects cycles: scripts/checkBlockers.ts:15-16, scripts/taskStats.ts:25-26 and scripts/runStartup.ts:12-14 each independently resolve only ONE level of blockedBy and filter to still-open task numbers, so a loop like 1 blockedBy 2, 2 blockedBy 3, 3 blockedBy 1 is never noticed. The consequence is that every task in such a loop reports as permanently BLOCKED with no path to unblocking, and task-stats chain rendering (task 108) silently omits them because a pure cycle contains no sink. Verified against the live .taskTools/tasks.json at the time of writing: 36 open tasks, 8 blocked (36, 83, 84, 96, 97, 105, 106, 113), zero cycles - so this is a guard against a future bad edit, not a fix for existing data. checkBlockers.ts is the right home because it already runs at the start of every tackle-tasks invocation, before any planning or implementation work happens, so a cycle surfaces at the cheapest possible moment. Implementation should walk the open-task blockedBy graph with a depth-first search tracking an in-progress set, and on detecting a back edge print the offending cycle as the task numbers involved and exit non-zero so the run stops. Files: scripts/checkBlockers.ts and tests/checkBlockers.test.ts. Tests: assert a three-task cycle 1-2-3 is detected and reported with all three numbers and a non-zero exit; assert a self-blocking task 1 blockedBy 1 is detected; assert the existing acyclic fixtures in tests/checkBlockers.test.ts still pass unchanged and exit zero; assert a blockedBy entry pointing at an already-completed or nonexistent task number is ignored rather than treated as a cycle. Do NOT add strongly-connected-component machinery or change how chains are rendered - this task is detection and halting only. Difficulty around 3.

**Why here.** `scripts/checkBlockers.ts` is the first script every `tackle-tasks` invocation runs (see skills/tackle-tasks/SKILL.md, which calls it with `--unblocked` before `getTaskDetails.ts` and `prepareTasks.ts`), so a cycle detected there stops the run before any planning, worktree creation, or implementation cost is paid.

**The gap, confirmed by reading all three call sites.** `openBlockersOf` exists three times with effectively the same body and none of them recurse: `scripts/checkBlockers.ts:15-16` returns the full blockedBy entry objects filtered to open task numbers; `scripts/taskStats.ts:25-26` and `scripts/runStartup.ts:13-14` return just the numbers. Every one resolves exactly one level, so a back edge is indistinguishable from an ordinary dependency.

**Two downstream symptoms this prevents.** (1) Tasks in a cycle report BLOCKED forever with no unblocking path, and `tackle-tasks` refuses to run them without ever explaining why the blocker never clears. (2) Task 108 renders blocker chains by walking backward from sinks - an open task with open blockers that no other open task lists as a blocker. A pure cycle contains no sink, so those tasks are omitted from the chain output entirely while still counting toward `blockedCount`. Task 108 deliberately declined to solve this with strongly-connected-component sink selection (see the Declined review suggestion section in plans/task-108-plan.md); detecting and halting here is the cheaper answer, and this task is that answer.

**Live data checked before filing.** `.taskTools/tasks.json` at commit 28c852c: 36 open tasks, 8 with open blockers (36, 83, 84, 96, 97, 105, 106, 113), zero cycles found by depth-first search. This is a guard against a future bad hand-edit, not a repair of current state - so it must not change the exit code or output of any currently-passing run.

**Scope boundary.** Detection and halting only. Do not add SCC machinery, do not change chain rendering, and do not extract the duplicated `openBlockersOf` into a shared module - that dedup is separately noted in task 108 and task 84 as non-blocking in either direction.

## Files

@scripts/checkBlockers.ts
@tests/checkBlockers.test.ts