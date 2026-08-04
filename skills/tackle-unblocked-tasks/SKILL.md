---
name: tackle-unblocked-tasks
description: tackle every open task in tasks.json whose blockedBy array is empty, in ascending task-number order
---
- `$tasks`: !``
- `$unblockedTaskNumbers`: !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$tasks'); [ -n "$u" ] && echo "[$(echo $u | tr ' ' '\n' | sort -n | paste -sd, -)]" || echo "none"`

If the line above says `none`, report that every open task is blocked and stop.

otherwise:
Invoke the `tackle-tasks $unblockedTaskNumbers valid` skill.
example: `[30,32,35] valid`. 
Pass it verbatim; do not re-derive or filter it.

