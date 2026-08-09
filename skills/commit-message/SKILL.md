---
name: commit-message
description: generate a short commit-message summary for each git repo with staged changes, from the diff injected fresh at invocation
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/commitMessageBrief.ts"
```
