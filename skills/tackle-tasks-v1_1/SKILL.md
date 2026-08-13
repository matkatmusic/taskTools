---
name: tackle-tasks-v1_1
description: frozen v1.1 pipeline, kept runnable while tackle-tasks is rebuilt from plans/diagram/pipeline.mmd
argument-hint: "[N,N,...] [valid] [series]"
allowed-tools: Bash(git add *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
