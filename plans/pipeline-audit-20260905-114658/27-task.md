# Task 27 plan — read-only health-check script for a tackle-tasks run

## Scope confirmation

- New file only: `scripts/tackleTasksHealthCheck.ts`. Confirmed absent (`find . -iname "*healthCheck*" -not -path "*/archive/*"` returns nothing). Lives directly under `scripts/`, alongside `scripts/prepareTasks.ts` and `scripts/mergeTaskWorktrees.ts` (both standalone CLI scripts with a `main`-function-plus-CLI-guard shape) — matching the task description's "the script is read-only and lives under `scripts/`."
- `scripts/tackle-tasks/shared/sourceRepoLock.ts` — read in full (219 lines). Reused, unmodified:
  - `export function readSourceRepoLock(projectRoot: string): LockFile | null` (line 45) — `LockFile = { owner: LockOwner; acquiredAt: string; heartbeatAt: string }` (line 10), `LockOwner = \`${runId}:${taskNumber}\`` (line 9 type comment).
- `scripts/prepareTasks.ts` — read in full (relevant excerpts, lines 170-505). Reused, unmodified:
  - `export const STAGING_REF = "refs/heads/staging";` (line 182).
  - `export function readStagingTip(repoRoot: string): string | null` (line 186) — returns the staging branch's commit sha, or `null` if the branch is absent.
  - `export function taskWorktreeLeasePath(worktreePath: string): string` (line 269) — returns `` `${worktreePath}.lease` ``, a plain file sitting **beside** the worktree directory under the same parent (`resolveTaskWorktreeConventionDirectory(repoRoot)`), not tracked by git and not listed by `git worktree list` — confirmed by reading `taskWorktreeLeasePath`/`acquireTaskWorktreeLease` (lines 267-341): the lease is a bare `openSync(leasePath, "wx", ...)` file, independent of git's own worktree registry.
  - `export function readTaskWorktreeLeaseOwner(leasePath: string): { pid: number; runId: string } | null` (line 273) — returns `null` on a missing lease file (catches `ENOENT`).
  - `export function resolveTaskWorktreeConventionDirectory(repoRoot: string): string` (line 377) — `join(tmpdir(), "taskTools-wt", \`${basename(repoRoot)}-${hash}\`)`, the same hash-of-realpath convention `createWorktreeForGroup` (line 384) uses to place `join(resolveTaskWorktreeConventionDirectory(repoRoot), \`task-${taskNumber}\`)` — reused here both to derive a task's worktree path from just `repoRoot` and `taskNumber`, and to scan the convention directory directly for lease files git no longer knows about (Step 4 below).
- `scripts/tackle-tasks/shared/checkpoint.ts` — read in full (33 lines). Reused, unmodified:
  - `export function checkpointPath(worktree: string): string` (line 19) — `join(worktree, "plans", "checkpoint.json")`.
  - `export function readCheckpoint(worktree: string): Checkpoint | null` (line 23).
