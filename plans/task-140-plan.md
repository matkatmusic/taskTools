# Task 140 plan: tackle-tasks — keep six task workflows in flight, start the next as any finishes

## Summary

The "Running the pipeline" section of the brief that `tackleTasksBrief.ts`
emits tells the orchestrator to launch every task's `task.workflow.js` as a
background workflow with nothing waiting on anything else — i.e. unbounded
concurrency. Add a concurrency ceiling (sliding window, not fixed batches)
sourced from `TASKS_PER_COMMAND` in `scripts/taskStats.ts`, which is
currently a private (non-exported) constant. Export it, import it into
`tackleTasksBrief.ts`, and interpolate it into the brief text instead of
writing a second `6` literal. Extend the existing test that covers this
section of the brief to assert the new wording is present.

## Edits

### 1. `scripts/taskStats.ts` — export the constant

Line 25, current text:

```
const TASKS_PER_COMMAND = 6;
```

New text:

```
export const TASKS_PER_COMMAND = 6;
```

No other change to this file. This is purely additive (adds an export
keyword to an existing declaration); it changes no behavior of
`computeTaskStats`, `formatTaskStats`, or the CLI entry point at the bottom
of the file.

### 2. `scripts/tackleTasksBrief.ts` — import the constant

Lines 1-3, current text:

```
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
```

New text:

```
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TASKS_PER_COMMAND } from "./taskStats.ts";
```

### 3. `scripts/tackleTasksBrief.ts` — add the concurrency policy to the brief text

Lines 63-65, current text (inside the `## Running the pipeline` section of
the `tackleTasksBrief` template literal):

```
Launch \`${taskWorkflowPath}\` once per entry in \`groups\`, as a **background**
workflow — the call returns immediately, so the orchestrator stays free to
launch the next task's workflow right away. Nothing waits on anything else.
```

New text:

```
Launch \`${taskWorkflowPath}\` once per entry in \`groups\`, as a **background**
workflow — the call returns immediately, so the orchestrator stays free to
launch the next task's workflow right away.

Keep up to ${TASKS_PER_COMMAND} task.workflow.js runs in flight, and start
the next task as soon as any one of them finishes — a sliding window, not
batches of ${TASKS_PER_COMMAND} with a barrier between them. Fewer tasks
than ${TASKS_PER_COMMAND} means fewer runs; ${TASKS_PER_COMMAND} is a
ceiling, never a batch size to fill.
```

(The backslash-escaped backticks above are how the text is written inside
the outer template literal in the source file — copy it exactly as it
appears when editing, i.e. with `\`` before `${taskWorkflowPath}` etc., same
as the surrounding lines already in the file.)

Nothing else in `scripts/tackleTasksBrief.ts` changes. The existing
`Launch \`${taskWorkflowPath}\` once per entry in \`groups\`, as a
**background**` sentence is preserved verbatim (required by an existing test
regex), only the trailing "Nothing waits on anything else." sentence is
replaced by the new paragraph.

### 4. `tests/tackleTasksBrief.test.ts` — import the constant

Line 5, current text:

```
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";
```

New text:

```
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";
import { TASKS_PER_COMMAND } from "../scripts/taskStats.ts";
```

### 5. `tests/tackleTasksBrief.test.ts` — assert the concurrency wording

Lines 36-45, current text:

```
test("running the pipeline launches task.workflow.js once per task in the background, with no phase barriers", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /Launch `.*task\.workflow\.js` once per entry in `groups`, as a \*\*background\*\*/);
  assert.match(brief, /Args for each launch: `\{task, typecheckCommand\}`/);
  assert.match(brief, /task-notification back to you/);
  assert.doesNotMatch(brief, /wait for each to finish before starting/);
  assert.doesNotMatch(brief, /stepOutputsFile/);
  assert.doesNotMatch(brief, /mergeCommand/);
  assert.doesNotMatch(brief, /Step 1 — plan/);
});
```

New text:

```
test("running the pipeline launches task.workflow.js once per task in the background, with no phase barriers", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /Launch `.*task\.workflow\.js` once per entry in `groups`, as a \*\*background\*\*/);
  assert.match(brief, /Args for each launch: `\{task, typecheckCommand\}`/);
  assert.match(brief, /task-notification back to you/);
  assert.doesNotMatch(brief, /wait for each to finish before starting/);
  assert.doesNotMatch(brief, /stepOutputsFile/);
  assert.doesNotMatch(brief, /mergeCommand/);
  assert.doesNotMatch(brief, /Step 1 — plan/);
  assert.match(brief, new RegExp(`Keep up to ${TASKS_PER_COMMAND} task\\.workflow\\.js runs in flight`));
  assert.match(brief, /sliding window, not\s+batches of/);
});
```

No other test in this file changes. Tests 1-4 are unaffected: the edited
paragraph lives in the "Running the pipeline" section, which sits after the
`${seriesSection(argsValue)}` insertion point, so the series-mode
byte-diffing test (test 3) still produces identical parallel/serial text
modulo the `" series"` substring and the `## Serial mode` block, exactly as
before.

## Why this satisfies the goal

- Concurrency ceiling is expressed in the brief text as `${TASKS_PER_COMMAND}`
  (interpolated from the imported constant), never a second hardcoded `6`.
- The wording states a ceiling ("up to N... fewer tasks than N means fewer
  runs"), not a batch size to fill, and explicitly says "start the next task
  as soon as any one of them finishes... a sliding window, not batches... with
  a barrier between them" — matching the goal's sliding-window requirement
  and explicitly ruling out barrier-batches.
- `TASKS_PER_COMMAND` remains defined once, in `scripts/taskStats.ts`; the
  only change there is exporting it.

## Verification

Run the owned test file directly with Node's built-in test runner:

```
cd /Users/matkatmusicllc/Programming/taskTools-86 && node --test tests/tackleTasksBrief.test.ts
```

Expected output: 5 tests, all passing —

```
✔ brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder
✔ script reads arguments from stdin and embeds the live checkBlockers.ts output
✔ series adds the serial-mode section and leaves the brief untouched without it
✔ script fails loudly rather than emitting a brief that points nowhere
✔ running the pipeline launches task.workflow.js once per task in the background, with no phase barriers
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

(This was confirmed as the current baseline output — pre-edit — by running
the same command before writing this plan; all 5 tests already pass today,
and the plan adds 2 assertions inside the 5th test rather than a 6th test,
so the count stays at 5.)

As a manual spot-check, confirm the brief text contains the new paragraph
with the live value substituted:

```
cd /Users/matkatmusicllc/Programming/taskTools-86 && node -e "
import('./scripts/tackleTasksBrief.ts').then(({tackleTasksBrief}) => {
  const brief = tackleTasksBrief('[1]', 'task 1: unblocked');
  console.log(brief.includes('Keep up to 6 task.workflow.js runs in flight'));
  console.log(brief.includes('sliding window, not'));
});
"
```

Expected output: two lines, both `true`.
