# Task 81: Fold unblockDependents into the closeTasks script so closing and unblocking happen in one call

## User request

unblockDependents.ts should be part of the close-tasks script execution that moves entries from tasks.json to completedTasks.json, and not invoked by the agent directly.  Note: when create-task becomes dynamic-injection-based and is refactored, this task might be automatically handled.

Current state, after task #64 landed scripts/closeTasks.ts (114 lines):

- `closeTasks(taskNumbers, closureNote, projectRoot, commitHashes)` at scripts/closeTasks.ts:36-82 resolves both file paths with `resolveTaskFiles`, reads both files, filters out ineligible numbers into `skipped` (52-57), resolves every note/hash up front so a missing Record entry throws before anything is written (59-65), splices each task out of `tasks` and pushes it onto `completedTasks` (67-74), then writes BOTH files once at 76-79 guarded by `if (closed.length > 0)`. Returns `{closed, skipped}` (type at 5-8). The CLI entry is at 102-114.
- scripts/unblockDependents.ts (25 lines) then re-reads and re-writes tasks.json a second time. Its own header comment at lines 1-3 already states it is "Invoked by the close-tasks skill after moving closed tasks to completedTasks.json".
- skills/close-tasks/SKILL.md:20 is the prose that makes the agent run it as a separate step.

**The blocking structural problem:** unblockDependents.ts exports nothing. Every line of it is top-level module-scope code that runs on import — argv parsing at line 7, the usage/exit guard at 8-11, `resolveTaskFiles(process.cwd())` at 13, the mutation loop at 16-23, the conditional write at 24, and the stdout report at 25. `closeTasks` cannot call it as-is; importing it would execute it. The logic must first be extracted into an exported function (taking the closed numbers and a project root, returning the unblocked task numbers) before it can be folded in.

**Decision taken:** keep scripts/unblockDependents.ts as a file. It retains its CLI entry point and gains that exported function, which closeTasks imports — one implementation, two entry points. tests/unblockDependents.test.ts (48 lines) stays pointed at the extracted function. Do not delete the file; a way to unblock without closing something is worth keeping.

**Second reason this matters beyond tidiness — the double write.** Today tasks.json goes through two independent read-modify-write cycles: closeTasks writes it at scripts/closeTasks.ts:77, then unblockDependents re-reads it at line 14 and rewrites it at line 24. Anything that touches tasks.json between the two sees a half-applied state, and an agent that forgets step two leaves stale blockedBy entries pointing at completed tasks. Fold the unblock pass in BEFORE the write at closeTasks.ts:76-79 so both mutations land in a single write of the in-memory `tasks` array. Do not call the extracted function in a way that re-reads the file — pass it the already-loaded array.

**Also update** skills/close-tasks/SKILL.md:20 to drop the separate invocation instruction, and fold what it reported ("removed closed task(s) from blockedBy of task(s): ..." / "no blockedBy references to the closed task(s)", unblockDependents.ts:25) into closeTasks's own stdout at closeTasks.ts:110-113, so the user still sees what was unblocked. Consider adding the unblocked numbers to `CloseTasksResult` (closeTasks.ts:5-8) rather than only printing them.

**Ordering notes, none of them hard blockers:**
- Open task #69 also edits scripts/unblockDependents.ts (it changes blockedBy entries to `{taskNum, reason}` objects, rewriting the filter at line 18). Either order works — whichever lands second edits the logic in its new home — but expect a rebase.
- Open task #71 copies the close-tasks SKILL.md body verbatim into a script. This task should land FIRST, or #71 will faithfully copy the now-wrong line 20 instruction into the new brief.
- The user's own note about a later dynamic-injection refactor possibly absorbing this work refers to that same family (#71 for close-tasks, #72 for create-task). Those tasks are explicitly scoped as verbatim copies with no logic changes, so they will NOT absorb this one — this change has to be made deliberately.

**Line budget:** closeTasks.ts is at 114 of a 250-line cap, so the extracted call plus reporting fits comfortably.

### scripts/closeTasks.ts

