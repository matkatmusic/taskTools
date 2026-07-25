---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: <N...> [valid]
---

- user confirmed valid: !`echo "$ARGUMENTS" | grep -qw valid && echo yes || echo no`
- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" "$ARGUMENTS"`
- task details (unblocked tasks only): !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked "$ARGUMENTS"); [ -n "$u" ] && node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$u" || echo "none of the requested tasks are unblocked"`

First, invoke `/ponytail:ponytail ultra`.

If "user confirmed valid" above is `yes`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.

## Verification

Review the task details above (each object comes from `tasks.json` if the task is open, or `completedTasks.json` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Tackling

Do not work on any task reported as BLOCKED in the "blocked status" above — report its open blockers and move on to the next requested task that is unblocked.

For every task that is still problematic/relevant in the codebase, ALWAYS use the `/make-a-plan` skill to produce a plan — never implement directly without one, even when the task looks trivial — then execute that plan with `/jot:implement <plan file>`.
As soon as the plan exists, ALWAYS create a task list in this session (TaskCreate, one entry per plan step) and keep statuses current (TaskUpdate) as you work, so the user can watch progress.
If clarification is needed for the task, use AskUserQuestion to ask the user for more information before beginning working on the task.

### Parallel tackling

When more than one unblocked, still-relevant task remains, judge from the task details and the code whether they touch disjoint files. Tasks that overlap, or that still need user clarification, are worked serially in this session as described above.

For the disjoint tasks, spawn one subagent per task, all in a single message so they run concurrently. Before spawning, create a task list in this session with one entry per delegated task, and update each entry as its subagent finishes — subagents' own task lists are not visible to the user. Each subagent's prompt must tell it to: invoke `/tackle-tasks <its one task number> valid` (verification already happened above, so pass `valid`); NOT stage anything or generate commit messages; and report back a one-sentence summary of what it changed. After every subagent finishes, staging and the **Commit message** section below run once, in this session — concurrent staging by subagents races git's index lock and would produce per-task instead of per-repo messages.

If a task is not problematic and was completed successfully, rendering its `tasks.json` entry stale, close it by invoking the `close-tasks` skill with its task number, passing your reasoning that it was completed for the `closureNote`.

If the user requests adding tasks, invoke the `create-task` skill once per task — never edit `tasks.json` directly.

Don't run any tests or suites.  The user will run tests after you have completed your work.

## Commit message

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`