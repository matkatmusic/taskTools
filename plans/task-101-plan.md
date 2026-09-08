# Task 101 plan: add the rate-task skill

## Scope

Create exactly three new files. No existing file is edited.

- `skills/rate-task/SKILL.md` (new)
- `scripts/rateTask.ts` (new)
- `tests/rateTask.test.ts` (new)

All three are currently absent (brief confirms "missing: file not found on disk" for each). No manifest edit is needed — `.claude-plugin/plugin.json` carries no skills array and skills are auto-discovered from `skills/<name>/SKILL.md` (this is asserted directly by the brief's DISCOVERY section and is not something this plan re-derives).

## Decisions settled during planning (read directly from source, not guessed)

1. **`declaredFiles` accessor.** Per Amendment 2 in the brief, confirmed by reading `scripts/taskGroups.ts:15-17`: `export function declaredFiles(task: TaskRecord): string[] { return Array.isArray(task.files) ? (task.files as string[]) : []; }`. `scripts/rateTask.ts` imports this exact function via `import { declaredFiles } from "./taskGroups.ts";` and never reimplements it, never reads `task.files` directly, and adds no `modifiableFiles`/`readOnlyFiles` handling.

2. **Persistence: both scores.** Amendment 1 supersedes the original "split-worthiness is chat-only" language. `scripts/rateTask.ts` writes both `difficulty` and a new `splitWorthiness` key back onto the task record in `.taskTools/tasks.json`, using `readTaskFile`/`resolveTaskFiles` from `scripts/taskFiles.ts` and serializing with `JSON.stringify(tasks, null, 2) + "\n"`, matching `scripts/taskArchival.ts`'s pattern (its `archivePublishedTasks` function does exactly this at lines 86-90 of that file).

3. **The "pick-a-task line 14" citation is false, but the underlying `getTaskDetails.ts` requirement stands.** `skills/pick-a-task/SKILL.md` was read in full: it is 10 lines total, has no line 14, and never calls `getTaskDetails.ts`. That analogy is wrong. But the brief's Persistence-contract and INVOCATION sections independently require record retrieval to route through `scripts/getTaskDetails.ts`, not through a second, parallel implementation of task-list reading in `rateTask.ts` — a false citation about *which line* does it does not cancel *that* requirement. `scripts/getTaskDetails.ts` is not only a CLI; it also exports `readTaskLists(projectRoot)`, returning `{ openTasks: TaskRecord[]; completedTasks: TaskRecord[] }` already parsed (no re-implementation of `resolveTaskFiles`/`readTaskFile` for this purpose, no fragile parsing of the human-formatted `describeTask` string). `scripts/rateTask.ts` imports `readTaskLists` from `./getTaskDetails.ts` and calls it **exactly once per run** to fetch every scoring input, then filters/maps to the requested task numbers (or uses all of `openTasks` when none are requested). `resolveTaskFiles`/`readTaskFile` from `scripts/taskFiles.ts` are still imported, but used **only** for the separate persistence step (Decision 2): a second, independent read of `tasksPath`, mutate the matching records, and write back. Argument parsing uses `leadingTaskNumbers(process.argv.slice(2))` from `scripts/taskFiles.ts`, the exact pattern already used by `scripts/getTaskDetails.ts`, `scripts/addTaskFiles.ts`, and `scripts/prepareTasks.ts` for CLI task-number args.

   What the brief's `pick-a-task/SKILL.md` reference *is* accurate about, and what this plan does follow: the "optional argument, no argument = act on every open task" shape, which really is pick-a-task's frontmatter `description:` line (line 3: "...Optional argument N = how many tasks to return.").

4. **Split points, shaped for `/split-task`.** `skills/split-task/SKILL.md` was read in full. Its actual invocation shape is `/split-task <taskNum> <numSplits> [guidance]` — a human/assistant-driven CLI where `[guidance]` is free text describing split points that the assistant uses to decide file groupings; there is no JSON-shaped argument accepted at invocation time (the JSON-shaped argument only appears later, in the internal `close` command, built by the assistant after real child tasks already exist — not something `rate-task` can produce). So "shaped for `/split-task <taskNum> <numSplits>`" means: `rateTask.ts` prints, for a split-worthy task, the two literal numbers (`<taskNum>` and a suggested `<numSplits>` equal to the split-point count) plus a short guidance line per split point that can be pasted as `/split-task`'s optional third argument.

5. **Difficulty — an explicit, deterministic implementation of task 100's ten finalized anchors.** Task 100 is closed; `skills/create-task/template/taskTemplate.json` line 8 carries the finalized anchor text: `1 = typo, comment, or constant edit with no behavior change; 2 = one-line or single-file mechanical change; 3 = one file edited alongside an existing test that already covers it; 4 = contained change to one file plus its test; 5 = a few files in one subsystem, mostly mechanical; 6 = several files in one subsystem, design already settled; 7 = one subsystem plus the callers it forces to change; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with the design still unsettled; 10 = wide blast radius, unclear scope, or a previously reverted attempt`. `scoreDifficulty(task)` (in `scripts/rateTask.ts`) reads only `declaredFiles(task)` and `task.description` — the only two inputs the record offers — and walks these anchors as an ordered decision tree, most-specific first:

   - `files.length === 0` → **1** (typo/comment/constant edit: nothing declared to touch).
   - exactly one non-test file, zero test files, zero enumerated description lines → **2** (one-line/single-file mechanical).
   - exactly one non-test file, one or more test files, zero enumerated description lines → **4** (one file plus its test — unambiguous once a test file is declared alongside it).
   - one subsystem (top-level directory) and at most one enumerated description line → **5** if `files.length <= 4`, else **6** (a few/several files, one subsystem, mechanical/settled).
   - one subsystem but more than one enumerated description line → `min(8, 6 + ceil(enumeratedSteps / 2))` — a single-file or single-subsystem task can still be hard when the description enumerates many unresolved steps; this is what keeps a "hard but atomic" task from being scored as easy, per Goal criterion 2's own example.
   - exactly two subsystems → **7** (one subsystem plus the callers it forces to change).
   - four or more subsystems, or eight or more files → **10** (wide blast radius).
   - three subsystems (the only remaining case) → **9** if the description enumerates 3+ lines, else **8** (crosses subsystems; unsettled vs. settled design, proxied by how many discrete steps the description still lists).

   Anchor 3 ("existing test that already *covers* it, not touched") is not independently reachable — whether an *undeclared* test already covers a file is not observable from `declaredFiles`/`description` at all, so this is a deliberate, documented gap, not a missed case; the ordering above still keeps every other anchor distinct and monotonic in "how much is going on."

6. **Split-worthiness — computed from concrete split points, never from difficulty.** To satisfy Goal criterion 2 (a hard task must not automatically become a high split score) and to guarantee a `splitWorthiness >= 5` task always has usable split points, this plan builds the candidate split points *first*, then derives the score from their count — the reverse of scoring first and hoping points exist:
   - `buildSplitPoints(task)` returns `[]` immediately when `declaredFiles(task).length < 2` — a task touching at most one file cannot be structurally split, no matter how complex its description reads. This is what keeps a "hard but atomic" single-file task's split-worthiness low even when its difficulty (Decision 5) is high, because the two functions never share this file-count-based veto with each other's *output*, only with the same raw input.
   - otherwise, if the description has 2+ enumerated (bullet/numbered) lines, the (deduplicated, trimmed) text of those lines is used as the split points.
   - otherwise, if the files span 2+ top-level directories, each directory becomes one split point, labelled `"<dir>: <comma-joined files in that dir>"`.
   - otherwise `[]` (no usable split points; e.g. 2+ files all under one directory with no enumerated description).
   - `scoreSplitWorthiness(task, points)`: when `points.length < 2`, the score is capped at 4 (`clampScore(min(4, points.length * 2 + 1))`) — this is the "fewer than two concrete split points" cap the review required, and it is why `splitWorthiness >= 5` can only occur when `points.length >= 2`. When `points.length >= 2`, the score is `clampScore(5 + max(0, points.length - 2) + max(0, subsystemCount - 1) + max(0, enumeratedStepCount - points.length))` — the base of 5 plus the threshold guarantees any task with 2+ real split points scores at or above the "split points get printed" line, and the three `max(0, …)` terms add more only for genuinely more split surface (more points, more subsystems, more still-unaccounted-for description lines).
   - `rateTask(task)` computes `splitPoints = buildSplitPoints(task)` and `splitWorthiness = scoreSplitWorthiness(task, splitPoints)` once each; the reported `splitPoints` on the result are `splitPoints` when `splitWorthiness >= SPLIT_POINT_THRESHOLD (5)`, else `[]` — this mirrors the Goal's "a split-worthiness of 5 or more also prints split points" line exactly, and by construction the printed count always equals `splitPoints.length`.

## New file: `skills/rate-task/SKILL.md`

Full content (new file):

```markdown
---
name: rate-task
description: score a task's difficulty and split-worthiness on the 1-10 scale, write both scores back to the task record, and print named split points for /split-task when split-worthiness is 5 or higher. Optional argument: task number(s) to rate. No argument rates every open task.
---

\`\`\`!
node "${CLAUDE_PLUGIN_ROOT}/scripts/rateTask.ts" $ARGUMENTS
\`\`\`
```

(The two literal ```` ``` ```` fence lines above must be written as three backticks with a bare `!` immediately after the opening fence, exactly matching the fence style already used in `skills/pick-a-task/SKILL.md` lines 6 and 9 — the backslashes shown here are only to escape the fence inside this plan's own code block and must not appear in the real file.)

Rationale for keeping the skill body to a single fence: `rateTask.ts`'s own stdout is already the full report (scores plus split points); there is no extra narration for the assistant to add, matching `pick-a-task`'s equally thin shape (a script call is the entire skill body there too).

## New file: `scripts/rateTask.ts`

Full content (new file), 4-space indentation per the project's coding standard:

```ts
// Scores difficulty and split-worthiness (1-10), persists both, and lists split points for /split-task.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { declaredFiles } from "./taskGroups.ts";
import { readTaskLists } from "./getTaskDetails.ts";

export type RatingResult = {
    taskNumber: number;
    difficulty: number;
    splitWorthiness: number;
    splitPoints: string[];
};

const SPLIT_POINT_THRESHOLD = 5;

function clampScore(raw: number): number {
    return Math.min(10, Math.max(1, Math.round(raw)));
}

function isTestFile(path: string): boolean {
    return /(^|\/)tests?\//i.test(path) || /\.test\.[jt]sx?$/i.test(path);
}

function enumeratedLines(description: string): string[] {
    const seen = new Set<string>();
    const points: string[] = [];
    for (const line of description.split("\n")) {
        const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
        if (!match) continue;
        const text = match[1].trim();
        if (seen.has(text)) continue;
        seen.add(text);
        points.push(text);
    }
    return points;
}

function groupFilesByTopLevelDirectory(files: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const file of files) {
        const top = file.split("/")[0];
        const group = grouped.get(top) ?? [];
        group.push(file);
        grouped.set(top, group);
    }
    return grouped;
}

export function scoreDifficulty(task: TaskRecord): number {
    const files = declaredFiles(task);
    const nonTestFiles = files.filter((f) => !isTestFile(f));
    const testFiles = files.filter(isTestFile);
    const subsystemCount = groupFilesByTopLevelDirectory(files).size;
    const enumeratedSteps = enumeratedLines(task.description ?? "").length;

    if (files.length === 0) return 1;
    if (nonTestFiles.length === 1 && testFiles.length === 0 && enumeratedSteps === 0) return 2;
    if (nonTestFiles.length === 1 && testFiles.length >= 1 && enumeratedSteps === 0) return 4;
    if (subsystemCount <= 1 && enumeratedSteps <= 1) return files.length <= 4 ? 5 : 6;
    if (subsystemCount <= 1) return Math.min(8, 6 + Math.ceil(enumeratedSteps / 2));
    if (subsystemCount === 2) return 7;
    if (subsystemCount >= 4 || files.length >= 8) return 10;
    return enumeratedSteps >= 3 ? 9 : 8;
}

export function buildSplitPoints(task: TaskRecord): string[] {
    const files = declaredFiles(task);
    if (files.length < 2) return [];
    const lines = enumeratedLines(task.description ?? "");
    if (lines.length >= 2) return lines;
    const grouped = groupFilesByTopLevelDirectory(files);
    const dirs = [...grouped.keys()];
    return dirs.length >= 2 ? dirs.map((dir) => `${dir}: ${grouped.get(dir)!.join(", ")}`) : [];
}

export function scoreSplitWorthiness(task: TaskRecord, points: string[]): number {
    if (points.length < 2) return clampScore(Math.min(4, points.length * 2 + 1));
    const subsystemCount = groupFilesByTopLevelDirectory(declaredFiles(task)).size;
    const enumeratedStepCount = enumeratedLines(task.description ?? "").length;
    return clampScore(
        SPLIT_POINT_THRESHOLD +
            Math.max(0, points.length - 2) +
            Math.max(0, subsystemCount - 1) +
            Math.max(0, enumeratedStepCount - points.length),
    );
}

export function rateTask(task: TaskRecord): RatingResult {
    const difficulty = scoreDifficulty(task);
    const points = buildSplitPoints(task);
    const splitWorthiness = scoreSplitWorthiness(task, points);
    const splitPoints = splitWorthiness >= SPLIT_POINT_THRESHOLD ? points : [];
    return { taskNumber: task.taskNumber, difficulty, splitWorthiness, splitPoints };
}

export function rateAndPersist(projectRoot: string, taskNumbers: number[]): RatingResult[] {
    const { openTasks } = readTaskLists(projectRoot);
    const openByNumber = new Map(openTasks.map((task) => [task.taskNumber, task]));
    const targets = taskNumbers.length === 0
        ? openTasks
        : taskNumbers.map((number) => {
            const task = openByNumber.get(number);
            if (!task) throw new Error(`not open in tasks.json: ${number}`);
            return task;
        });
    const results = targets.map(rateTask);

    const pair = resolveTaskFiles(projectRoot);
    const tasks = readTaskFile(pair.tasksPath);
    const taskByNumber = new Map(tasks.map((task) => [task.taskNumber, task]));
    for (const result of results) {
        const task = taskByNumber.get(result.taskNumber)!;
        task.difficulty = result.difficulty;
        task.splitWorthiness = result.splitWorthiness;
    }
    writeFileSync(pair.tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    return results;
}

export function formatReport(results: RatingResult[]): string {
    return results.map((result) => {
        const lines = [`task ${result.taskNumber}: difficulty ${result.difficulty}/10, split-worthiness ${result.splitWorthiness}/10`];
        if (result.splitPoints.length > 0) {
            lines.push(`  /split-task ${result.taskNumber} ${result.splitPoints.length} ${result.splitPoints.join(" | ")}`);
            for (const point of result.splitPoints) lines.push(`  - ${point}`);
        }
        return lines.join("\n");
    }).join("\n");
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const numbers = leadingTaskNumbers(process.argv.slice(2));
    let results: RatingResult[];
    try {
        results = rateAndPersist(repoRoot, numbers);
    } catch (error) {
        process.stderr.write(`rateTask: ${(error as Error).message}\n`);
        process.exit(1);
    }
    process.stdout.write(formatReport(results) + "\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

Notes on this content, tied to the brief:
- `readTaskLists` is imported from `scripts/getTaskDetails.ts` and called exactly once per run to fetch every scoring input (Decision 3) — `rateTask.ts` does not re-implement task-list reading for the scoring path.
- `resolveTaskFiles`/`readTaskFile`/`leadingTaskNumbers`/`TaskRecord` are imported from `scripts/taskFiles.ts` and used only for the persistence step, exactly as the brief's Persistence-contract paragraph requires.
- `declaredFiles` is imported from `scripts/taskGroups.ts`, never reimplemented, per Amendment 2.
- The write path (`resolveTaskFiles` → `readTaskFile` → mutate → `writeFileSync(..., JSON.stringify(tasks, null, 2) + "\n")`) mirrors `scripts/taskArchival.ts`'s `archivePublishedTasks` write (that file's lines 86-90), and only `difficulty` and `splitWorthiness` are mutated on the targeted tasks — no other key is touched.
- `taskNumbers.length === 0` rating the full `openTasks` array satisfies "no argument rates every open task."
- The "not open in tasks.json: N" error message on an unknown requested number matches the exact phrasing already used by `scripts/prepareTasks.ts`'s `selectRequestedTasks`.
- `formatReport` is exported so tests can assert on the paste-ready `/split-task` command line without spawning the CLI.

## New file: `tests/rateTask.test.ts`

No tests field is present on this task (or it reads "skip" — the brief carries no explicit tests-field directive), so this is not a TDD write-first exercise; the file below is authored directly as one of the task's three required deliverables and is also the ordinary verification for the scoring/persistence logic. It uses Node's built-in test runner (`node:test` + `node:assert/strict`), matching this repo's established `node --test` suite (per the user's own workflow, this project runs `npm test`, which drives `node --test`, not `bun test`).

Full content (new file), 4-space indentation:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { formatReport, rateAndPersist } from "../scripts/rateTask.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";

const sprawlingTask: TaskRecord = {
    taskNumber: 1,
    title: "Sprawling multi-subsystem task",
    description: [
        "Rework the entire pipeline across several subsystems.",
        "- update the source logic",
        "- update the tests",
        "- update the docs",
        "- update the CLI scripts",
    ].join("\n"),
    files: ["src/foo.ts", "tests/foo.test.ts", "docs/foo.md", "scripts/bar.ts"],
};

const mechanicalTask: TaskRecord = {
    taskNumber: 2,
    title: "One-line mechanical task",
    description: "Rename variable x to y.",
    files: ["src/foo.ts"],
};

const hardAtomicTask: TaskRecord = {
    taskNumber: 3,
    title: "Hard but atomic task",
    description: [
        "Rework the internal state machine in this one file; the transition table interactions are subtle.",
        "- handle the retry-after-timeout edge case",
        "- handle the concurrent-cancel edge case",
        "- handle the partial-write edge case",
    ].join("\n"),
    files: ["src/stateMachine.ts"],
};

const thresholdTask: TaskRecord = {
    taskNumber: 4,
    title: "Two related tweaks to one module",
    description: ["Update the module in two ways.", "- adjust the parser", "- adjust the formatter"].join("\n"),
    files: ["src/foo.ts", "src/bar.ts"],
};

function writeFixture(tasks: TaskRecord[]): string {
    const root = mkdtempSync(join(tmpdir(), "rateTask-"));
    const taskToolsDir = join(root, ".taskTools");
    mkdirSync(taskToolsDir, { recursive: true });
    writeFileSync(join(taskToolsDir, "tasks.json"), JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(join(taskToolsDir, "completedTasks.json"), "[]\n");
    return root;
}

test("rates a sprawling multi-subsystem task as split-worthy with named split points", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const [result] = rateAndPersist(root, [1]);
    assert.equal(result.taskNumber, 1);
    assert.ok(result.splitWorthiness >= 6, `expected split-worthiness >= 6, got ${result.splitWorthiness}`);
    assert.ok(result.splitPoints.length >= 2, `expected at least two split points, got ${result.splitPoints.length}`);
});

test("rates a one-line mechanical task as not split-worthy with no split points", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const [result] = rateAndPersist(root, [2]);
    assert.equal(result.taskNumber, 2);
    assert.ok(result.splitWorthiness < 6, `expected split-worthiness < 6, got ${result.splitWorthiness}`);
    assert.equal(result.splitPoints.length, 0);
});

test("a hard but atomic task scores high difficulty without inflating split-worthiness", () => {
    const root = writeFixture([hardAtomicTask]);
    const [result] = rateAndPersist(root, [3]);
    assert.ok(result.difficulty >= 7, `expected difficulty >= 7, got ${result.difficulty}`);
    assert.ok(result.splitWorthiness < 5, `expected split-worthiness < 5, got ${result.splitWorthiness}`);
    assert.equal(result.splitPoints.length, 0);
});

test("split-worthiness at exactly the threshold still emits at least two split points", () => {
    const root = writeFixture([thresholdTask]);
    const [result] = rateAndPersist(root, [4]);
    assert.equal(result.splitWorthiness, 5);
    assert.ok(result.splitPoints.length >= 2, `expected at least two split points, got ${result.splitPoints.length}`);
});

test("split-worthiness of 5 or more always comes with at least two split points", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask, hardAtomicTask, thresholdTask]);
    const results = rateAndPersist(root, []);
    for (const result of results) {
        if (result.splitWorthiness >= 5) {
            assert.ok(result.splitPoints.length >= 2, `task ${result.taskNumber}: score ${result.splitWorthiness} but only ${result.splitPoints.length} points`);
        }
    }
});

