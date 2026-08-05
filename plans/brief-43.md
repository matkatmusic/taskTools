# Task 43: Rewrite pick-a-task's selection criteria to use the difficulty field

Revisit how pick-a-task chooses tasks once the `difficulty` field is supported on tasks.json entries.

Today skills/pick-a-task/SKILL.md picks the N easiest open tasks by having the agent read every task and reason in prose about which are simplest, comparing each against the current state of the project. Once each task carries a difficulty rating (1-5), most of that reasoning becomes a sort: filter to unblocked, order by difficulty ascending, take N.

Rewrite the picking criteria to use the field, and decide what judgment is still worth spending prose on. The remaining candidate is the relevance check — is this task still needed given the current codebase? — which is separate from difficulty and cannot be sorted.

Blocked by the task that adds the difficulty field to tasks.json entries and to skills/create-task/template/taskTemplate.json; that task does not exist yet, so add its number to blockedBy once it is created.

### skills/pick-a-task/SKILL.md

```
---
name: pick-a-task
description: read the open tasks in tasks.json, compare each against the current state of the project, pick the N easiest/simplest ones (default 1), and report why in under 70 words each. Optional argument N = how many tasks to return.
---

Number of tasks to pick: $ARGUMENTS (default 1 if blank or not a number).

Open tasks: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN`

Blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts"`

Compare each open task above against the current state of the project — pull full details with `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` where a title alone isn't enough, and check the relevant code/files to judge scope (already partly done? one-file change? decision-only?).

Exclude any task reported as BLOCKED in the "Blocked status" above — it is not eligible regardless of ease.

Pick the N easiest/simplest open tasks, ordered easiest first. Report to the user: each task's number, title, and why it is that easy — under 15 words per task. Do not start implementing any of them.

End your report with exactly:
`start a session with: 'claude --name "task <N...>"'`
`prompt: "/tackle-tasks [<N,...>] valid"`
where `<N...>` is the chosen task numbers space-separated, and `[<N,...>]` is the same numbers as a JSON array with no spaces (`[268,270]`) — the argument form tackle-tasks and close-tasks require.
```
