---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasksBrief.ts" <<'CLOSETASKSEOF'
$ARGUMENTS
CLOSETASKSEOF
```

## Migration: `files` → `modifiableFiles` — DISABLED, DO NOT PERFORM

**Do not perform this migration.** Its rules are written and correct, but the reader half of this
change never shipped: `declaredFiles` in `scripts/taskGroups.ts` reads `task.files` only, and no
script in `scripts/` accepts `modifiableFiles`. Performing this rename today makes every task's
file list read as empty and silently blinds grouping, planning and split-task. Task 98's own
description says the two halves must ship together or a half-migrated tasks.json breaks.

The full migration rules are preserved verbatim in commit `3be16f7`. Restore them from there,
replacing this whole section, only once a reader accepts `modifiableFiles` with a fallback to
`files`. Until then, close-tasks must not touch the `files` key on any task.
