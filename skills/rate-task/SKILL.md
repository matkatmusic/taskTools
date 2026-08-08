---
name: rate-task
description: score a task's difficulty and split-worthiness on the 1-10 scale, write both scores back to the task record, and print named split points for /split-task when split-worthiness is 5 or higher. Optional argument: task number(s) to rate. No argument rates every open task.
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/rateTask.ts" $ARGUMENTS
```
