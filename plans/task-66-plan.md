# Task 66 plan: widen difficulty to 1-10, add /rate-task skill

## Scope confirmation

Task 66's live `blockedBy` is `[]` (task 65 closed and was stripped by
`unblockDependents.ts`; the brief's own text still narrates the original
`blockedBy: [58, 65]` state, but the record now shows `[]`, so the run this
plan feeds is intentionally proceeding). Task 58 (the `modifiableFiles` /
`readOnlyFiles` split) is still open — confirmed via
`.taskTools/tasks.json` and absence from `.taskTools/completedTasks.json` —
and `modifiableFiles`/`readOnlyFiles` do not exist anywhere in the
codebase (`rg -n "modifiableFiles|readOnlyFiles"` finds only a comment in
`scripts/addTaskFiles.ts` noting where to repoint once #58 lands). The new
`rate-task` skill therefore reads the task's existing `files` field (the
only file-ownership key that exists today) — not `modifiableFiles` /
`readOnlyFiles`, which is #58's job to introduce.

## Part One — widen the difficulty scale from 1-5 to 1-10

Remap rule fixed by the brief: old value doubles (`1→2, 2→4, 3→6, 4→8,
5→10`), `null` stays `null`. The new ten anchors are built by keeping the
five old anchors verbatim at the even slots (2,4,6,8,10) and inserting one
new intermediate anchor at each odd slot (1,3,5,7,9):

```
1 = trivial: a config/text tweak with no logic change (typo, comment, constant value); 2 = one-line or single-file mechanical change; 3 = a small mechanical change plus minor adjacent cleanup, still one file; 4 = contained change to one file plus its test; 5 = a couple of closely related files, design already settled, no new test surface; 6 = several files in one subsystem, design already settled; 7 = several files in one subsystem plus a design choice that's mostly obvious; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with more than one open design decision, or touches a fragile area; 10 = wide blast radius, unclear scope, or a previously reverted attempt
```

### Edit 1 — `skills/create-task/template/taskTemplate.json` line 9

Current line 9 (full file is 12 lines):
```
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
```

Becomes:
```
  "difficulty": <implementation effort and risk, NOT importance: 1 = trivial: a config/text tweak with no logic change (typo, comment, constant value); 2 = one-line or single-file mechanical change; 3 = a small mechanical change plus minor adjacent cleanup, still one file; 4 = contained change to one file plus its test; 5 = a couple of closely related files, design already settled, no new test surface; 6 = several files in one subsystem, design already settled; 7 = several files in one subsystem plus a design choice that's mostly obvious; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with more than one open design decision, or touches a fragile area; 10 = wide blast radius, unclear scope, or a previously reverted attempt>,
```

Every other line in the file is unchanged.

### Edit 2 — `skills/pick-a-task/SKILL.md` line 3 (front-matter description)

Current line 3:
```
description: read the open tasks in tasks.json, filter to unblocked, sort by difficulty (1=easiest, 5=hardest), and pick the N lowest-difficulty ones that are still relevant to the current codebase. Report why in under 15 words each. Optional argument N = how many tasks to return.
```

Becomes (only `5=hardest` → `10=hardest`):
```
description: read the open tasks in tasks.json, filter to unblocked, sort by difficulty (1=easiest, 10=hardest), and pick the N lowest-difficulty ones that are still relevant to the current codebase. Report why in under 15 words each. Optional argument N = how many tasks to return.
```

### Edit 3 — `skills/pick-a-task/SKILL.md` line 14 (inline anchor list)

Current line 14:
```
For every remaining (non-blocked) open task number, pull its full record in one call — `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` with all the numbers passed at once — and read each record's `difficulty` field (1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt).
```

Becomes:
```
For every remaining (non-blocked) open task number, pull its full record in one call — `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` with all the numbers passed at once — and read each record's `difficulty` field (1 = trivial: a config/text tweak with no logic change (typo, comment, constant value); 2 = one-line or single-file mechanical change; 3 = a small mechanical change plus minor adjacent cleanup, still one file; 4 = contained change to one file plus its test; 5 = a couple of closely related files, design already settled, no new test surface; 6 = several files in one subsystem, design already settled; 7 = several files in one subsystem plus a design choice that's mostly obvious; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with more than one open design decision, or touches a fragile area; 10 = wide blast radius, unclear scope, or a previously reverted attempt).
```

No other line in `skills/pick-a-task/SKILL.md` changes. `rg` confirms no
test file or other source file hardcodes the old anchor text, so no
regression risk elsewhere.

