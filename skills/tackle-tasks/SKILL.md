---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/tackleTasksBrief.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