- `scripts/runStepHook.ts` — read the relevant lines (1-9, 279-320, 336-359). Confirmed the run-log naming convention this script's own health-check must independently discover (it does not import from `runStepHook.ts`, which is not built to be imported as a library — it reads the same filesystem convention from the outside):
  - Line 289: `let runDirectory = process.env.RUN_STEP_LOG ? dirname(process.env.RUN_STEP_LOG) : join(process.cwd(), ".taskTools/runs", runStamp());`
  - Line 292: `` const logFile = () => process.env.RUN_STEP_LOG ?? `${runDirectory}${currentTaskNumber === null ? "" : `-task-${currentTaskNumber}`}-run-log.json`; ``
  - A single logical run can write two sibling log files under the **same stamp**: an unnumbered `<stamp>-run-log.json` (written before `currentTaskNumber` is known, or on a continuation pass whose input packet does not carry `taskNumber` at the top level) and a `<stamp>-task-<N>-run-log.json` once the task number is known — confirmed by reading `walkFromStep` (lines 300-320: `currentTaskNumber` is set only when `startPacket.taskNumber !== undefined`, and `runDirectory` can be recomputed from a resumed packet's file path without resetting `currentTaskNumber` to match). Picking a single "newest" file by name can therefore both pick an unrelated task's log and miss half of the requested task's own entries. Step 2 below reads the whole sibling group, not one file.
  - Every run log is a JSON array (`runLogEntries`, written whole via `JSON.stringify(runLogEntries, null, 4)`, plain `writeFileSync`, not atomic) at a path matching `.taskTools/runs/*-run-log.json`.
  - Accepted, not fixed by this task: because the write is a plain `writeFileSync`, a read that lands mid-write (or a log left truncated by a crash) can make `JSON.parse` throw. This task's plan keeps the project's standing no-try/catch, no-fallback rule — a corrupt or mid-write run log throws loudly, naming the file in the stack trace, the same as every other reader in this codebase (`readCheckpoint`, `readSourceRepoLock`, `readTaskFile` all do the same unguarded `JSON.parse`). Swallowing that error to keep the rest of the report would mean adding a `try/catch` this task does not add.
- `.taskTools/runs/` — confirmed live directory holding files matching this convention (e.g. `2026-08-31T10-59-32-17832-run-log.json`, `2026-09-01T14-25-03-70424-task-157-codex-review.log`), via `find .taskTools/runs -maxdepth 2`.
- `node:fs`'s `statfsSync` — confirmed available in this repo's Node runtime (`node -e "console.log(typeof require('node:fs').statfsSync)"` prints `function`; `node --version` reports `v26.6.0`). Returns `{ bavail, bsize, ... }`; free bytes = `bavail * bsize`. No existing disk-space helper exists in this repo to reuse (`grep -rln "statfsSync|statfs|disk.*free|freeSpace" scripts --include="*.ts"` returns nothing) — this is new, minimal code, not a duplicate of something already present.
- No diagram, no `.mmd` file, no entry in `scripts/generateSteps.ts`'s `BLOCKS_BY_OWNER_FOLDER` map: this script is not a pipeline block (it is invoked directly by a human, "before a launch and as the first step of any diagnosis," never by `/run-step`), so it needs no `.template.json` and is not wired into `scripts/steps.json`.

## Steps

Every helper below is `export`ed from `scripts/tackleTasksHealthCheck.ts` so `scripts/tackleTasksHealthCheck.test.ts` can import and test each one directly, in addition to the end-to-end `buildHealthCheckReport` tests in Step 5.

### Step 1 — `listWorktrees`, test-first

`test_listWorktrees_parsesPorcelainOutputIntoPathAndBranch`
- Plain-English behavior: given a repo with the main worktree and one linked worktree checked out on a branch, `listWorktrees` returns one entry per worktree, each with its path and the branch name it has checked out (or `null` for a detached worktree).
- Steps: create a temp repo (`git init`, one commit), add one linked worktree on a new branch via `git worktree add`, call `listWorktrees(repoRoot)`, assert the result has two entries, the second one's `branch` equals the new branch name with no `refs/heads/` prefix.
- Failing assertion first (RED): `listWorktrees` does not exist yet, so the import in the test file fails.
- Minimum code (GREEN), in the new file:

```ts
export type WorktreeEntry = { path: string; branch: string | null };

// git worktree list --porcelain: blank-line-separated stanzas, "worktree <path>" then "branch refs/heads/<name>" or "detached".
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
    const output = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const worktrees: WorktreeEntry[] = [];
    let current: WorktreeEntry | null = null;
    for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (current) worktrees.push(current);
            current = { path: line.slice("worktree ".length), branch: null };
            continue;
        }
        if (line.startsWith("branch ") && current) {
            current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
    }
    if (current) worktrees.push(current);
    return worktrees;
}
```

Test, in `scripts/tackleTasksHealthCheck.test.ts` (see Step 5 for the file's shared imports and `makeFixtureRepo` helper — this test only needs a bare repo, no fixture helper):

```ts
test("test_listWorktrees_parsesPorcelainOutputIntoPathAndBranch", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "list-worktrees-"));
    execFileSync("git", ["-C", repoRoot, "init", "-q"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "test"]);
    writeFileSync(join(repoRoot, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-q", "-m", "init"]);
    const linkedWorktree = join(repoRoot, "linked");
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-q", "-b", "task-1", linkedWorktree]);

    const worktrees = listWorktrees(repoRoot);

    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[1]!.path, linkedWorktree);
    assert.equal(worktrees[1]!.branch, "task-1");
});
```

### Step 2 — `findRunLogGroup`, test-first

Replaces a single-file "newest run log" lookup with one that (a) prefers the requested task's own log when a `taskNumber` is given, and (b) merges every sibling file that shares the same stamp, so a run split across an unnumbered pass and its `-task-N-` continuation (Scope confirmation) is read whole.

`test_findRunLogGroup_prefersTheRequestedTasksLog` / `test_findRunLogGroup_mergesSameStampSiblings` / `test_findRunLogGroup_fallsBackToTheNewestLogWhenNoneMatchTheTask`
- Plain-English behavior: given several run-log files, the group for a requested task is the newest file naming that task, plus any other file sharing its exact stamp, with all of their entries concatenated in filename order; with no task requested (or none found for it), the group is the single newest file's own entries.
- Steps:
  - a `.taskTools/runs/` folder with `2026-01-01T00-00-00-1-task-5-run-log.json` (2 entries) and a later `2026-01-02T00-00-00-2-task-1-run-log.json` (1 entry): requesting task 1 returns only the task-1 file's entry, not task 5's newer-looking but irrelevant file.
  - the same folder plus a same-stamp sibling `2026-01-02T00-00-00-2-run-log.json` (1 entry, no task number): requesting task 1 returns both files' entries concatenated, unnumbered file first.
  - requesting task 9 (present nowhere): falls back to the newest file overall.
- Failing assertion first (RED): `findRunLogGroup` does not exist yet.
- Minimum code (GREEN):

```ts
// Split from -task-N so a numbered file and its unnumbered same-stamp sibling compare equal.
function runLogStamp(fileName: string): string {
    return fileName.replace(/(-task-\d+)?-run-log\.json$/, "");
}

export function findRunLogGroup(runsDirectory: string, taskNumber?: number): { files: string[]; entries: unknown[] } {
    if (!existsSync(runsDirectory)) {
        return { files: [], entries: [] };
    }
    const runLogs = readdirSync(runsDirectory).filter((name) => name.endsWith("-run-log.json"));
    const taskLogs = taskNumber === undefined ? [] : runLogs.filter((name) => name.endsWith(`-task-${taskNumber}-run-log.json`));
    const candidates = taskLogs.length > 0 ? taskLogs : runLogs;
    if (candidates.length === 0) {
        return { files: [], entries: [] };
    }
    const newest = candidates.sort().at(-1)!;
    const stamp = runLogStamp(newest);
    // Sorted alphabetically: an unnumbered file (written before the task number was known) sorts before its "-task-N-" sibling.
    const siblingFiles = runLogs.filter((name) => runLogStamp(name) === stamp).sort();
    const entries = siblingFiles.flatMap((name) => JSON.parse(readFileSync(join(runsDirectory, name), "utf8")) as unknown[]);
    return { files: siblingFiles, entries };
}
```

Tests, in `scripts/tackleTasksHealthCheck.test.ts`:

```ts
function writeRunLog(runsDirectory: string, fileName: string, entries: unknown[]): void {
    mkdirSync(runsDirectory, { recursive: true });
    writeFileSync(join(runsDirectory, fileName), JSON.stringify(entries));
}

test("test_findRunLogGroup_prefersTheRequestedTasksLog", () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-log-group-"));
    writeRunLog(runsDirectory, "2026-01-01T00-00-00-1-task-5-run-log.json", [{ box: "A" }, { box: "B" }]);
    writeRunLog(runsDirectory, "2026-01-02T00-00-00-2-task-1-run-log.json", [{ box: "C" }]);

    const group = findRunLogGroup(runsDirectory, 1);

    assert.deepEqual(group.files, ["2026-01-02T00-00-00-2-task-1-run-log.json"]);
    assert.deepEqual(group.entries, [{ box: "C" }]);
});

test("test_findRunLogGroup_mergesSameStampSiblings", () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-log-group-"));
    writeRunLog(runsDirectory, "2026-01-02T00-00-00-2-run-log.json", [{ box: "PREAMBLE" }]);
    writeRunLog(runsDirectory, "2026-01-02T00-00-00-2-task-1-run-log.json", [{ box: "IMPLEMENT_TASK" }]);

    const group = findRunLogGroup(runsDirectory, 1);

    assert.deepEqual(group.files, ["2026-01-02T00-00-00-2-run-log.json", "2026-01-02T00-00-00-2-task-1-run-log.json"]);
    assert.deepEqual(group.entries, [{ box: "PREAMBLE" }, { box: "IMPLEMENT_TASK" }]);
});

test("test_findRunLogGroup_fallsBackToTheNewestLogWhenNoneMatchTheTask", () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-log-group-"));
    writeRunLog(runsDirectory, "2026-01-01T00-00-00-1-task-5-run-log.json", [{ box: "A" }]);

    const group = findRunLogGroup(runsDirectory, 9);

    assert.deepEqual(group.files, ["2026-01-01T00-00-00-1-task-5-run-log.json"]);
});
```

### Step 3 — `freeBytesOnVolumeOf`, test-first

`test_freeBytesOnVolumeOf_walksUpToTheNearestExistingAncestor`
- Plain-English behavior: given a path that does not exist yet (e.g. a task worktree not yet created), the disk-free check walks up to the nearest existing ancestor directory and reports free space there, instead of throwing.
- Steps: call `freeBytesOnVolumeOf` with a path two levels below a real temp directory that does not itself exist; assert the result is a positive number (the exact byte count is not asserted, since it is host-dependent).
- Failing assertion first (RED): `freeBytesOnVolumeOf` does not exist yet.
- Minimum code (GREEN):

```ts
// statfsSync needs a path that exists; a not-yet-created worktree walks up to whatever ancestor does.
function nearestExistingAncestor(path: string): string {
    let current = path;
    while (!existsSync(current)) {
        current = dirname(current);
    }
    return current;
}

export function freeBytesOnVolumeOf(path: string): number {
    const stats = statfsSync(nearestExistingAncestor(path));
    return stats.bavail * stats.bsize;
}
```

Test, in `scripts/tackleTasksHealthCheck.test.ts`:

```ts
test("test_freeBytesOnVolumeOf_walksUpToTheNearestExistingAncestor", () => {
    const existingRoot = mkdtempSync(join(tmpdir(), "free-bytes-"));
    const notYetCreated = join(existingRoot, "not-created-yet", "task-1");

    const freeBytes = freeBytesOnVolumeOf(notYetCreated);

    assert.ok(freeBytes > 0);
});
```

### Step 4 — `worktreeLeaseReport`, test-first

A lease file (`<worktreePath>.lease`) is a plain file beside the worktree directory, independent of git's own worktree registry (Scope confirmation). A crash between taking the lease and finishing worktree creation, or between removing a worktree and releasing its lease, leaves an orphan lease `git worktree list` never mentions. This box also scans the convention directory directly, so an orphan lease is named instead of silently omitted.

`test_worktreeLeaseReport_namesAnOrphanLeaseWithNoRegisteredWorktree` / `test_worktreeLeaseReport_namesARegisteredWorktreeWithNoLease`
- Plain-English behavior: a lease file under the convention directory whose worktree path `git worktree list` does not know about is reported as an orphan; a registered worktree with no lease file is reported as having no lease. Neither state is silently dropped.
- Steps:
  - a lease file at `<conventionDirectory>/task-9.lease` with no matching git-registered worktree and no `task-9` directory on disk: the report names `task-9`'s path, its owner, and marks it not registered by git and missing on disk.
  - a `listWorktrees` entry with no `.lease` file beside it: the report names that path with `(no lease)`.
- Failing assertion first (RED): `worktreeLeaseReport` does not exist yet.
- Minimum code (GREEN):

```ts
export function worktreeLeaseReport(repoRoot: string, worktrees: WorktreeEntry[]): string[] {
    const registeredPaths = new Set(worktrees.map((w) => w.path));
    const leaseWorktreePaths = new Set(worktrees.filter((w) => w.path !== repoRoot).map((w) => w.path));
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(repoRoot);
    if (existsSync(conventionDirectory)) {
        for (const name of readdirSync(conventionDirectory)) {
            if (name.endsWith(".lease")) {
                leaseWorktreePaths.add(join(conventionDirectory, name.slice(0, -".lease".length)));
            }
        }
    }
    return [...leaseWorktreePaths].sort().map((worktreePath) => {
        const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
        const ownerText = owner ? `pid ${owner.pid}, runId ${owner.runId}` : "(no lease)";
        const registeredText = registeredPaths.has(worktreePath) ? "registered" : "orphan: not registered by git worktree list";
        const onDiskText = existsSync(worktreePath) ? "on disk" : "orphan: worktree directory missing";
        return `${worktreePath}: ${ownerText} [${registeredText}, ${onDiskText}]`;
    });
}
```

Tests, in `scripts/tackleTasksHealthCheck.test.ts`:

```ts
test("test_worktreeLeaseReport_namesAnOrphanLeaseWithNoRegisteredWorktree", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "lease-report-repo-"));
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(repoRoot);
    mkdirSync(conventionDirectory, { recursive: true });
    const orphanWorktree = join(conventionDirectory, "task-9");
    writeFileSync(`${orphanWorktree}.lease`, JSON.stringify({ pid: 111, runId: "run-orphan" }));

    const lines = worktreeLeaseReport(repoRoot, []);

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /pid 111, runId run-orphan/);
    assert.match(lines[0]!, /orphan: not registered by git worktree list/);
    assert.match(lines[0]!, /orphan: worktree directory missing/);
});

test("test_worktreeLeaseReport_namesARegisteredWorktreeWithNoLease", () => {
    const repoRoot = "/repo";
    const worktrees: WorktreeEntry[] = [{ path: "/repo", branch: "main" }, { path: "/repo-worktrees/task-1", branch: "task-1" }];

    const lines = worktreeLeaseReport(repoRoot, worktrees);

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\(no lease\)/);
    assert.doesNotMatch(lines[0]!, /orphan/);
});
```

(The second test never touches disk, so it stays fast and never trips `readTaskWorktreeLeaseOwner`'s `ENOENT` path against a fixture; `existsSync("/repo-worktrees/task-1")` is `false` on any real machine, but that only affects the "on disk" marker this test does not assert on.)

### Step 5 — `buildHealthCheckReport`, test-first, wiring everything together

`test_buildHealthCheckReport_namesEverySection`
- Plain-English behavior: against a fixture repo carrying a source lock, one linked worktree with a lease and a checkpoint, one linked worktree that actually has `staging` checked out, and a run log, the report prints one clearly labeled section per required item: current branch, worktree list, staging tip and its real checkout owner, source lock, worktree leases, the requested task's run-log entries (last 5), the task worktree's checkpoint, and disk free.
- Steps (as comments in the test body):
  - build a temp git repo with one commit.
  - create a **second** linked worktree that checks out `staging` itself (`git worktree add <path> staging`, no `-b`), proving the report can name a real owner, not just print the "none" case.
  - add a linked worktree for task 1 at the path `resolveTaskWorktreeConventionDirectory(repoRoot)/task-1` and write a `.lease` file beside it.
  - write a source lock file at `<repoRoot>/.git/taskTools-source.lock`.
  - write a `.taskTools/runs/<stamp>-task-1-run-log.json` holding an array of 6 entries.
  - write `plans/checkpoint.json` inside the task worktree.
  - call `buildHealthCheckReport(repoRoot, 1)`.
  - assert the output contains each section's header string, the real staging worktree's path as the checkout owner, the lease's `runId`, only the last 5 of the 6 run-log entries, and the checkpoint's `block` field.
- A second test, `test_buildHealthCheckReport_reportsNoOwnerWhenNoWorktreeHasStagingCheckedOut`, proves the other branch of the same line: a fixture with no worktree on `staging` prints the explicit no-owner text, not a false positive.
- Failing assertion first (RED): `buildHealthCheckReport` does not exist yet.
- Minimum code (GREEN) — the full file, `scripts/tackleTasksHealthCheck.ts` (Steps 1-4's exports plus this function and the CLI guard):

```ts
// Prints, in one read-only pass, everything /run-step diagnosis needs before touching a live run.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceRepoLock } from "./tackle-tasks/shared/sourceRepoLock.ts";
import { readCheckpoint } from "./tackle-tasks/shared/checkpoint.ts";
import { readStagingTip, readTaskWorktreeLeaseOwner, resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath } from "./prepareTasks.ts";

export type WorktreeEntry = { path: string; branch: string | null };

// git worktree list --porcelain: blank-line-separated stanzas, "worktree <path>" then "branch refs/heads/<name>" or "detached".
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
    const output = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const worktrees: WorktreeEntry[] = [];
    let current: WorktreeEntry | null = null;
    for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (current) worktrees.push(current);
            current = { path: line.slice("worktree ".length), branch: null };
            continue;
        }
        if (line.startsWith("branch ") && current) {
            current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
    }
    if (current) worktrees.push(current);
    return worktrees;
}

// Split from -task-N so a numbered file and its unnumbered same-stamp sibling compare equal.
function runLogStamp(fileName: string): string {
    return fileName.replace(/(-task-\d+)?-run-log\.json$/, "");
}

export function findRunLogGroup(runsDirectory: string, taskNumber?: number): { files: string[]; entries: unknown[] } {
    if (!existsSync(runsDirectory)) {
        return { files: [], entries: [] };
    }
    const runLogs = readdirSync(runsDirectory).filter((name) => name.endsWith("-run-log.json"));
    const taskLogs = taskNumber === undefined ? [] : runLogs.filter((name) => name.endsWith(`-task-${taskNumber}-run-log.json`));
    const candidates = taskLogs.length > 0 ? taskLogs : runLogs;
    if (candidates.length === 0) {
        return { files: [], entries: [] };
    }
    const newest = candidates.sort().at(-1)!;
    const stamp = runLogStamp(newest);
    // Sorted alphabetically: an unnumbered file (written before the task number was known) sorts before its "-task-N-" sibling.
    const siblingFiles = runLogs.filter((name) => runLogStamp(name) === stamp).sort();
    const entries = siblingFiles.flatMap((name) => JSON.parse(readFileSync(join(runsDirectory, name), "utf8")) as unknown[]);
    return { files: siblingFiles, entries };
}

// statfsSync needs a path that exists; a not-yet-created worktree walks up to whatever ancestor does.
function nearestExistingAncestor(path: string): string {
    let current = path;
    while (!existsSync(current)) {
        current = dirname(current);
    }
    return current;
}

export function freeBytesOnVolumeOf(path: string): number {
    const stats = statfsSync(nearestExistingAncestor(path));
    return stats.bavail * stats.bsize;
}

export function worktreeLeaseReport(repoRoot: string, worktrees: WorktreeEntry[]): string[] {
    const registeredPaths = new Set(worktrees.map((w) => w.path));
    const leaseWorktreePaths = new Set(worktrees.filter((w) => w.path !== repoRoot).map((w) => w.path));
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(repoRoot);
    if (existsSync(conventionDirectory)) {
        for (const name of readdirSync(conventionDirectory)) {
            if (name.endsWith(".lease")) {
                leaseWorktreePaths.add(join(conventionDirectory, name.slice(0, -".lease".length)));
            }
        }
    }
    return [...leaseWorktreePaths].sort().map((worktreePath) => {
        const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
        const ownerText = owner ? `pid ${owner.pid}, runId ${owner.runId}` : "(no lease)";
        const registeredText = registeredPaths.has(worktreePath) ? "registered" : "orphan: not registered by git worktree list";
        const onDiskText = existsSync(worktreePath) ? "on disk" : "orphan: worktree directory missing";
        return `${worktreePath}: ${ownerText} [${registeredText}, ${onDiskText}]`;
    });
}

export function buildHealthCheckReport(repoRoot: string, taskNumber?: number): string {
    const sections: string[] = [];

    const currentBranch = execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], { encoding: "utf8" }).trim();
    sections.push(`== current branch ==\n${currentBranch || "(detached HEAD)"}`);

    const worktrees = listWorktrees(repoRoot);
    sections.push(`== git worktree list ==\n${worktrees.map((w) => `${w.path} [${w.branch ?? "detached"}]`).join("\n")}`);

    const stagingTip = readStagingTip(repoRoot);
    const stagingWorktree = worktrees.find((w) => w.branch === "staging");
    sections.push([
        "== staging tip ==",
        `tip: ${stagingTip ?? "(no staging branch)"}`,
        `checked out by: ${stagingWorktree ? stagingWorktree.path : "no worktree has it checked out"}`,
    ].join("\n"));

    const sourceLock = readSourceRepoLock(repoRoot);
    sections.push(`== source repo lock ==\n${sourceLock ? JSON.stringify(sourceLock) : "(no lock held)"}`);

    const leaseLines = worktreeLeaseReport(repoRoot, worktrees);
    sections.push(`== worktree leases ==\n${leaseLines.length > 0 ? leaseLines.join("\n") : "(no linked worktrees, no lease files)"}`);

    const runsDirectory = join(repoRoot, ".taskTools/runs");
    const runLogGroup = findRunLogGroup(runsDirectory, taskNumber);
    sections.push([
        "== run log (last 5 entries) ==",
        runLogGroup.files.length > 0 ? runLogGroup.files.join(", ") : "(no run logs found)",
        ...(runLogGroup.files.length > 0 ? [JSON.stringify(runLogGroup.entries.slice(-5), null, 2)] : []),
    ].join("\n"));

    if (taskNumber !== undefined) {
        const taskWorktree = join(resolveTaskWorktreeConventionDirectory(repoRoot), `task-${taskNumber}`);
        const checkpoint = existsSync(taskWorktree) ? readCheckpoint(taskWorktree) : null;
        sections.push(`== checkpoint (task ${taskNumber}) ==\n${checkpoint ? JSON.stringify(checkpoint, null, 2) : "(no checkpoint found)"}`);

        const freeBytes = freeBytesOnVolumeOf(taskWorktree);
        sections.push(`== disk free ==\n${taskWorktree}: ${freeBytes} bytes free`);
    } else {
        const freeBytes = freeBytesOnVolumeOf(repoRoot);
        sections.push(`== disk free ==\n${repoRoot}: ${freeBytes} bytes free`);
    }

    return sections.join("\n\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    const [repoRoot, taskNumberArgument] = process.argv.slice(2);
    if (!repoRoot) throw new Error("usage: node scripts/tackleTasksHealthCheck.ts <repoRoot> [taskNumber]");
    const taskNumber = taskNumberArgument === undefined ? undefined : Number(taskNumberArgument);
    console.log(buildHealthCheckReport(repoRoot, taskNumber));
}
```

Note: the run-log section header changed from "newest run log" to "run log" (no longer just one file) to match what it now actually reports — the committed section name a diagnosing human greps for; keep this wording change in the implementation, not just this plan.

Create `scripts/tackleTasksHealthCheck.test.ts` (full file, combining every step above):

```ts
// Behavioral checks for tackleTasksHealthCheck.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildHealthCheckReport, findRunLogGroup, freeBytesOnVolumeOf, listWorktrees, worktreeLeaseReport,
    type WorktreeEntry,
} from "./tackleTasksHealthCheck.ts";
import { resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath } from "./prepareTasks.ts";

function initFixtureRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "health-check-repo-"));
    execFileSync("git", ["-C", repoRoot, "init", "-q"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "test"]);
    writeFileSync(join(repoRoot, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-q", "-m", "init"]);
    return repoRoot;
}

test("test_listWorktrees_parsesPorcelainOutputIntoPathAndBranch", () => {
    const repoRoot = initFixtureRepo();
    const linkedWorktree = join(repoRoot, "linked");
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-q", "-b", "task-1", linkedWorktree]);

    const worktrees = listWorktrees(repoRoot);

    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[1]!.path, linkedWorktree);
    assert.equal(worktrees[1]!.branch, "task-1");
});

function writeRunLog(runsDirectory: string, fileName: string, entries: unknown[]): void {
    mkdirSync(runsDirectory, { recursive: true });
    writeFileSync(join(runsDirectory, fileName), JSON.stringify(entries));
}

test("test_findRunLogGroup_prefersTheRequestedTasksLog", () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-log-group-"));
    writeRunLog(runsDirectory, "2026-01-01T00-00-00-1-task-5-run-log.json", [{ box: "A" }, { box: "B" }]);
    writeRunLog(runsDirectory, "2026-01-02T00-00-00-2-task-1-run-log.json", [{ box: "C" }]);

    const group = findRunLogGroup(runsDirectory, 1);

    assert.deepEqual(group.files, ["2026-01-02T00-00-00-2-task-1-run-log.json"]);
    assert.deepEqual(group.entries, [{ box: "C" }]);
});

test("test_findRunLogGroup_mergesSameStampSiblings", () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-log-group-"));
    writeRunLog(runsDirectory, "2026-01-02T00-00-00-2-run-log.json", [{ box: "PREAMBLE" }]);
    writeRunLog(runsDirectory, "2026-01-02T00-00-00-2-task-1-run-log.json", [{ box: "IMPLEMENT_TASK" }]);

    const group = findRunLogGroup(runsDirectory, 1);

    assert.deepEqual(group.files, ["2026-01-02T00-00-00-2-run-log.json", "2026-01-02T00-00-00-2-task-1-run-log.json"]);
    assert.deepEqual(group.entries, [{ box: "PREAMBLE" }, { box: "IMPLEMENT_TASK" }]);
});

test("test_findRunLogGroup_fallsBackToTheNewestLogWhenNoneMatchTheTask", () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-log-group-"));
    writeRunLog(runsDirectory, "2026-01-01T00-00-00-1-task-5-run-log.json", [{ box: "A" }]);

    const group = findRunLogGroup(runsDirectory, 9);

    assert.deepEqual(group.files, ["2026-01-01T00-00-00-1-task-5-run-log.json"]);
});

test("test_freeBytesOnVolumeOf_walksUpToTheNearestExistingAncestor", () => {
    const existingRoot = mkdtempSync(join(tmpdir(), "free-bytes-"));
    const notYetCreated = join(existingRoot, "not-created-yet", "task-1");

    const freeBytes = freeBytesOnVolumeOf(notYetCreated);

    assert.ok(freeBytes > 0);
});

test("test_worktreeLeaseReport_namesAnOrphanLeaseWithNoRegisteredWorktree", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "lease-report-repo-"));
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(repoRoot);
    mkdirSync(conventionDirectory, { recursive: true });
    const orphanWorktree = join(conventionDirectory, "task-9");
    writeFileSync(`${orphanWorktree}.lease`, JSON.stringify({ pid: 111, runId: "run-orphan" }));

    const lines = worktreeLeaseReport(repoRoot, []);

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /pid 111, runId run-orphan/);
    assert.match(lines[0]!, /orphan: not registered by git worktree list/);
    assert.match(lines[0]!, /orphan: worktree directory missing/);
});

test("test_worktreeLeaseReport_namesARegisteredWorktreeWithNoLease", () => {
    const repoRoot = "/repo";
    const worktrees: WorktreeEntry[] = [{ path: "/repo", branch: "main" }, { path: "/repo-worktrees/task-1", branch: "task-1" }];

    const lines = worktreeLeaseReport(repoRoot, worktrees);

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\(no lease\)/);
    assert.doesNotMatch(lines[0]!, /orphan/);
});

function makeFixtureRepoWithStagingWorktree(): string {
    const repoRoot = initFixtureRepo();
    execFileSync("git", ["-C", repoRoot, "branch", "staging"]);
    const stagingWorktree = join(repoRoot, "staging-worktree");
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-q", stagingWorktree, "staging"]);

    const taskWorktree = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    mkdirSync(dirname(taskWorktree), { recursive: true });
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-q", "-b", "task-1", taskWorktree]);
    writeFileSync(taskWorktreeLeasePath(taskWorktree), JSON.stringify({ pid: 12345, runId: "run-9" }));
    mkdirSync(join(taskWorktree, "plans"), { recursive: true });
    writeFileSync(join(taskWorktree, "plans/checkpoint.json"), JSON.stringify({
        taskNumber: 1, passId: "p1", runId: "run-9", projectRoot: repoRoot, block: "IMPLEMENT_TASK",
        input: "", state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    }));

    writeFileSync(join(repoRoot, ".git/taskTools-source.lock"), JSON.stringify({
        owner: "run-9:1", acquiredAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:00:00.000Z",
    }));

    const entries = Array.from({ length: 6 }, (_, i) => ({ box: `BOX_${i}` }));
    writeRunLog(join(repoRoot, ".taskTools/runs"), "2026-01-01T00-00-00-1-task-1-run-log.json", entries);

    return repoRoot;
}

test("test_buildHealthCheckReport_namesEverySection", () => {
    const repoRoot = makeFixtureRepoWithStagingWorktree();
    const report = buildHealthCheckReport(repoRoot, 1);
    for (const header of [
        "== current branch ==", "== git worktree list ==", "== staging tip ==", "== source repo lock ==",
        "== worktree leases ==", "== run log (last 5 entries) ==", "== checkpoint (task 1) ==", "== disk free ==",
    ]) {
        assert.ok(report.includes(header), `missing section "${header}"`);
    }
    assert.match(report, /checked out by: .*staging-worktree/);
    assert.match(report, /runId run-9/);
    assert.match(report, /"owner":"run-9:1"|"owner": "run-9:1"/);
    assert.doesNotMatch(report, /BOX_0"/); // the oldest of 6 entries is dropped by the last-5 slice
    assert.match(report, /BOX_5/);
    assert.match(report, /"block": "IMPLEMENT_TASK"/);
});

test("test_buildHealthCheckReport_reportsNoOwnerWhenNoWorktreeHasStagingCheckedOut", () => {
    const repoRoot = initFixtureRepo();

    const report = buildHealthCheckReport(repoRoot);

    assert.match(report, /checked out by: no worktree has it checked out/);
});

test("test_buildHealthCheckReport_omitsTaskSectionsWhenNoTaskNumberIsGiven", () => {
    const repoRoot = makeFixtureRepoWithStagingWorktree();
    const report = buildHealthCheckReport(repoRoot);
    assert.doesNotMatch(report, /== checkpoint/);
    assert.match(report, /== disk free ==/);
});
```

## Verification

```sh
cd /Users/matkatmusicllc/Programming/taskTools-86
node --test scripts/tackleTasksHealthCheck.test.ts
```
Expected: all 11 tests pass (`listWorktrees` x1, `findRunLogGroup` x3, `freeBytesOnVolumeOf` x1, `worktreeLeaseReport` x2, `buildHealthCheckReport` x3, plus the shared `initFixtureRepo`/`writeRunLog`/`makeFixtureRepoWithStagingWorktree` helpers used across them).

```sh
node --no-inspect scripts/tackleTasksHealthCheck.ts /Users/matkatmusicllc/Programming/taskTools-86
```
Expected: prints all sections except the task-scoped checkpoint section, with a real current branch, a real `git worktree list`, and a real disk-free number, with no error and no file modified (`git status --short` unchanged before/after this command).

Full suite:
```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```
Expected: `all passing`.

## Draft on disk from another session

Uncommitted work from another session (task-list items 30 to 32) overlaps this plan:
- scripts/pipeline/health-check.sh (untracked): a bash snapshot of branch, worktree list, checkpoint, lock and lease files, last 5 run-log entries, df.
- This plan owns the health check. Keep the bash file only if this plan's TypeScript script does not cover a section it prints; otherwise comment its body out and leave a one-line pointer to the script this plan adds.
This plan is the spec. Before step 1, read that draft. Keep only what this plan's steps produce. Comment out the rest; never delete it. Do not state that the edits are the result of the draft.
