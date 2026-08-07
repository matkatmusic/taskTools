---
name: pick-a-task
description: read the open tasks in tasks.json, filter to unblocked, sort by difficulty (1=easiest, 10=hardest), and pick the N lowest-difficulty ones that are still relevant to the current codebase. Report why in under 15 words each. Optional argument N = how many tasks to return.
---

Number of tasks to pick: $ARGUMENTS (default 1 if blank or not a number).

Open tasks: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN`

Blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts"`

Exclude any task reported as BLOCKED in the "Blocked status" above — it is not eligible regardless of difficulty.

For every remaining (non-blocked) open task number, pull its full record in one call — `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` with all the numbers passed at once — and read each record's `difficulty` field (1 = typo, comment, or constant edit with no behavior change; 2 = one-line or single-file mechanical change; 3 = one file edited alongside an existing test that already covers it; 4 = contained change to one file plus its test; 5 = a few files in one subsystem, mostly mechanical; 6 = several files in one subsystem, design already settled; 7 = one subsystem plus the callers it forces to change; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with the design still unsettled; 10 = wide blast radius, unclear scope, or a previously reverted attempt).

Sort the remaining open tasks by difficulty ascending; break ties by task number ascending. This ordering replaces reasoning about scope; do not re-derive ease from reading the task body.

Starting from the lowest difficulty, for each candidate check the one thing difficulty can't tell you: is it still relevant given the current state of the code? Using the full record already pulled above, check the files listed in its `files` field — has this already been done, or does the premise no longer hold? Skip irrelevant candidates and continue down the sorted list.

Stop once you have N relevant tasks, or the sorted list is exhausted. Report to the user: each task's number, title, difficulty, and a one-line relevance note — under 15 words per task. Do not start implementing any of them.

If fewer than N tasks qualify, report the ones that do and add the line `Only <count> eligible relevant task(s) found.`, then end with the closing lines below using those task numbers. If no task qualifies, report `No eligible relevant tasks found.` and omit the closing lines — there are no task numbers to put in them.

Otherwise end your report with exactly:
`start a session with: 'claude --name "task <N...>"'`
`prompt: "/tackle-tasks [<N,...>] valid"`
where `<N...>` is the chosen task numbers space-separated, and `[<N,...>]` is the same numbers as a JSON array with no spaces (`[268,270]`) — the argument form tackle-tasks and close-tasks require.
