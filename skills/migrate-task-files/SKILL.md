---
name: migrate-task-files
description: renames the legacy `files` key to `modifiableFiles` in a project's tasks.json
argument-hint: <absolute tasks.json path>
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-task-files/migrateTaskFiles.ts" $ARGUMENTS
```
