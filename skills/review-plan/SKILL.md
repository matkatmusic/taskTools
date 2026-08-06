---
name: review-plan
description: reviews a plan against a target and produces a report that contains flagged issues, efficacy rating, and a list of durable fixes.
argument-hint: <plan file path> <target>
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanBrief.ts" <<'REVIEWPLANEOF'
$ARGUMENTS
REVIEWPLANEOF
```
