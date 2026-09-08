---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/close-tasks/closeTasksBrief.ts" <<'CLOSETASKSEOF'
$ARGUMENTS
CLOSETASKSEOF
```

<!-- retired: moved to /migrate-task-files
## Migration: `files` → `modifiableFiles`

On every close-tasks invocation, unconditionally rename any remaining `files` key to `modifiableFiles` on every task still holding one in the project's tasks.json — not just the tasks being closed this run, and regardless of whether any task actually closes this run. This is bookkeeping-subagent work (see the related-memory note in the brief): if the run closes zero tasks and would otherwise not write tasks.json, still write it when a legacy `files` key is present so the migration happens; do not skip the write just because there is nothing to archive.

Rules, applied per task:
- If a task has `files` and no `modifiableFiles`: rename `files` to `modifiableFiles`. Keep its list exactly as-is. Touch no other key on that task.
- If a task already has `modifiableFiles` and no `files`: leave it untouched.
- If a task has both `files` and `modifiableFiles`: keep `modifiableFiles`, delete `files`. Do not merge the two lists — `modifiableFiles`'s existing value wins as-is.
- If a task has neither key: leave it untouched. Do not add a `readOnlyFiles` key or a `modifiableFiles` key to it. An absent `readOnlyFiles` is meaningful and must stay absent; readers resolve it to `['*']` themselves.
- Never reorder tasks and never renumber a task's `taskNum` (or any other field) while doing this rename.

This is a rename-only pass performed by the bookkeeping subagent. When the run also archives closed tasks, the rename and the archive write happen in the same tasks.json write. When the run closes nothing, the rename still happens in its own write.
-->

