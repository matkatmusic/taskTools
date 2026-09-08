---
name: create-task
description: the ONLY way to add a task to tasks.json. ALWAYS invoke this skill whenever any task is being added — whether it comes from the user, from another skill, or from your own work — never edit tasks.json directly. Use discernment — if $ARGUMENTS explains the task well enough, write it directly; if not, refine it with AskUserQuestion (or /grill-me for direction-setting tasks) first.
argument-hint: "<task description>"
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-task/create-task_SkillBodyEmitter.ts" <<'CREATETASKEOF'
$ARGUMENTS
CREATETASKEOF
```