### `skills/split-task/SKILL.md` — no edit

Its frontmatter `description` says "Trigger when a task's difficulty is
above 3" (an old-scale threshold that numerically drifts once stored
values are remapped). The brief is explicit that only the two files above
"are spelled out" with the anchors and that widening "needs no code
change, only these two prose definitions" — this threshold is descriptive
frontmatter text with no code enforcing it (confirmed: no script reads a
difficulty bound), and Part Two of this task supplies its functional
successor — `rate-task`'s own split-worthiness score — so leaving the
stale phrase does not block or mislead anything mechanically. No edit.

### Remap command — report to the user, do not run

Per the brief, `.taskTools/tasks.json` and `.taskTools/completedTasks.json`
must not be edited inside a task worktree (concurrent sessions append to
them). The implementer runs no remap; instead the final report to the user
includes this exact one-time command, to be run on the live repo after
this plan's changes are merged:

```
cd /Users/matkatmusicllc/Programming/taskTools \
  && jq '(.[] | select(.difficulty != null) | .difficulty) |= (. * 2)' .taskTools/tasks.json > .taskTools/tasks.json.tmp \
  && mv .taskTools/tasks.json.tmp .taskTools/tasks.json \
  && jq '(.[] | select(.difficulty != null) | .difficulty) |= (. * 2)' .taskTools/completedTasks.json > .taskTools/completedTasks.json.tmp \
  && mv .taskTools/completedTasks.json.tmp .taskTools/completedTasks.json
```

