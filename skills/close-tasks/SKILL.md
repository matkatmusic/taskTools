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
