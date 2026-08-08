---
name: update-task-files
description: backfill the `files` array on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no files, or when auditing tasks created before the field existed.
argument-hint: "[N,N,...]"
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/updateTaskFilesBrief.ts" <<'UPDATETASKFILESEOF'
$ARGUMENTS
UPDATETASKFILESEOF
```
