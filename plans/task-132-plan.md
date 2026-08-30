# Task 132 plan — create `skills/tackle-tasks/task.workflow.js` (stage dispatcher shell)

## Scope recap

Split of task 123, step 2 of 3. Build only the dispatcher shell for the new
one-workflow-per-task file described in `plans/task-86-spec.md`:

- a `stage` launch argument selecting `plan` / `implement` / `rebase-test` /
  `merge`, defaulting to `plan+implement` when unset;
- `meta.name` is `task-<N>`;
- phase titles carry the task number (`<N> Plan`, `<N> Implement`, ...) so six
  concurrent runs stay distinguishable in `/workflows`;
- stage bodies are stubs that log and return; nothing calls an agent yet.

`skills/tackle-tasks/plan.workflow.js` is read-only reference material here —
step 3 of the split moves its planner code across and deletes it, not this
task.

## Owned files — edit plan

### `skills/tackle-tasks/task.workflow.js` — CREATE (does not exist on disk)

Create the file with exactly this content:

```js
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'

export const meta = {
  name: `task-${N}`,
  description: 'Run one task through its stage pipeline (plan / implement / rebase-test / merge)',
  phases: [
    { title: `${N} Plan`, detail: 'write and refine the task plan' },
    { title: `${N} Implement`, detail: 'implement the plan and check the file fence' },
    { title: `${N} Rebase-Test`, detail: 'rebase onto source and run the full suite' },
    { title: `${N} Merge`, detail: 'merge and close the task' },
  ],
}

const runPlan = () => {
  log(`task ${N}: plan stage (stub)`)
  return { stage: 'plan', task: N }
}

const runImplement = () => {
  log(`task ${N}: implement stage (stub)`)
  return { stage: 'implement', task: N }
}

const runRebaseTest = () => {
  log(`task ${N}: rebase-test stage (stub)`)
  return { stage: 'rebase-test', task: N }
}

const runMerge = () => {
  log(`task ${N}: merge stage (stub)`)
  return { stage: 'merge', task: N }
}

const STAGE_RUNNERS = {
  plan: () => [runPlan()],
  implement: () => [runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': () => [runPlan(), runImplement()],
}

const runner = STAGE_RUNNERS[STAGE]
if (!runner) throw new Error(`task.workflow.js: unknown stage "${STAGE}"`)

return { task: N, stage: STAGE, results: runner() }
```

Design notes fixing every choice ahead of implementation (no discovery left
for the implementer):

- **Launch-argument shape.** `task.workflow.js` does not exist yet and
  nothing in the two other owned files calls it, so its `args` contract is
  this task's own design surface, not something to reverse-engineer. It
  mirrors the proven `args` pattern already live in
  `skills/tackle-tasks/plan.workflow.js` line 225
  (`const ARGS = typeof args === 'string' ? JSON.parse(args) : args`), adding
  two keys: `task` (the task number, matching the `task` field name used in
  `plan.workflow.js`'s own `PLAN_SCHEMA` at lines 232 and 286) and `stage`
  (the stage selector named directly after the four stage names in
  `plans/task-86-spec.md`'s stage table, lines 61–66).
- **Default stage value.** `plans/task-86-spec.md` line 68: "Default (no
  stage) runs `plan` + `implement` and stops." — encoded as the `??
  'plan+implement'` fallback and the `'plan+implement'` entry in
  `STAGE_RUNNERS` that runs both stubs in task-number order.
- **Stage key strings.** Taken verbatim from the left column of the stage
  table in `plans/task-86-spec.md` lines 61–66: `plan`, `implement`,
  `rebase-test`, `merge`.
- **Unknown-stage handling.** Throws, since an unrecognized `stage` value is
  a caller bug, not a runtime condition the stub needs to route around
  (nothing downstream reads a partial dispatch result).
- **Phase title format.** `plans/task-86-spec.md` line 161 gives two worked
  examples verbatim — `86 Plan`, `86 Implement` — i.e. `${N} <Title>` with no
  extra punctuation. Extended identically to the other two stages:
  `${N} Rebase-Test`, `${N} Merge` (hyphenated to match the `rebase-test`
  stage key).
- **`meta.name`.** Task description (brief, split-task body): "The
  workflow's `meta.name` is `task-<N>`." — `` `task-${N}` ``.
- **No agent/parallel calls.** Task description: "Stage bodies are stubs
  that log and return; nothing calls an agent yet." Each stub calls only
  `log(...)` and returns a small stage/task object; `agent` and `parallel`
  (available globals per the `plan.workflow.js` precedent) are unused,
  matching "nothing calls an agent yet."

### `plans/task-86-spec.md` — no edit

Read-only design reference for this task. Nothing in the split-task
description or `plans/task-86-spec.md` itself asks this task to modify the
spec. No edit.

### `skills/tackle-tasks/plan.workflow.js` — no edit

Split-task description, brief line: "The existing
`skills/tackle-tasks/plan.workflow.js` stays untouched here — step 3 moves
its planner code across and deletes it. This task and step 3 both edit
`task.workflow.js`, so they are chained: this one must land first." No edit
in this task.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`.

### 1. File exists and is new

```
git status --porcelain -- skills/tackle-tasks/task.workflow.js
```
Expected: `?? skills/tackle-tasks/task.workflow.js` (untracked new file).

### 2. The two reference files are untouched

```
git diff --stat -- plans/task-86-spec.md skills/tackle-tasks/plan.workflow.js
```
Expected: empty output (no changes).

### 3. Syntax and runtime behavior of the dispatcher

The file mixes a top-level `export` with a top-level `return`, the same
hybrid shape already used by the live `skills/tackle-tasks/plan.workflow.js`
(its own top-level `return { plans, ... }` at the end). This check proves the
body parses and behaves correctly by loading it the same way that shape
implies: strip the `export` keyword and evaluate the remainder as an
`AsyncFunction` body.

```bash
node -e '
const fs = require("fs");
const path = "skills/tackle-tasks/task.workflow.js";
const raw = fs.readFileSync(path, "utf8");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const body = raw
  .replace("export const meta", "const meta")
  .replace(
    "return { task: N, stage: STAGE, results: runner() }",
    "return { meta, task: N, stage: STAGE, results: runner() }"
  );
const fn = new AsyncFunction("args", "log", "agent", "parallel", body);
const noop = () => {};

(async () => {
  const r1 = await fn(JSON.stringify({ task: 86 }), noop, noop, noop);
  console.log("default:", r1.stage, r1.results.length, r1.meta.name);
  console.log("phases:", r1.meta.phases.map(p => p.title).join(" | "));

  const r2 = await fn({ task: 86, stage: "merge" }, noop, noop, noop);
  console.log("merge:", r2.stage, r2.results.length);

  try {
    await fn({ task: 86, stage: "bogus" }, noop, noop, noop);
    console.log("ERROR: expected throw");
  } catch (e) {
    console.log("bogus threw:", e.message);
  }
})();
'
```

Expected output:

```
default: plan+implement 2 task-86
phases: 86 Plan | 86 Implement | 86 Rebase-Test | 86 Merge
merge: merge 1
bogus threw: task.workflow.js: unknown stage "bogus"
```

This confirms: the file parses; `args` accepted as either a JSON string or a
plain object; default stage runs both `plan` and `implement` stubs in order;
`meta.name` is `task-86`; all four phase titles carry the task number in the
`86 Plan` / `86 Implement` / `86 Rebase-Test` / `86 Merge` form; an explicit
`stage` (`merge`) runs only that stub; an unrecognized stage throws with a
message naming the bad value.
