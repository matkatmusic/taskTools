---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

- stats: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStats.ts"`

Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
