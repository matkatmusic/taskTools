---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: <N...>
---

- task details: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$ARGUMENTS"`

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. For each OPEN task above: move its object from `tasks.json` to `completedTasks.json`, adding a `completionDate` (today), `commitHashes` (search git history for the resolving commits; use an empty array if none can be identified), and a short `closureNote` (one sentence stating why it was closed — the invoker's reasoning if given, otherwise "closed manually by user").

Skip tasks already COMPLETED or not found, and say so.

Then unblock dependents by running: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" <closed task numbers>` — it removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.

Stage the changes but do not commit.   Provide a short commit message to the user, similar to "Closed tasks #<task numbers>" or "Closed task <#task number>".

If a spec document references these task numbers, mark those items done in the spec.