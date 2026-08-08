---
name: tackle-tasks-v2
description: tackle open tasks using a frozen copy of the pipeline, for runs that rewrite the pipeline itself
argument-hint: "[N,N,...] [valid] [series]"
allowed-tools: Bash(git add *), Bash(node *)
---

<!--
  ponytail: frozen driver for the task 86 chain; delete this skill once 153 lands.
-->

```!
node "/Users/matkatmusicllc/Programming/taskTools-frozen/scripts/tackleTasksBrief.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
