---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [BLOCK_NAME_TO_START_FROM]"
allowed-tools: Bash(node *), Bash(node */scripts/tackle-tasks/shared/SkillBodyEmitter.ts*)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/tackle-tasks/shared/SkillBodyEmitter.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
