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

For every task that is still problematic/relevant in the codebase, ALWAYS produce a plan first — never implement directly without one, even when the task looks trivial.

Invoke it as `/make-a-plan plan <task description>`. The `plan` mode argument is REQUIRED: it stops that skill after the plan file is written, because THIS skill owns implementation. Invoking it as `plan+implement` would hand the work to a subagent and skip the task list below.

Then execute that plan yourself with `/jot:implement <plan file>`.
As soon as the plan exists, ALWAYS create a task list in this session (TaskCreate, one entry per plan step) and keep statuses current (TaskUpdate) as you work, so the user can watch progress.
If clarification is needed for the task, use AskUserQuestion to ask the user for more information before beginning working on the task.

### Parallel tackling

When more than one unblocked, still-relevant task remains, judge from the task details and the code whether they touch disjoint files. Tasks that overlap, or that still need user clarification, are worked serially in this session as described above.  

For the disjoint tasks, spawn one subagent per task, all in a single message so they run concurrently.  
Parallelize by file ownership instead of by task to prevent multiple agents writing to the same file at the same time. 
Before spawning, create a task list in this session with one entry per delegated task, and update each entry as its subagent finishes — subagents' own task lists are not visible to the user. 
Each subagent's prompt must tell it to: 
- invoke `/tackle-tasks [<its one task number>] valid` (verification already happened above, so pass `valid`); 
- NOT stage anything or generate commit messages; 
- and report back a one-sentence summary of what it changed. 

After every subagent finishes, staging and the **Commit message** section below run once, in this session — concurrent staging by subagents races git's index lock and would produce per-task instead of per-repo messages.

**ONLY AFTER** the user verifies that all tasks are completed successfully, invoke the `close-tasks` skill once for all of them, as described below.  DO NOT close any tasks until the user has approved them. 

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its `tasks.json` entry stale, with **one** invocation of the `close-tasks` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — `[268,270,281]` — followed by your reasoning for the `closureNote`s, naming each task (`#268 …, #270 …`) when the reasons differ.

If the user requests adding tasks, invoke the `create-task` skill once per task — never edit `tasks.json` directly.

Don't run any tests or suites.  The user will run tests after you have completed your work.

## Commit message

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`