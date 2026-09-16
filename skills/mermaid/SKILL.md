---
name: mermaid
description: scan every tracked TypeScript file in this repo and write one .taskTools/diagrams/<path>.mmd flowchart per file. Takes no argument; run it from the project root.
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/mermaid/mermaid.ts"
```