test("report includes a paste-ready split-task command matching the point count", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const results = rateAndPersist(root, [1]);
    const [result] = results;
    const report = formatReport(results);
    assert.ok(
        report.includes(`/split-task ${result.taskNumber} ${result.splitPoints.length} ${result.splitPoints.join(" | ")}`),
        `report did not include a matching /split-task command:\n${report}`,
    );
});

test("persists both scores onto the task records without disturbing other fields", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const originals = new Map([sprawlingTask, mechanicalTask].map((t) => [t.taskNumber, t]));
    const results = rateAndPersist(root, [1, 2]);
    assert.equal(results.length, 2);
    const persisted: TaskRecord[] = JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"));
    for (const result of results) {
        const original = originals.get(result.taskNumber)!;
        const task = persisted.find((t) => t.taskNumber === result.taskNumber);
        assert.ok(task, `task ${result.taskNumber} missing after persist`);
        assert.equal(task!.difficulty, result.difficulty);
        assert.equal(task!.splitWorthiness, result.splitWorthiness);
        assert.equal(task!.title, original.title);
        assert.deepEqual(task!.files, original.files);
    }
});

test("rating with no task numbers rates every open task", () => {
    const root = writeFixture([sprawlingTask, mechanicalTask]);
    const results = rateAndPersist(root, []);
    assert.deepEqual(results.map((r) => r.taskNumber).sort(), [1, 2]);
});
```

Why these cases: the brief's TESTS section specifies exactly the sprawling-vs-mechanical split-worthiness assertions (cases 1 and 2, thresholds stated on the 1-10 scale: `>= 6` and `< 6`). "A hard but atomic task" is the direct test of Goal criterion 2's own worked example, using `hardAtomicTask` — one file, so `buildSplitPoints` returns `[]` by construction (Decision 6), while its enumerated-but-unresolved description drives `scoreDifficulty` (Decision 5) up independently. The threshold test and the "always comes with at least two split points" test are the direct tests of the split-worthiness cap (Decision 6). The paste-ready-command test is the direct test of the `/split-task <taskNum> <numSplits> <guidance>` output shape (Decision 4/6). Persistence is the direct test of Goal criterion 3 ("BOTH scores are written back to the task record"), extended to assert unrelated fields (`title`, `files`) are untouched. The no-argument case is the direct test of Goal criterion 5.

## Files requiring no edit

Every other owned file is read-only reference material for this task and is not modified:
- `scripts/taskFiles.ts` — reused (`readTaskFile`, `resolveTaskFiles`, `leadingTaskNumbers`, `TaskRecord`), not edited.
- `scripts/taskArchival.ts` — its write pattern (`JSON.stringify(..., null, 2) + "\n"`) is mirrored, not edited or imported.
- `scripts/getTaskDetails.ts` — its exported `readTaskLists` is imported and called once per run to fetch scoring inputs (Decision 3); the file itself is not edited.
- `skills/pick-a-task/SKILL.md` — read for the optional-argument shape and to verify the brief's `getTaskDetails.ts` citation; not edited.
- `skills/split-task/SKILL.md` — read to determine the real `/split-task <taskNum> <numSplits> [guidance]` shape that split points must match; not edited.
- `scripts/ownershipKeys.ts` — read in full; concerns repository-manifest ownership (multi-repo occurrence graphs), unrelated to task-record scoring; not used, not edited.
- `scripts/addTaskFiles.ts` — read for its `leadingTaskNumbers`/missing-number error-message conventions, which `rateTask.ts` mirrors; not edited.
- `scripts/prepareTasks.ts` — read for the same CLI conventions (`leadingTaskNumbers(process.argv.slice(2))`, "not open in tasks.json: N" error phrasing); not edited.
- `scripts/taskGroups.ts` — read-only per Amendment 2 ("Treat it as READ-ONLY; it is not this task's to edit"); `declaredFiles` is imported from it, the file itself is untouched.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `npx tsc --noEmit`
   Expected: no output, exit code 0. Confirms the three new files type-check against the existing `TaskRecord` type and imports.

2. `npm test`
   Expected: exit code 0, all tests pass, including the eight new tests in `tests/rateTask.test.ts` (`rates a sprawling multi-subsystem task as split-worthy with named split points`, `rates a one-line mechanical task as not split-worthy with no split points`, `a hard but atomic task scores high difficulty without inflating split-worthiness`, `split-worthiness at exactly the threshold still emits at least two split points`, `split-worthiness of 5 or more always comes with at least two split points`, `report includes a paste-ready split-task command matching the point count`, `persists both scores onto the task records without disturbing other fields`, `rating with no task numbers rates every open task`). Per the user's established workflow this project's suite runs on `node --test`, not `bun test`.

3. `ls skills/rate-task/SKILL.md scripts/rateTask.ts tests/rateTask.test.ts`
   Expected: all three paths listed, confirming the three deliverable files exist at the correct paths.