```
// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
}

// Local calendar date, not UTC — toISOString() rolls to tomorrow during US evening hours.
function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function noteFor(closureNote: string | Record<number, string>, taskNumber: number): string {
  if (typeof closureNote === "string") return closureNote;
  if (!(taskNumber in closureNote)) {
    throw new Error(`closeTasks: no closureNote given for task ${taskNumber}`);
  }
  return closureNote[taskNumber];
}

function hashesFor(
  commitHashes: string[] | Record<number, string[]>,
  taskNumber: number,
): string[] {
  if (Array.isArray(commitHashes)) return commitHashes;
  if (!(taskNumber in commitHashes)) {
    throw new Error(`closeTasks: no commitHashes given for task ${taskNumber}`);
  }
  return commitHashes[taskNumber];
}

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = readTaskFile(tasksPath);
  const completedTasks = readTaskFile(completedTasksPath);
  const completedNumbers = new Set(completedTasks.map((task) => task.taskNumber));
  const completionDate = localDate();

  // Duplicates would make the second findIndex return -1 and splice off an unrelated task.
  const uniqueTaskNumbers = [...new Set(taskNumbers)];

  const skipped: number[] = [];
  const willClose = uniqueTaskNumbers.filter((taskNumber) => {
    const eligible =
      tasks.some((task) => task.taskNumber === taskNumber) && !completedNumbers.has(taskNumber);
    if (!eligible) skipped.push(taskNumber);
    return eligible;
  });

  // Resolve every closing task's note/hashes before mutating anything, so a missing Record entry throws before either file is written.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      { closureNote: noteFor(closureNote, taskNumber), commitHashes: hashesFor(commitHashes, taskNumber) },
    ]),
  );

  const closed: number[] = [];
  for (const taskNumber of willClose) {
    const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
    const [task] = tasks.splice(index, 1);
    const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
    completedTasks.push({ ...task, completionDate, commitHashes: hashes, closureNote: note });
    closed.push(taskNumber);
  }

  if (closed.length > 0) {
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
  }

  return { closed, skipped };
}

function parseCloseNoteArg(raw: string): string | Record<number, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<number, string>;
    }
  } catch {
    // not JSON — treat as a plain free-text closure note
  }
  return raw;
}

function parseCommitHashesArg(raw: string | undefined): string[] | Record<number, string[]> | undefined {
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as string[]) : (parsed as Record<number, string[]>);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const taskNumbers = leadingTaskNumbers([process.argv[2] ?? ""]);
  const closureNote = parseCloseNoteArg(process.argv[3] ?? "");
  const commitHashes = parseCommitHashesArg(process.argv[4]);
  const { closed, skipped } =
    commitHashes === undefined
      ? closeTasks(taskNumbers, closureNote)
      : closeTasks(taskNumbers, closureNote, undefined, commitHashes);
  process.stdout.write(
    `closed: ${closed.length > 0 ? closed.join(", ") : "none"}\n` +
      `skipped (already completed or not found): ${skipped.length > 0 ? skipped.join(", ") : "none"}\n`,
  );
}

```

### scripts/unblockDependents.ts

```
// Removes the given (just-closed) task numbers from every tasks.json entry's
// blockedBy array, dropping the field when it empties. Invoked by the
// close-tasks skill after moving closed tasks to completedTasks.json.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const closed = new Set((process.argv.slice(2).join(" ").match(/\d+/g) ?? []).map(Number));
if (closed.size === 0) {
  process.stderr.write("usage: node unblockDependents.ts <taskNumber...>\n");
  process.exit(1);
}

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
process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");

```

### skills/close-tasks/SKILL.md

```
---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
---

- tasks to close: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — and everything after them is free-text reasoning. The script reads the whole argument string and stops at the first token that is not part of the array, so the reasoning is ignored by it. Avoid apostrophes and backticks in that reasoning; it reaches the shell inside single quotes. If the details above don't cover every task number named in `$ARGUMENTS` — a full listing instead, or only the first few — the invoker skipped the array form or put spaces in it: re-run the script yourself with all the numbers before continuing.

`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Before closing, search git history for the commit(s) that resolved each task; use an empty array for a task only if none can be identified. Close every listed OPEN task in exactly one invocation of `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts" '[N,N,...]' '<note>' '<hashes>'` — never split the batch across calls: the first argument is every listed task number as one no-space JSON array. The second argument is either one sentence of closure reasoning shared by every task number in that array, or — when tasks in the same call need different reasoning — a no-space JSON object mapping each task number to its own sentence, e.g. `{"64":"fixed by abc123","65":"verified by user"}`; use the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none. The third argument is optional and follows the same shared-vs-per-task shape for the commit hashes found above: a no-space JSON array shared by every task in the call, e.g. `["abc123"]`, or a no-space JSON object mapping each task number to its own array, e.g. `{"64":["abc123"],"65":[]}`; omit this argument (or pass `[]`) only when no task in the call has any commits to record. Use the shared string/array forms only when every task in the batch has identical reasoning and hashes; otherwise use the per-task JSON object forms. Either way it is one call. The script writes today's date as `completionDate` and the resolved `closureNote`/`commitHashes` onto each closed task's record, splices it out of `tasks.json`, appends it to `completedTasks.json`, and reports which numbers it closed and which it skipped (already COMPLETED or not found in either file) — relay the skipped ones to the user.

Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.

