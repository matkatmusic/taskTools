# Task 64: Give close-tasks a script to move tasks between tasks.json and completedTasks.json

## User request

the close-tasks tool should use a script to remove entries from tasks.json, not the Edit() tool. same for adding the completed task to completedTasks.json.

skills/close-tasks/SKILL.md currently tells the agent to "move its object from tasks.json to completedTasks.json" in prose, with no script named, so the agent hand-edits both JSON files with the Edit tool. Hand-editing risks malformed JSON, dropped or reordered sibling entries, and inconsistent field shapes across closures.

The merge path already solves the same problem programmatically: scripts/taskArchival.ts exports archivePublishedTasks(), which reads both files via readTaskFile/resolveTaskFiles from scripts/taskFiles.ts, splices the task out of tasks.json, pushes it onto completedTasks with completionDate and commitHashes, and writes both back with JSON.stringify(..., null, 2) + "\n". It is not reusable for manual closure: it derives which tasks to archive from TaskMergeResult.fullyPublished, and it never writes a closureNote.

Add a new scripts/closeTasks.ts (the user chose a separate file over extending taskArchival.ts) exporting a closeTasks() function plus a CLI entry point the SKILL.md can invoke as `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts" '[64,65]' '<closureNote>'`, matching the no-space-JSON-array argument convention already used by getTaskDetails.ts and unblockDependents.ts. It must accept per-task closure notes and commit hashes, write completionDate as today in YYYY-MM-DD, preserve the order of the remaining tasks, skip task numbers that are already in completedTasks.json or absent from both, and report what it closed and what it skipped. Reuse readTaskFile and resolveTaskFiles from scripts/taskFiles.ts rather than reimplementing file resolution.

Then edit skills/close-tasks/SKILL.md to invoke that script instead of describing the move in prose, and widen its allowed-tools front-matter (currently only `Bash(git add *)`) so the script may run.

### scripts/closeTasks.ts

(missing: file not found on disk)

### skills/close-tasks/SKILL.md

```
---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *)
---

- tasks to close: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — and everything after them is free-text reasoning. The script reads the whole argument string and stops at the first token that is not part of the array, so the reasoning is ignored by it. Avoid apostrophes and backticks in that reasoning; it reaches the shell inside single quotes. If the details above don't cover every task number named in `$ARGUMENTS` — a full listing instead, or only the first few — the invoker skipped the array form or put spaces in it: re-run the script yourself with all the numbers before continuing.

`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Close every listed OPEN task in a single pass: move its object from `tasks.json` to `completedTasks.json`, adding a `completionDate` (today), `commitHashes` (search git history for the resolving commits; use an empty array if none can be identified), and a short `closureNote` — one sentence per task, using the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none.

Skip tasks already COMPLETED or not found, and say so.

Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.

Stage the changes but do not commit. Provide a short commit message to the user, similar to "Closed tasks [268,270,281]" or "Closed task [268]", naming the numbers you actually closed.

If a spec document references these task numbers, mark those items done in the spec.

```

### tests/closeTasks.test.ts

(missing: file not found on disk)
