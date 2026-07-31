---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *)
---

- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS[0]'`
- task details (unblocked tasks only): !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS[0]'); [ -n "$u" ] && node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$u" || echo "none of the requested tasks are unblocked"`

Invocation format: the first argument is a JSON array of the task numbers with **no spaces** — `[268,270,281]` — optionally followed by `valid` and any free text. Only that first argument reaches the shell, so quotes, backticks and apostrophes in the text are harmless. If the two blocks above cover fewer tasks than `$ARGUMENTS` names, the invoker skipped the array form: re-run both scripts yourself with all the numbers before continuing.

First, invoke `/ponytail:ponytail ultra`.

When `$ARGUMENTS` contains the word `valid`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.

## Verification

Review the task details above (each object comes from `tasks.json` if the task is open, or `completedTasks.json` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Tackling

Do not work on any task reported as BLOCKED in the "blocked status" above — report its open blockers and move on to the next requested task that is unblocked.

### Plan phase — all tasks, up front

For every task that is still problematic/relevant in the codebase, ALWAYS produce a plan first — never implement directly without one, even when the task looks trivial. If a task needs clarification, use AskUserQuestion now, before any planning or fan-out.

Invoke `/make-a-plan plan <task description>` once per task, serially in this session, before implementing anything. The `plan` mode argument is REQUIRED: it stops that skill after the plan file is written, because THIS skill owns implementation. Each plan file doubles as a prescriptive brief for the execute phase — a worker must be able to implement it without making design decisions.

As soon as the plans exist, create a task list in this session (TaskCreate, one entry per task) and keep statuses current (TaskUpdate) as work completes, so the user can watch progress.

### Execute phase

Judge from the plans whether the tasks touch disjoint files.

When two or more tasks touch disjoint files, fan them out with the Workflow tool using the template shipped with this skill:

    Workflow({
      scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/tackle-tasks.workflow.js",
      args: {
        repo: "<absolute repo path>",
        typecheckCmd: "<the project's typecheck command>",
        tasks: [{ number: <task #>, planFile: "<absolute plan file path>", files: ["<owned file>", ...] }]
      }
    })

Each worker implements its plan file exactly, runs typecheck only, never stages or commits, and returns a structured status; partial workers get one requeue pass and the run ends with a whole-repo typecheck. Update the session task list from the returned `{done, partial, blocked}` and finish any leftovers serially.

Tasks that overlap, are design-heavy, or stand alone are executed serially in this session with `/jot:implement <plan file>`.

After all execution finishes, staging and the **Commit message** section below run once, in this session — workers never touch the git index, so nothing races it.

**ONLY AFTER** the user verifies that all tasks are completed successfully, invoke the `close-tasks` skill once for all of them, as described below.  DO NOT close any tasks until the user has approved them. 

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its `tasks.json` entry stale, with **one** invocation of the `close-tasks` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — `[268,270,281]` — followed by your reasoning for the `closureNote`s, naming each task (`#268 …, #270 …`) when the reasons differ.

If the user requests adding tasks, invoke the `create-task` skill once per task — never edit `tasks.json` directly.

During implementation, run typecheck only — no test suites or visual checks, by you or by workers. Full verification (typecheck + full suite + the repo's UI verification where relevant) runs once inside `close-tasks`, after the user approves closing.

## Commit message

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`
