---
name: pick-a-task
description: read the open tasks in tasks.json, compare each against the current state of the project, pick the N easiest/simplest ones (default 1), and report why in under 70 words each. Optional argument N = how many tasks to return.
---

Number of tasks to pick: $ARGUMENTS (default 1 if blank or not a number).

Open tasks: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN`

Compare each open task above against the current state of the project — pull full details with `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` where a title alone isn't enough, and check the relevant code/files to judge scope (already partly done? one-file change? decision-only?).

Exclude any task whose `blockedBy` lists a task number that is still open — it is not eligible regardless of ease.

Pick the N easiest/simplest open tasks, ordered easiest first. Report to the user: each task's number, title, and why it is that easy — under 70 words per task. Do not start implementing any of them.