This doubles every non-null `difficulty` in both files (including task
66's own current `4` → `8`) and leaves `null` untouched, satisfying "Do
not re-rate it by hand."

## Part Two — the `rate-task` skill

### New file — `scripts/rateTask.ts`

Full content (models `scripts/unblockDependents.ts`'s shape: no CLI guard,
plain top-level script, `readTaskFile`/`resolveTaskFiles` reuse,
`JSON.stringify(tasks, null, 2) + "\n"` write, matching
`scripts/taskArchival.ts`'s write pattern):

```ts
// Writes back a task's difficulty (1-10); split-worthiness and split points are chat-only, not persisted.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const [taskArg, difficultyArg] = process.argv.slice(2);
const taskNumber = Number(taskArg);
const difficulty = Number(difficultyArg);
if (!Number.isInteger(taskNumber) || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 10) {
  process.stderr.write("usage: node rateTask.ts <taskNumber> <difficulty 1-10>\n");
  process.exit(1);
}

const { tasksPath } = resolveTaskFiles(process.cwd());
const tasks = readTaskFile(tasksPath);
const task = tasks.find(t => t.taskNumber === taskNumber);
if (!task) {
  process.stderr.write(`task ${taskNumber}: not found in tasks.json\n`);
  process.exit(1);
}
task.difficulty = difficulty;
writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
process.stdout.write(`task ${taskNumber}: difficulty set to ${difficulty}\n`);
```

### New file — `tests/rateTask.test.ts`

Full content (models `tests/unblockDependents.test.ts` and
`tests/checkBlockers.test.ts`'s `execFileSync` + temp-project-root style;
covers the write, the not-found refusal, and the out-of-range refusal,
each asserting no mutation happens on failure):

```ts
// Behavioral checks for rateTask.ts: valid writes, invalid range, and unknown task number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "rateTask.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-rateTask-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "task one", difficulty: 3 },
      { taskNumber: 2, title: "task two", difficulty: 6 },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("writes back the named task's difficulty, leaves the other task untouched", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1", "8");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal(tasks.find((t: any) => t.taskNumber === 1).difficulty, 8);
  assert.equal(tasks.find((t: any) => t.taskNumber === 2).difficulty, 6);
  assert.match(out, /task 1: difficulty set to 8/);
});

test("refuses an out-of-range difficulty without writing", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  assert.throws(() => runScript(root, "1", "11"));
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("refuses a task number not present in tasks.json", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  assert.throws(() => runScript(root, "99", "5"));
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});
```

### New file — `skills/rate-task/SKILL.md`

Full content (front-matter modeled on `skills/pick-a-task/SKILL.md` and
`skills/split-task/SKILL.md`; the target-task-number injection is one
self-contained shell one-liner, matching the intermediate-variable style
`skills/tackle-unblocked-tasks/SKILL.md` uses; the invocation line mirrors
`skills/pick-a-task/SKILL.md` line 6's optional-argument phrasing; the
record-pull line reuses `getTaskDetails.ts` with every target number in
one call, per the brief):

```markdown
---
name: rate-task
description: evaluate an open task's description and files to score its difficulty and split-worthiness on a 1-10 scale, write the difficulty back to tasks.json, and suggest split points for use with /split-task when the split score is 5 or higher. Optional argument taskNum = which task to rate; omit to rate every open task.
argument-hint: "[taskNum]"
---

Task to rate: $ARGUMENTS (rate every open task if blank or not a number).

- Task numbers and full records: !`n="$ARGUMENTS"; if [ -z "$n" ] || ! echo "$n" | grep -qE '^[0-9]+$'; then n=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN | sed -E 's/^OPEN ([0-9]+):.*/\1/' | tr '\n' ' '); fi; node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" $n`

If the records above are empty, report that there are no open tasks to rate and stop. If `$ARGUMENTS` named a task number that is not OPEN (not found among the records above), report that and stop instead of rating anything.

For each task record above, read its `title`, `description`, `userDescription`, and `files`, then judge two independent 1-10 scores:

Difficulty (implementation effort and risk, NOT importance): 1 = trivial: a config/text tweak with no logic change (typo, comment, constant value); 2 = one-line or single-file mechanical change; 3 = a small mechanical change plus minor adjacent cleanup, still one file; 4 = contained change to one file plus its test; 5 = a couple of closely related files, design already settled, no new test surface; 6 = several files in one subsystem, design already settled; 7 = several files in one subsystem plus a design choice that's mostly obvious; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with more than one open design decision, or touches a fragile area; 10 = wide blast radius, unclear scope, or a previously reverted attempt.

Split-worthiness (how much splitting the task would help, independent of difficulty — a task can be hard yet atomic): 1-2 = a single mechanical edit with no separable pieces. 3-4 = a few small edits that belong together as one unit of work. 5-6 = at least two logically separable pieces of work that could each be closed independently. 7-8 = three or more separable pieces, or pieces that touch clearly different subsystems. 9-10 = so many separable pieces, or so wide a blast radius, that no single agent should own it all at once.

When the split-worthiness score is 5 or higher, name at least two concrete split points — logically separable pieces of the task's work, each described in under 15 words. When it is below 5, name none.

For each rated task, persist the difficulty with `node "${CLAUDE_PLUGIN_ROOT}/scripts/rateTask.ts" <taskNum> <difficulty>`. Do not persist the split-worthiness score or split points anywhere — they are chat-only.

Report to the user, for each rated task: its number, title, difficulty X/10, split-worthiness Y/10, and — only when Y is 5 or higher — the named split points and the line `consider: /split-task <taskNum> <numSplits>` where `<numSplits>` is the number of split points named.
```

### Files needing no edit — reference only

- `scripts/taskFiles.ts` — `rateTask.ts` imports `readTaskFile` and
  `resolveTaskFiles` from it unchanged; no new export needed.
- `scripts/taskArchival.ts` — read only to copy its
  `JSON.stringify(tasks, null, 2) + "\n"` write pattern into `rateTask.ts`;
  no edit.
- `skills/split-task/SKILL.md` — read only, to confirm the `<taskNum>
  <numSplits>` interface `rate-task`'s "consider: /split-task ..." line
  must match; no edit (also covered under Part One above).

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

```
npx tsc --noEmit
```
Expected: exits 0, no new type errors (`rateTask.ts` only uses existing
exports of `taskFiles.ts` with no signature changes).

```
node --test tests/rateTask.test.ts
```
Expected: `# pass 3`, `# fail 0`.

```
node --test tests/*.test.ts
```
Expected: every existing suite still passes (no other file's behavior
changed) alongside the new `rateTask.test.ts` suite.

```
node "scripts/getTaskDetails.ts" | grep ^OPEN
```
Expected: unaffected — `getTaskDetails.ts` is untouched.

```
grep -c "1 = trivial" skills/create-task/template/taskTemplate.json skills/pick-a-task/SKILL.md
```
Expected: `1` for each file (one occurrence of the new ten-anchor list).

Manual/behavioral check (not automatable — the rating itself is agent
judgment, matching how `pick-a-task`'s ease sorting has no unit test
either): invoke `/rate-task` against a fixture `tasks.json` holding one
sprawling multi-subsystem task and one one-line mechanical task, and
confirm the sprawling task is reported with a split-worthiness score ≥5
plus at least two named split points, and the mechanical task with a score
<5 and no split points — this satisfies the task's `tests` field
descriptively even though it is not enforced by `node --test`.
