# Task 69 plan: blockedBy entries become `{ taskNum, reason }` objects, with legacy-number migration in close-tasks

## Goal

Change every `blockedBy` array element from a bare task number to an object
`{ taskNum: number, reason: string }`. Five read sites pull `taskNum` out of
the object instead of coercing the element. The one write site
(`scripts/unblockDependents.ts`) both filters by `taskNum` and — as a
one-time upgrade ride-along — rewrites any element that is still a plain
number into `{ taskNum: <that number>, reason: "reason not recorded
(migrated from legacy blockedBy format)" }` before filtering, every time it
runs. No standalone migration script. No permanent dual-shape tolerance in
the readers — they are written against the object shape only, using the
migration's exact output shape.

Decisions locked in (nothing left for the implementer to invent):
- Legacy-number migration placeholder reason text (verbatim):
  `reason not recorded (migrated from legacy blockedBy format)`
- Migration runs unconditionally over every task with an array `blockedBy`
  on every `unblockDependents.ts` invocation, not just tasks whose blockers
  overlap the closed set being processed in that run. This is required so
  that a run closing an unrelated task still upgrades task 36's
  `blockedBy: [35]` and task 62's `blockedBy: [61]` the next time
  `unblockDependents.ts` runs for any reason.
- The file is written (via `writeFileSync`) whenever migration happened OR a
  dependent was unblocked — not only when a dependent was unblocked. This is
  a change from today's write-gate (`if (unblocked.length > 0)`), because a
  run that migrates a legacy entry but doesn't happen to close that entry's
  blocker must still persist the upgrade.
- The stdout report text is unchanged: it still reports `unblocked` (tasks
  whose blockers were actually removed), not migration. A silent migration
  with no removal still reports `"no blockedBy references to the closed
  task(s)"` — that sentence is about the closed numbers specifically, and
  stays true even when an unrelated legacy entry was upgraded in the same
  run.
- `getTaskDetails.ts`'s listing renders each blocker as `taskNum (reason)`,
  comma-joined, e.g. `[blockedBy: 1 (needs task 1), 3 (needs task 3)]`.
- All five readers cast the whole (already `Array.isArray`-narrowed) array
  with `as { taskNum: number }[]` (or `as { taskNum: number; reason: string
  }[]` where the reason is also read), then `.map(entry => entry.taskNum)`
  before filtering — mirroring the existing `(task.blockedBy as number[])`
  cast already present in `scripts/runStartup.ts`. This avoids annotating
  the `.map` callback parameter directly (which would fail TypeScript's
  contravariant callback-parameter check if the source element type is
  `unknown`): casting the whole array first, then letting `.map`'s callback
  parameter type be inferred from that cast array, sidesteps the check
  entirely. `scripts/taskFiles.ts` (not an owned file) is not edited — every
  existing reader already defends `task.blockedBy` with an `Array.isArray`
  guard plus a cast (`as number[]`, `as number`, or none) rather than relying
  on a concrete array type from `TaskRecord`, which is only consistent with
  `TaskRecord.blockedBy` being loosely typed (`unknown` or `any`, most likely
  via an index signature). Under both possibilities the whole-array `as`
  cast used here type-checks; the one scenario where it would not
  (`TaskRecord.blockedBy` already concretely `number[]`) is contradicted by
  the redundant `as number[]` / `as number` casts already in the owned
  source, which would otherwise serve no purpose.

## Edits

### scripts/checkBlockers.ts

Lines 15-18, current:
```
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  return (Array.isArray(task?.blockedBy) ? task.blockedBy : []).map(Number).filter(b => openNumbers.has(b));
};
```

Replace with:
```
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
  return blockedBy.map(b => b.taskNum).filter(b => openNumbers.has(b));
};
```
(Edit target: old_string is the exact 4-line block above, matched against the live file lines 15-18.)

### scripts/prepareTasks.ts

Lines 37-40, current:
```
function getOpenBlockers(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.filter((number): number is number => openNumbers.has(number as number));
}
```

