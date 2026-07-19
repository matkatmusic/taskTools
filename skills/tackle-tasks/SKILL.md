---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: <N...>
---

First, invoke `/ponytail:ponytail ultra`. 

Then:

- task details: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" $ARGUMENTS`

Review the task details above (each object comes from `tasks.json` if the task is open, or `completedTasks.json` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the tasks named in $ARGUMENTS.

If a task is still problematic/relevant in the codebase, use the `/make-a-plan` skill to tackle it.  If clarification is needed for the task, use AskUserQuestion to ask the user for more information before beginning.

If a task is not problematic and its `tasks.json` entry is therefore stale, mark it complete: move its object from `tasks.json` to `completedTasks.json`, adding a `completionDate`, `commitHashes` (verified against git history, when the resolving commits can be identified), and a short `closureNote` summarizing the reasoning for marking it complete.

If the user requests adding tasks, append them to `tasks.json` as objects in the same format: `taskNumber` = highest number across both `tasks.json` and `completedTasks.json` plus one, `title`, and a `description` capturing the user's wording (plus repro URLs/file paths if given). Omit completion-related fields.

Don't run any tests or suites.  The user will run tests after you have completed your work.

Finally, If you make any changes to the codebase, stage the changes but do not commit. use a subagent running `Sonnet 5` to generate a short (40 words or less) single-sentence summary of the work done, and show that summary to the user, so the user can use it as a commit message.
