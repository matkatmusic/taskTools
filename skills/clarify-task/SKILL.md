---
name: clarify-task
description: answer the clarifyRequest the planner left on the named open tasks, record the answer on each task, and clear the run's attempt counters so the next run gets fresh clarify rounds
argument-hint: "[N,N,...] <optional answers>"
allowed-tools: Bash(git add *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/clarify-task/clarifyTaskBrief.ts" <<'CLARIFYTASKEOF'
$ARGUMENTS
CLARIFYTASKEOF
```
