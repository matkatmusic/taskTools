# Task 114 plan: checkBlockers halts the run when the open-task blockedBy graph contains a cycle

## Goal

`scripts/checkBlockers.ts` currently resolves `blockedBy` one level deep only
(`openBlockersOf`), so a loop in the open-task graph (e.g. 1 blockedBy 2,
2 blockedBy 3, 3 blockedBy 1) is never noticed. Add a depth-first cycle check
over the full open-task graph. On a cycle: print every task number in the
cycle and exit non-zero. Acyclic data (including today's live data) must
produce byte-identical output and exit code 0. A blockedBy entry that names a
completed or nonexistent task number must not be treated as part of the
graph. Detection and halting only — no SCC machinery, no change to chain
rendering, no dedup of the duplicated `openBlockersOf` across the three
scripts.

## Owned files

- `scripts/checkBlockers.ts` — edit (add cycle detection, insert before the
  existing output logic).
- `tests/checkBlockers.test.ts` — edit (add fixtures + tests for the three-
  task cycle, the self-block cycle, and the ignored-completed/nonexistent
  case; existing tests are untouched and must keep passing byte-for-byte).

## Edit 1: `scripts/checkBlockers.ts`

Current full file (27 lines):

```ts
// Reports which requested task numbers are blocked by still-open tasks; stdout feeds a tackle-tasks !`node ...` command.
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const pair = resolveTaskFiles(process.cwd());
const openTasks = readTaskFile(pair.tasksPath);
const openNumbers = new Set(openTasks.map(t => t.taskNumber));

// --unblocked: print only the unblocked task numbers, space-separated, so the skill preamble can pipe them straight into getTaskDetails.ts.
const unblockedOnly = process.argv.includes("--unblocked");
// No task numbers -> check every open task (mirrors getTaskDetails' no-arg listing).
const named = leadingTaskNumbers(process.argv.slice(2).filter(a => a !== "--unblocked"));
const requested = named.length > 0 ? named : openTasks.map(t => t.taskNumber);
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  return blockedBy.filter(b => openNumbers.has(b.taskNum));
};
if (unblockedOnly) {
  process.stdout.write(requested.filter(n => openBlockersOf(n).length === 0).join(" ") + "\n");
} else {
  const lines = requested.map(n => {
    const blockers = openBlockersOf(n);
    return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${JSON.stringify(blockers)}` : `task ${n}: unblocked`;
  });
  process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
}
```

Replace the block from the `openBlockersOf` closing `};` (current line 17)
through the `if (unblockedOnly) {` line (current line 18) — i.e. insert new
code between them, leaving both of those lines themselves unchanged.

Old string to match (lines 13-18):

```
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  return blockedBy.filter(b => openNumbers.has(b.taskNum));
};
if (unblockedOnly) {
```

New string:

```
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  return blockedBy.filter(b => openNumbers.has(b.taskNum));
};

// Depth-first search with an in-progress set: a back edge into a task still "visiting" is a cycle.
function findCycle(): number[] | null {
  const state = new Map<number, "visiting" | "done">();
  const stack: number[] = [];
  const visit = (n: number): number[] | null => {
    state.set(n, "visiting");
    stack.push(n);
    for (const b of openBlockersOf(n)) {
      const seen = state.get(b.taskNum);
      if (seen === "visiting") return stack.slice(stack.indexOf(b.taskNum));
      if (seen !== "done") {
        const found = visit(b.taskNum);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(n, "done");
    return null;
  };
  for (const t of openTasks) {
    if (!state.has(t.taskNumber)) {
      const found = visit(t.taskNumber);
      if (found) return found;
    }
  }
  return null;
}

const cycle = findCycle();
if (cycle) {
  process.stderr.write(`cycle detected among open tasks: ${cycle.join(", ")}\n`);
  process.exit(1);
}

if (unblockedOnly) {
```

Everything after that line (the `if (unblockedOnly) { ... } else { ... }`
block through end of file) is unchanged.

This makes `openBlockersOf(n)` double as the edge function for the graph: it
already filters `blockedBy` entries down to those whose `taskNum` is in
`openNumbers`, so a blockedBy entry naming a completed or nonexistent task
never becomes a graph edge and can never contribute to a detected cycle.
`findCycle` walks every open task once (outer `for` loop skips any task
already marked `"done"`), so the check covers the whole open-task graph, not
just the tasks named on the command line — a cycle involving tasks the
caller didn't ask about still halts the run.

Self-blocking case (`1 blockedBy 1`): `visit(1)` sets `state.set(1,
"visiting")` and pushes `1` onto `stack`, then `openBlockersOf(1)` returns the
edge to `1` itself; `state.get(1)` is already `"visiting"`, so it returns
`stack.slice(stack.indexOf(1))` = `[1]` — reported the same way as any other
cycle.

## Edit 2: `tests/checkBlockers.test.ts`

Current full file (57 lines) already read in full; existing 5 tests
(lines 29-56) are unchanged.

### 2a. Insert three new fixture builders after `makeProjectRoot`

Old string (lines 21-25, end of `makeProjectRoot` through start of
`runScript`):

```
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
```

New string:

```
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function makeCycleProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-cycle-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "cycle a", blockedBy: [{ taskNum: 2, reason: "needs task 2" }] },
      { taskNumber: 2, title: "cycle b", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
      { taskNumber: 3, title: "cycle c", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function makeSelfBlockProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-selfblock-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 1, title: "self blocker", blockedBy: [{ taskNum: 1, reason: "needs itself" }] }]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function makeIgnoredBlockersProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-ignored-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "blocked only by closed task", blockedBy: [{ taskNum: 2, reason: "needs task 2" }] },
      { taskNumber: 3, title: "blocked only by nonexistent task", blockedBy: [{ taskNum: 99, reason: "needs task 99" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 2, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
```

### 2b. Insert a failure-expecting runner after `runScript`

Old string (lines 25-29, the whole `runScript` function through the start of
the first `test(...)` call):

```
function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
```

New string:

```
function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function runScriptExpectingFailure(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
  throw new Error("expected checkBlockers to exit non-zero");
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
```

### 2c. Append three new tests at end of file

Old string (final lines 53-57, the last existing test):

```
test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]\n');
});
```

New string:

```
test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]\n');
});

