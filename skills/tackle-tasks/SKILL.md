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

If a task is still problematic/relevant in the codebase, use the `/make-a-plan` skill to tackle it.  If clarification is needed for the task, use AskUserQuestion to ask the user for more information before beginning working on the task.

If a task is not problematic and was completed successfully, rendering its `tasks.json` entry stale, close it by invoking the `close-tasks` skill with its task number, passing your reasoning that it was completed for the `closureNote`.

If the user requests adding tasks, append them to `tasks.json` following the template at `${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json`, with `taskNumber` = highest number across both `tasks.json` and `completedTasks.json` plus one. Omit completion-related fields.

Don't run any tests or suites.  The user will run tests after you have completed your work.

Finally, if you made any changes to the codebase — which may span multiple git repos or submodules — stage the changes in each affected repo, but do not commit in any of them.
Generate one commit message per repo as defined in **Commit message** below.

## Commit message

Use a single subagent running `Sonnet 5`: give it the staged diff of every affected repo — collected after staging with `git -C <repo> diff --staged -- ':(exclude)tasks.json' ':(exclude)completedTasks.json' ':(exclude)plans/archived'` — and have it generate, per repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
`Repo: <repo name> Message: <summary>`