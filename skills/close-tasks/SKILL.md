---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
---

- tasks to close: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — and everything after them is free-text reasoning. The script reads the whole argument string and stops at the first token that is not part of the array, so the reasoning is ignored by it. Avoid apostrophes and backticks in that reasoning; it reaches the shell inside single quotes. If the details above don't cover every task number named in `$ARGUMENTS` — a full listing instead, or only the first few — the invoker skipped the array form or put spaces in it: re-run the script yourself with all the numbers before continuing.

`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Before closing, search git history for the commit(s) that resolved each task; use an empty array for a task only if none can be identified. Close every listed OPEN task in exactly one invocation of `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts" '[N,N,...]' '<note>' '<hashes>'` — never split the batch across calls: the first argument is every listed task number as one no-space JSON array. The second argument is either one sentence of closure reasoning shared by every task number in that array, or — when tasks in the same call need different reasoning — a no-space JSON object mapping each task number to its own sentence, e.g. `{"64":"fixed by abc123","65":"verified by user"}`; use the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none. The third argument is optional and follows the same shared-vs-per-task shape for the commit hashes found above: a no-space JSON array shared by every task in the call, e.g. `["abc123"]`, or a no-space JSON object mapping each task number to its own array, e.g. `{"64":["abc123"],"65":[]}`; omit this argument (or pass `[]`) only when no task in the call has any commits to record. Use the shared string/array forms only when every task in the batch has identical reasoning and hashes; otherwise use the per-task JSON object forms. Either way it is one call. The script writes today's date as `completionDate` and the resolved `closureNote`/`commitHashes` onto each closed task's record, splices it out of `tasks.json`, appends it to `completedTasks.json`, and reports which numbers it closed and which it skipped (already COMPLETED or not found in either file) — relay the skipped ones to the user.

Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.

Stage the changes but do not commit. Provide a short commit message to the user, similar to "Closed tasks [268,270,281]" or "Closed task [268]", naming the numbers you actually closed.

If a spec document references these task numbers, mark those items done in the spec.
