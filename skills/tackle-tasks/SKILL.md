---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid] [series]"
allowed-tools: Bash(git add *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/tackle-tasks_SkillBodyEmitter.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
