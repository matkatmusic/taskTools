---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...]"
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/tackle-tasks/shared/SkillBodyEmitter.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