Replace with:
```
function getOpenBlockers(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
    return blockedBy.map((entry) => entry.taskNum).filter((number) => openNumbers.has(number));
}
```

### scripts/runStartup.ts

Lines 12-15, current:
```
function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as number[]) : [];
    return blockedBy.filter((n) => openNumbers.has(n));
}
```

Replace with:
```
function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
    return blockedBy.map((entry) => entry.taskNum).filter((n) => openNumbers.has(n));
}
```

### scripts/taskStats.ts

Lines 24-27, current:
```
function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.map(Number).filter(n => openNumbers.has(n));
}
```

Replace with:
```
function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
    return blockedBy.map(entry => entry.taskNum).filter(n => openNumbers.has(n));
}
```

### scripts/getTaskDetails.ts

Lines 12-17, current:
```
export function listTaskTitles(tag: string, tasks: TaskRecord[]): string[] {
  return tasks.map(t => {
    const blockers = Array.isArray(t.blockedBy) && t.blockedBy.length > 0 ? ` [blockedBy: ${t.blockedBy.join(",")}]` : "";
    return `${tag} ${t.taskNumber}: ${t.title}${blockers}`;
  });
}
```

Replace with:
```
export function listTaskTitles(tag: string, tasks: TaskRecord[]): string[] {
  return tasks.map(t => {
    const blockedBy = Array.isArray(t.blockedBy) ? (t.blockedBy as { taskNum: number; reason: string }[]) : [];
    const blockers = blockedBy.length > 0 ? ` [blockedBy: ${blockedBy.map(b => `${b.taskNum} (${b.reason})`).join(", ")}]` : "";
    return `${tag} ${t.taskNumber}: ${t.title}${blockers}`;
  });
}
```
(`describeTask` at lines 4-10 needs no edit: it `JSON.stringify`s the whole task record, so the new object shape flows through automatically.)

### scripts/unblockDependents.ts

Lines 13-25, current:
```
const { tasksPath } = resolveTaskFiles(process.cwd());
const tasks = readTaskFile(tasksPath);
const unblocked: number[] = [];
for (const t of tasks) {
  if (!Array.isArray(t.blockedBy)) continue;
  const remaining = t.blockedBy.filter(n => !closed.has(Number(n)));
  if (remaining.length === t.blockedBy.length) continue;
  unblocked.push(t.taskNumber);
  if (remaining.length === 0) delete t.blockedBy;
  else t.blockedBy = remaining;
}
if (unblocked.length > 0) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
```

Replace with:
```
const { tasksPath } = resolveTaskFiles(process.cwd());
const tasks = readTaskFile(tasksPath);
const unblocked: number[] = [];
let migrated = false;
for (const t of tasks) {
  if (!Array.isArray(t.blockedBy)) continue;
  const entries = t.blockedBy as (number | { taskNum: number; reason: string })[];
  let taskMigrated = false;
  const upgraded = entries.map((entry) => {
    if (typeof entry === "number") {
      taskMigrated = true;
      return { taskNum: entry, reason: "reason not recorded (migrated from legacy blockedBy format)" };
    }
    return entry;
  });
  const remaining = upgraded.filter((entry) => !closed.has(entry.taskNum));
  const taskUnblocked = remaining.length !== upgraded.length;
  if (!taskMigrated && !taskUnblocked) continue;
  if (taskMigrated) migrated = true;
  if (taskUnblocked) unblocked.push(t.taskNumber);
  if (remaining.length === 0) delete t.blockedBy;
  else t.blockedBy = remaining;
}
if (unblocked.length > 0 || migrated) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
```

Line 25 (the final `process.stdout.write(...)` line) is unchanged — it already reads `unblocked.join(", ")` / the "no blockedBy references" fallback, and per the locked-in decision above the report text stays scoped to actual unblocking, not migration.

### skills/create-task/template/taskTemplate.json

Line 10, current:
```
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
```

Replace with:
```
  "blockedBy": [{"taskNum": <task number that must be completed first>, "reason": "<required: why this task depends on it>"}] (one object per blocking task; omit the field entirely if none)
```

