---
name: review-plan
description: reviews a plan against a target and produces a report that contains flagged issues, efficacy rating, and a list of durable fixes.
argument-hint: <plan file path> <target>
---

If $ARGUMENTS[0] is not already inside this project's `plans/` folder, copy it there
(`cp $ARGUMENTS[0] plans/`) and review the copy — every path below then refers to the copy.

review $ARGUMENTS[0] against !`node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanArgs.ts" --target '$ARGUMENTS'`.

check the plan for gotchas/failures/bugs/incorrect assumptions/errors/false statements/illusions/lies, by reading any file the plan references and any file the plan claims it will change — verify every claim against the source, never against the plan's own account of it.

You may create or modify exactly one file: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanArgs.ts" --amendment '$ARGUMENTS'`. The plan, the codebase, and git state are read-only — do not edit code, do not edit the plan, do not stage, do not commit.

Every flagged issue must carry evidence: a citation listing each repo-relative file path followed by `:` and the line numbers you read, either a single line or an inclusive `start-end` range — as in `[path/to/file.ts:12-40, other/file.ts:8]`, meaning lines 12 through 40 of the first file and line 8 of the second. A command you ran and its output counts as evidence too. An issue you cannot evidence does not go in the report.

If a section of the plan holds up, say so and move on. Do not manufacture issues to fill the report — "no issues found" is a valid and useful result.

Ruling, by the number of durable fixes you list:

- 0 fixes: ship it.
- 1 fix: ship it after incorporating the fix.
- 2-4 fixes: amend the plan with the fixes, then re-review.
- 5+ fixes: the plan needs rewriting.

Efficacy percentage: count the plan's sections, then `(sections - fixes) / sections * 100`, rounded, floored at 0.

amendment format — write !`node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanArgs.ts" --amendment '$ARGUMENTS'` using exactly this template:

```markdown
# Amendment: <plan title>

- Plan reviewed: $ARGUMENTS[0]
- Reviewed against: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanArgs.ts" --target '$ARGUMENTS'`
- Sections: <N> | Fixes: <M>
- Efficacy: <P>%
- Ruling: <the matching ruling from the list above>

## Issues

### 1. <short title>

- Evidence: `[path/to/file.ts:12-40]`
- The plan claims: <quote or close paraphrase>
- Actually true: <what the source shows>

<repeat one block per issue; write "None found." if there are none>

## Durable fixes

### Fix for issue 1

- Change: <the concrete edit to make to the plan>
- Durable because: <why this will not regress the same way>

<repeat one block per issue; omit this section if there are no issues>

## Sections that hold up

- <section name> — verified against `path/file.ts:12-40`
```