test("detects a three-task cycle among open tasks and exits non-zero", () => {
  const { status, stderr } = runScriptExpectingFailure(makeCycleProjectRoot());
  assert.notEqual(status, 0);
  assert.match(stderr, /cycle detected among open tasks: 1, 2, 3/);
});

test("detects a self-blocking task as a one-task cycle", () => {
  const { status, stderr } = runScriptExpectingFailure(makeSelfBlockProjectRoot());
  assert.notEqual(status, 0);
  assert.match(stderr, /cycle detected among open tasks: 1/);
});

test("ignores blockedBy entries pointing at completed or nonexistent tasks", () => {
  const out = runScript(makeIgnoredBlockersProjectRoot());
  assert.match(out, /task 1: unblocked/);
  assert.match(out, /task 3: unblocked/);
});
```

## Why the exact cycle members and order are correct

`findCycle`'s outer loop walks `openTasks` in array order and only starts a
fresh `visit` when a task's state is unset. For the cycle fixture
(`[1 blockedBy 2, 2 blockedBy 3, 3 blockedBy 1]`), `visit(1)` runs first:
`stack` becomes `[1]`, then recurses into `visit(2)` (`stack` = `[1, 2]`),
then `visit(3)` (`stack` = `[1, 2, 3]`). Inside `visit(3)`,
`openBlockersOf(3)` yields the edge back to `1`, whose state is
`"visiting"`, so the function returns `stack.slice(stack.indexOf(1))` =
`[1, 2, 3]`. `cycle.join(", ")` is therefore exactly `"1, 2, 3"`, matching
the test's regex.

## Why the existing tests are unaffected

The fixtures used by the five pre-existing tests (`makeProjectRoot`: tasks
1, 2, 4, with 2 blockedBy the open task 1 and 4 blockedBy the completed task
3) contain no back edge: `visit(1)` finds no blockers, `visit(2)`'s only
edge points at the already-`"done"` task 1, and `visit(4)`'s only blockedBy
entry (`taskNum: 3`) is filtered out by `openBlockersOf` because `3` is not
in `openNumbers`. `findCycle()` returns `null`, the new `if (cycle)` block
is skipped, and execution falls through to the unchanged `if (unblockedOnly)
… else …` block — output and exit code identical to today.

## Out of scope (per brief)

- No strongly-connected-component machinery.
- No change to task-stats chain rendering (task 108).
- No extraction of the duplicated `openBlockersOf` out of `checkBlockers.ts`,
  `taskStats.ts`, or `runStartup.ts` — those two files are not edited by
  this task.

## Verification

Run from the repo root:

```
npm test
```

Expected: all tests pass, including the 5 pre-existing `checkBlockers.test.ts`
tests (unchanged assertions) and the 3 new ones added above — no failures,
exit code 0.

Additionally, confirm the live data still halts on-run cleanly (no cycle
exists today per the brief, so this must still exit 0):

```
node --no-inspect scripts/checkBlockers.ts --unblocked
```

Expected: exit code 0, stdout is the space-separated list of unblocked open
task numbers (unchanged from before this task), nothing written to stderr.
</content>