### skills/close-tasks/SKILL.md

Line 18, current:
```
Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.
```
(Brief text called this "skills/close-tasks/SKILL.md:20" — the line is 18 in the live file; content matches the brief's quoted text exactly, only the line number differs.)

Replace with:
```
Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array, upgrading any legacy bare-number entries to `{taskNum, reason}` objects (with a placeholder reason) along the way, and reports what it unblocked.
```

### skills/goal-tasks/SKILL.md — no edit

Line 16 reads: "Use `/create-task` to create granular tasks that, when all are
completed, achieve the goal. Encode order with `blockedBy` so progress
toward the goal is measurable." This describes `blockedBy` only as an
ordering mechanism; it never states the element shape (bare number vs.
object), so it stays accurate for the new object shape unchanged. No edit.

### skills/tackle-unblocked-tasks/SKILL.md — no edit

Line 3's description says "...whose `blockedBy` array is empty..." — an
empty-array check that is equally true for an array of objects as it was for
an array of numbers. No shape is described. No edit.

### skills/pick-a-task/SKILL.md — no edit

Never describes `blockedBy`'s element shape; it only consumes
`checkBlockers.ts` and `getTaskDetails.ts` stdout output as opaque text. Not
affected by the internal shape change. No edit.

### scripts/rateTask.ts, skills/rate-task/SKILL.md, tests/rateTask.test.ts — no edit (do not exist)

Confirmed via `ls scripts/`, `ls skills/`, `ls tests/`: none of these three
paths exist anywhere in the current repository (there is no `rate-task`
skill directory, and no `rateTask.ts` script or test file). Nothing to edit.

### tests/mergeTaskWorktrees.test.ts — no edit

Its only `blockedBy` reference is at line 606: `blockedBy: []` (an empty
array, inside the `tasks.json` fixture written by
`buildNestedFixtureWithTask`). An empty array has no elements to reshape, so
it is valid and unchanged under both the old and new element shape. No edit.

## Test edits

### tests/checkBlockers.test.ts

Lines 20-21, current:
```
      { taskNumber: 2, title: "blocked by open task", blockedBy: [1] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [3] },
```

Replace with:
```
      { taskNumber: 2, title: "blocked by open task", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
```
No other lines in this file reference `blockedBy` content; all assertions
check `checkBlockers.ts`'s plain-number stdout output, which is unchanged.

### tests/getTaskDetails.test.ts

Line 21, current:
```
      { taskNumber: 2, title: "blocked task", blockedBy: [1, 3] },
```

Replace with:
```
      { taskNumber: 2, title: "blocked task", blockedBy: [{ taskNum: 1, reason: "needs task 1" }, { taskNum: 3, reason: "needs task 3" }] },
```

Line 31, current:
```
  assert.match(out, /OPEN 2: blocked task \[blockedBy: 1,3\]/);
```

Replace with:
```
  assert.match(out, /OPEN 2: blocked task \[blockedBy: 1 \(needs task 1\), 3 \(needs task 3\)\]/);
```

Lines 55-59, current:
```
test("full details include the blockedBy field", () => {
  const out = runScript(makeProjectRoot(), "2");
  assert.match(out, /task 2 \(OPEN\)/);
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("{"))).blockedBy, [1, 3]);
});
```

Replace with:
```
test("full details include the blockedBy field", () => {
  const out = runScript(makeProjectRoot(), "2");
  assert.match(out, /task 2 \(OPEN\)/);
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("{"))).blockedBy, [
    { taskNum: 1, reason: "needs task 1" },
    { taskNum: 3, reason: "needs task 3" },
  ]);
});
```

### tests/prepareTasks.test.ts

Line 170, current:
```
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1], files: ["b.ts"] }];
```

Replace with:
```
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [{ taskNum: 1, reason: "needs task 1" }], files: ["b.ts"] }];
```

Line 193, current:
```
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1] }];
```

Replace with:
```
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [{ taskNum: 1, reason: "needs task 1" }] }];
```

### tests/runStartup.test.ts

Line 24, current:
```
            { taskNumber: 2, title: "blocked by open task", blockedBy: [1] },
```

Replace with:
```
            { taskNumber: 2, title: "blocked by open task", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
```

### tests/taskStats.test.ts

Line 28, current:
```
    const open = [openTask(1, { blockedBy: [2] }), openTask(2), openTask(3, { blockedBy: [99] })];
```

Replace with:
```
    const open = [openTask(1, { blockedBy: [{ taskNum: 2, reason: "needs task 2" }] }), openTask(2), openTask(3, { blockedBy: [{ taskNum: 99, reason: "needs task 99" }] })];
```

Line 91, current:
```
        openTask(2, { files: ["b.ts"], blockedBy: [1] }),
```

Replace with:
```
        openTask(2, { files: ["b.ts"], blockedBy: [{ taskNum: 1, reason: "needs task 1" }] }),
```

### tests/unblockDependents.test.ts

Lines 14-26, current:
```
function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 2, title: "fully blocked", blockedBy: [1] },
      { taskNumber: 4, title: "partly blocked", blockedBy: [1, 3] },
      { taskNumber: 5, title: "unrelated" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}
```

Replace with:
```
function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 2, title: "fully blocked", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "partly blocked", blockedBy: [{ taskNum: 1, reason: "needs task 1" }, { taskNum: 3, reason: "needs task 3" }] },
      { taskNumber: 5, title: "unrelated" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}
```

Lines 32-40, current:
```
test("removes closed number, drops emptied blockedBy, keeps other blockers", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 2), false);
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 4).blockedBy, [3]);
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 5), false);
  assert.match(out, /task\(s\): 2, 4/);
});
```

Replace with:
```
test("removes closed number, drops emptied blockedBy, keeps other blockers and their reason", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 2), false);
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 4).blockedBy, [{ taskNum: 3, reason: "needs task 3" }]);
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 5), false);
  assert.match(out, /task\(s\): 2, 4/);
});
```

Lines 42-48 (the "no matching blockers" test) are unchanged — the fixture no
longer contains bare numbers, so with `closed = {99}` there is nothing to
migrate and nothing to unblock, and `tasks.json` is still never written,
matching the existing assertion that the file is byte-identical before and
after.

Append two new tests after the existing "no matching blockers leaves
tasks.json untouched" test (i.e., after line 48, before the file's closing
newline), covering the migration path that the write-site edit adds:
```

test("migrates a legacy bare-number blockedBy entry and still filters it when its blocker closes", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-legacy-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 6, title: "legacy blocker", blockedBy: [1] }]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 6), false);
  assert.match(out, /task\(s\): 6/);
});

test("migrates a legacy bare-number entry to the object shape even when its blocker is not the one closing", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-legacy-survive-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 7, title: "legacy blocker", blockedBy: [1] }]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  const out = runScript(root, "99");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 7).blockedBy, [
    { taskNum: 1, reason: "reason not recorded (migrated from legacy blockedBy format)" },
  ]);
  assert.match(out, /no blockedBy references/);
});
```

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools`):

1. `npx tsc --noEmit`
   Expected: exits 0, no type errors (this is the project's own
   `DEFAULT_TYPECHECK_COMMAND` from `scripts/prepareTasks.ts`).

2. `node --test tests/checkBlockers.test.ts tests/getTaskDetails.test.ts tests/prepareTasks.test.ts tests/runStartup.test.ts tests/taskStats.test.ts tests/unblockDependents.test.ts tests/mergeTaskWorktrees.test.ts`
   Expected: exits 0; summary line shows `# fail 0` and `# pass` equal to the
   total test count (each test file's tests listed above, plus the two new
   migration tests in `tests/unblockDependents.test.ts`).

3. `grep -n '"taskNum"' skills/create-task/template/taskTemplate.json`
   Expected: one match on the rewritten `blockedBy` line.

4. `grep -n "legacy bare-number" skills/close-tasks/SKILL.md`
   Expected: one match on the rewritten unblock-dependents paragraph.
