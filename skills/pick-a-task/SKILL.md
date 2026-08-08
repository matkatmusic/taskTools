---
name: pick-a-task
description: read the open tasks in tasks.json, filter to unblocked, sort by difficulty (1=easiest, 10=hardest), and pick the N lowest-difficulty ones that are still relevant to the current codebase. Report why in under 15 words each. Optional argument N = how many tasks to return.
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/pickATaskBrief.ts" <<'PICKATASKEOF'
$ARGUMENTS
PICKATASKEOF
```