Stage the changes but do not commit. Provide a short commit message to the user, similar to "Closed tasks [268,270,281]" or "Closed task [268]", naming the numbers you actually closed.

If a spec document references these task numbers, mark those items done in the spec.

```

### tests/closeTasks.test.ts

```
// closeTasks.ts moves closed tasks to completedTasks.json and skips already-completed or absent task numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTasks } from "../scripts/closeTasks.ts";

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 64, title: "first" },
      { taskNumber: 65, title: "second" },
      { taskNumber: 66, title: "third" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 60, title: "already done" }]));
  return root;
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "completedTasks.json"), "utf8"));
}

test("closes one task, keeps sibling order, writes completionDate/commitHashes/closureNote", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks([65], "fixed by abc123", root);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 66],
  );
  const completed = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.equal(completed.closureNote, "fixed by abc123");
  assert.deepEqual(completed.commitHashes, []);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(
    completed.completionDate,
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  assert.doesNotThrow(() => readTasks(root));
  assert.doesNotThrow(() => readCompleted(root));
});

test("duplicate task numbers close the task once and leave siblings alone", () => {
  const root = makeProjectRoot();
  const { closed } = closeTasks([65, 65], "fixed by abc123", root);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 66],
  );
  assert.equal(readCompleted(root).filter((t) => t.taskNumber === 65).length, 1);
});

test("skips a task already in completedTasks.json and one absent from both files", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks([60, 99], "irrelevant", root);

  assert.deepEqual(closed, []);
  assert.deepEqual(skipped, [60, 99]);
  assert.equal(readCompleted(root).filter((t) => t.taskNumber === 60).length, 1);
});

test("records the given commit hashes on the closed task", () => {
  const root = makeProjectRoot();
  closeTasks([64], "shipped", root, ["abc123", "def456"]);
  const completed = readCompleted(root).find((t) => t.taskNumber === 64);
  assert.deepEqual(completed.commitHashes, ["abc123", "def456"]);
});

test("one call with per-task Record note/hashes gives each closed task its own values", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks(
    [64, 65],
    { 64: "fixed by abc123", 65: "verified by user" },
    root,
    { 64: ["abc123"], 65: [] },
  );

  assert.deepEqual(closed, [64, 65]);
  assert.deepEqual(skipped, []);
  const completed64 = readCompleted(root).find((t) => t.taskNumber === 64);
  const completed65 = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.equal(completed64.closureNote, "fixed by abc123");
  assert.deepEqual(completed64.commitHashes, ["abc123"]);
  assert.equal(completed65.closureNote, "verified by user");
  assert.deepEqual(completed65.commitHashes, []);
});

test("a Record closureNote missing an entry for a closing task throws before writing either file", () => {
  const root = makeProjectRoot();
  assert.throws(() => closeTasks([64, 65], { 64: "fixed by abc123" }, root));
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 65, 66],
  );
  assert.equal(readCompleted(root).length, 1);
});

```

### tests/unblockDependents.test.ts

```
// Behavioral checks for unblockDependents.ts: closed task numbers are removed
// from every tasks.json entry's blockedBy array, and the field is dropped
// entirely when it empties. Untouched entries stay byte-identical.
// Run with: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "unblockDependents.ts");

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

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("removes closed number, drops emptied blockedBy, keeps other blockers", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 2), false);
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 4).blockedBy, [3]);
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 5), false);
  assert.match(out, /task\(s\): 2, 4/);
});

test("no matching blockers leaves tasks.json untouched", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "99");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
  assert.match(out, /no blockedBy references/);
});

```
