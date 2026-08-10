# Task 173: Route addTaskFiles writes through the hash-guarded protocol so concurrent planners cannot clobber each other (audit C86-08)

## User request

`addTaskFiles` is unsafe under the newly introduced planning concurrency. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-07.

This is finding C86-08 (HIGH) in plans/task-86-codex-audit.md.

Up to six workflows may widen task ownership concurrently, but addTaskFiles performs unlocked whole-file read/modify/write operations on BOTH tasks.json and run-arguments.json (scripts/addTaskFiles.ts:41-51 and :64-76). runAsCli does an unlocked read / JSON.parse / mutate / writeFileSync on tasks.json, then a separate unlocked read-modify-write on run-arguments.json in refreshRunArgumentsSnapshot. Two planners can read the same bytes and the last writer silently erases the first planner's additions.

There is also a close/widen race: a planner can read [A, B], task A can close atomically to [B], and the planner can then write its stale [A, B] snapshot, resurrecting an already completed task. The guarded writer in closeTasks cannot protect against this unguarded writer.

The primitive already exists and is not being used: scripts/closeTasks.ts exports hashGuardedRewrite -- a retry-on-hash-mismatch read / mutate / write-tmp / rename compare-and-swap, this project's existing protocol for tasks.json. addTaskFiles.ts neither imports nor uses it. Route both writes through that same protocol so widen/widen and widen/close races retry onto fresh bytes instead of clobbering.

AUTHORITATIVE-TARGET REQUIREMENT, settled with the user: the widening must land in the authoritative SOURCE tasks.json and run-arguments.json even when the planner runs inside its own private worktree. The audit flags this explicitly -- fixing C86-01 (task 166) by merely running inside the private worktree would introduce a second failure, because the private checkout has its own tasks.json while the authoritative source snapshot and source-created run-arguments.json would never receive the widening.

tests/addTaskFiles.test.ts today covers only single-writer behaviour, driving the CLI with execFileSync against a temporary .taskTools directory. It needs adversarial concurrent-writer coverage.

## Files

@scripts/addTaskFiles.ts
@scripts/closeTasks.ts
@tests/addTaskFiles.test.ts
@skills/tackle-tasks/task.workflow.js

## CONFIRMED BLOCKER FROM A PRIOR ATTEMPT — YOUR PLAN MUST SOLVE THIS

A previous plan for this task was approved by codex and then REJECTED by the implementer,
because the plan assumed something false. Do not repeat the mistake. The verified findings:

1. `resolveTaskFiles()` (scripts/taskFiles.ts) and `resolveRunArgumentsPath()`
   (scripts/prepareTasks.ts) resolve paths by walking up from `process.cwd()`. There is NO
   authoritative-root mechanism anywhere in scripts/ — no TASKTOOLS_ROOT, no git-common-dir
   lookup, no env var.
2. In production the widen call runs with cwd set to the PRIVATE per-task worktree:
   skills/tackle-tasks/task.workflow.js lines 337 and 382 call
   `execFileSync('node', ['scripts/addTaskFiles.ts', ...], { cwd: preparedTask.repoRoot })`
   where `repoRoot = WORKTREE`.
3. That worktree holds its own independent, non-symlinked `.taskTools/tasks.json`. So the
   widening lands in the WRONG file and the authoritative source never receives it.
4. The repo's own established convention for reaching the authoritative source is to pass
   `mainRepoRoot` (= `rootOccurrence.checkoutPath`) explicitly — exactly what
   task.workflow.js lines 698 and 709 already do when calling `closeTasks()` at merge time.
   `closeTasks()` already has a `projectRoot` parameter. `addTaskFiles.ts` has no equivalent.

Therefore the plan MUST:
- give `addTaskFiles.ts` an explicit authoritative-root argument, mirroring `closeTasks()`'s
  existing `projectRoot` parameter, instead of always deriving the root from `process.cwd()`;
- update the widen call site in skills/tackle-tasks/task.workflow.js to pass the authoritative
  main repo root rather than the private worktree path;
- keep backward compatibility for the existing CLI callers and tests that pass no root.

Also fix, per codex: the close/widen race test must FORCE the dangerous read-close-write
interleaving. Merely starting two processes at the same time and hoping they race can pass
against the old unfixed code, which makes it no regression test at all.