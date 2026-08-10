# Task 86 Codex audit fixes — remaining items after `b6e9e9a`

Commit `b6e9e9a` completed C86-01 and C86-14 and added the production changes for C86-08. Two audit items remain incomplete:

- C86-08 — add the three missing concurrency/boundary regressions and make the archival failure injection use the production atomic writer;
- C86-15 — make the conflict matrix reach the merge stage before asserting that both source task refs are retained.

The old/new snippets below target commit `b6e9e9a`. Line numbers on each **Old** label are the current lines before this plan is applied. Apply the changes in document order; later line numbers will move as earlier tests are inserted.

## C86-08 — complete the task-state concurrency regression matrix

The production implementation is now correctly shaped:

- every script resolves `tasks.json` before deriving the lock path;
- `seedTaskFilesIfAbsent` locks and publishes each JSON file atomically;
- `prepareTasks` re-reads task state while holding the canonical lock immediately before publishing `run-arguments.json`;
- `task.workflow.js` rejects a missing `sourceRoot` at module entry;
- archival publishes the completed record first and retries idempotently.

Do not rewrite those production paths. Add the missing tests below so future changes cannot silently remove those guarantees.

### `tests/taskFiles.test.ts`: exercise concurrent first-run seeding in separate processes

**Old — current `tests/taskFiles.test.ts:2-7`:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadingTaskNumbers, resolveTaskFiles, seedTaskFilesIfAbsent } from "../scripts/taskFiles.ts";
```

**New:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { leadingTaskNumbers, resolveTaskFiles, seedTaskFilesIfAbsent } from "../scripts/taskFiles.ts";
```

**Old insertion point — current `tests/taskFiles.test.ts:57-69`:**

```ts
test("test_seedCreatesBothFilesWithEmptyArrays", () => {
  // Scenario: first task creation in a fresh project generates both task files.  Steps: the project root is empty; the resolved pair is the .taskTools/ default.
  const root = makeEmptyProjectRoot();
  const pair = resolveTaskFiles(root);
  // seeding creates both files, each holding an empty JSON array.
  seedTaskFilesIfAbsent(pair);
  assert.deepEqual(JSON.parse(readFileSync(pair.tasksPath, "utf8")), []);
  assert.deepEqual(JSON.parse(readFileSync(pair.completedTasksPath, "utf8")), []);
  // seeding again after a task exists must leave the existing content intact.
  writeFileSync(pair.tasksPath, JSON.stringify([{ taskNumber: 1, title: "t" }]) + "\n");
  seedTaskFilesIfAbsent(pair);
  assert.equal(JSON.parse(readFileSync(pair.tasksPath, "utf8")).length, 1);
});
```

**New — retain that test and add this immediately after it:**

```ts
test("concurrent first-run seeders leave both task files as valid JSON", async () => {
  const root = makeEmptyProjectRoot();
  const startFile = join(root, "start");
  const taskFilesModuleUrl = pathToFileURL(
    join(import.meta.dirname, "..", "scripts", "taskFiles.ts"),
  ).href;
  const childSource = `
    import { existsSync } from "node:fs";
    import { resolveTaskFiles, seedTaskFilesIfAbsent } from ${JSON.stringify(taskFilesModuleUrl)};
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(wait, 0, 0, 10);
    seedTaskFilesIfAbsent(resolveTaskFiles(${JSON.stringify(root)}));
  `;

  try {
    const children = Array.from({ length: 16 }, () =>
      spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        cwd: root,
        stdio: "inherit",
      }),
    );
    const exits = children.map((child) => once(child, "exit"));
    writeFileSync(startFile, "go\n");

    for (const [code, signal] of await Promise.all(exits)) {
      assert.equal(signal, null);
      assert.equal(code, 0);
    }

    const pair = resolveTaskFiles(root);
    assert.deepEqual(JSON.parse(readFileSync(pair.tasksPath, "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync(pair.completedTasksPath, "utf8")), []);
    assert.equal(existsSync(join(root, ".taskTools", "task-state.lock")), false);
    assert.equal(
      readdirSync(join(root, ".taskTools")).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

This must use processes, not `Promise.all` around synchronous calls in one process; otherwise the test never creates real lock contention.

### `tests/taskArchival.test.ts`: keep the injected successful publication atomic

The existing retry test proves the correct archive-first state, but its injected writer uses `writeFileSync` directly. Delegate successful writes to `writeJsonAtomically` so the test exercises the same publication primitive as production.

**Old — current `tests/taskArchival.test.ts:7-11`:**

```ts
import {
    archivePublishedTasks,
    summarizeTaskMergeResults,
    type RawTaskRepoOutcome,
} from "../scripts/taskArchival.ts";
```

**New:**

```ts
import {
    archivePublishedTasks,
    summarizeTaskMergeResults,
    type RawTaskRepoOutcome,
} from "../scripts/taskArchival.ts";
import { writeJsonAtomically } from "../scripts/taskStateLock.ts";
```

**Old — current `tests/taskArchival.test.ts:162-167`:**

```ts
    let callCount = 0;
    const flakyWriteJson = (path: string, value: unknown): void => {
        callCount++;
        if (callCount === 2) throw new Error("disk full");
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    };
```

**New:**

```ts
    let callCount = 0;
    const flakyWriteJson = (path: string, value: unknown): void => {
        callCount++;
        if (callCount === 2) throw new Error("disk full");
        writeJsonAtomically(path, value);
    };
```

Keep the assertions at current lines 169-177 unchanged: after the injected second-write failure the task must exist once in `completedTasks.json` and still exist in `tasks.json`; a normal retry must remove it from `tasks.json` without duplicating it in the archive.

### `tests/prepareTasks.test.ts`: prove a locked state change is reflected at publication

This regression must start the real CLI from a stale pre-lock snapshot, hold the canonical lock in a separate process, publish a widened task while holding that lock, and only then allow `prepareTasks` to acquire the lock. Assert both the CLI JSON and `.taskTools/run-arguments.json`; checking only one leaves the other publication surface unprotected.

**Old — current `tests/prepareTasks.test.ts:2-17`:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";
```

**New:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";
```

**Old insertion point — current `tests/prepareTasks.test.ts:263-268`:**

```ts
    assert.notEqual(group1.worktree, group2.worktree);
    assert.match(group1.worktree, /task-1$/);
    assert.match(group2.worktree, /task-2$/);
    assert.equal(group1.branch, "task-1");
    assert.equal(group2.branch, "task-2");
});
```

**New — retain that test and add the following helpers and regression after it:**

```ts
type PipelineView = {
    groups: Array<{ tasks: Array<{ number: number; files: string[] }> }>;
};

function captureSuccessfulChild(child: ChildProcess): Promise<string> {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    return (async () => {
        const [code, signal] = await once(child, "exit");
        if (code !== 0 || signal !== null) {
            throw new Error(`child failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`);
        }
        return stdout;
    })();
}

async function waitForPath(path: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function filesFor(pipeline: PipelineView, taskNumber: number): string[] {
    return pipeline.groups
        .flatMap((group) => group.tasks)
        .find((task) => task.number === taskNumber)!.files;
}

test("prepareTasks publishes a widening that lands under the task-state lock", async () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskNumber = 1;
    const taskDirectory = join(repoRoot, ".taskTools");
    const tasksPath = join(taskDirectory, "tasks.json");
    const readyFile = join(repoRoot, "widener-ready");
    const releaseFile = join(repoRoot, "release-widener");
    const worktreePath = join(tmpdir(), "taskTools-wt", basename(repoRoot), `task-${taskNumber}`);
    let widener: ChildProcess | undefined;
    let prepare: ChildProcess | undefined;

    try {
        writeFileSync(join(repoRoot, "existing.ts"), "existing\n");
        writeFileSync(join(repoRoot, "widened.ts"), "widened\n");
        git(repoRoot, "add", "existing.ts", "widened.ts");
        git(repoRoot, "commit", "-q", "-m", "add task files");
        mkdirSync(taskDirectory, { recursive: true });
        writeFileSync(tasksPath, JSON.stringify([
            { taskNumber, title: "fixture", files: ["existing.ts"], blockedBy: [] },
        ]));
        writeFileSync(join(taskDirectory, "completedTasks.json"), "[]\n");
        git(repoRoot, "remote", "add", "origin", repoRoot);

        const lockModuleUrl = pathToFileURL(
            join(import.meta.dirname, "..", "scripts", "taskStateLock.ts"),
        ).href;
        const widenerSource = `
          import { existsSync, readFileSync, writeFileSync } from "node:fs";
          import { withTaskStateLock, writeJsonAtomically } from ${JSON.stringify(lockModuleUrl)};
          const wait = new Int32Array(new SharedArrayBuffer(4));
          const tasksPath = ${JSON.stringify(tasksPath)};
          withTaskStateLock(tasksPath, () => {
            writeFileSync(${JSON.stringify(readyFile)}, "ready\\n");
            while (!existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(wait, 0, 0, 10);
            const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
            tasks[0].files.push("widened.ts");
            writeJsonAtomically(tasksPath, tasks);
          });
        `;
        widener = spawn(process.execPath, ["--input-type=module", "--eval", widenerSource], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const widenerDone = captureSuccessfulChild(widener);
        await waitForPath(readyFile);

        prepare = spawn(
            process.execPath,
            [join(import.meta.dirname, "..", "scripts", "prepareTasks.ts"), String(taskNumber)],
            { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        const prepareDone = captureSuccessfulChild(prepare);

        // Worktree creation happens before prepareTasks attempts the publication lock.
        // Seeing the worktree proves the CLI built its original snapshot and reached that boundary.
        await waitForPath(worktreePath);
        writeFileSync(releaseFile, "go\n");

        await widenerDone;
        const emitted = JSON.parse(await prepareDone) as PipelineView;
        const published = JSON.parse(
            readFileSync(join(taskDirectory, "run-arguments.json"), "utf8"),
        ) as PipelineView;
        assert.deepEqual(filesFor(emitted, taskNumber), ["existing.ts", "widened.ts"]);
        assert.deepEqual(filesFor(published, taskNumber), ["existing.ts", "widened.ts"]);
    } finally {
        if (!existsSync(releaseFile)) writeFileSync(releaseFile, "cleanup\n");
        widener?.kill();
        prepare?.kill();
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});
```

The separate lock-holding process is deliberate. It guarantees `prepareTasks` constructs from the old bytes, then observes the new bytes only at the locked publication boundary. A test that edits `tasks.json` before starting the CLI does not cover the race.

### `tests/taskWorkflowPlanImplementStage.test.ts`: reject missing `sourceRoot` before any mutation

**Old insertion point — current `tests/taskWorkflowPlanImplementStage.test.ts:220-224`:**

```ts
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
```

**New — retain that closing block and add this test after it:**

```ts
test('plan+implement rejects missing sourceRoot before source or worktree mutation', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const sourceHead = git(root, 'rev-parse', 'HEAD')
    const sourceStatus = git(root, 'status', '--porcelain')
    const worktreeHead = git(group.worktree, 'rev-parse', 'HEAD')
    const worktreeStatus = git(group.worktree, 'status', '--porcelain')
    let agentRan = false

    await assert.rejects(
      runTaskWorkflowAtRealScriptPath({
        task: task.taskNumber,
        stage: 'plan+implement',
        typecheckCommand: prepared.typecheckCommand,
        worktree: group.worktree,
        // sourceRoot intentionally omitted
      }, async () => {
        agentRan = true
        throw new Error('agent must not run')
      }),
      /no "sourceRoot" in args/,
    )

    assert.equal(agentRan, false)
    assert.equal(git(root, 'rev-parse', 'HEAD'), sourceHead)
    assert.equal(git(root, 'status', '--porcelain'), sourceStatus)
    assert.equal(git(group.worktree, 'rev-parse', 'HEAD'), worktreeHead)
    assert.equal(git(group.worktree, 'status', '--porcelain'), worktreeStatus)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
```

## C86-15 — make the orchestration conflict observable production-valid

The production-CLI fixtures, rejection gate, root-success file assertion, and success cleanup assertions are now present. The remaining conflict test stops at `rebase-test`. At that point `mergeTaskDeepestFirst` has never run, so the canonical source submodule has not fetched `task-N`; adding a `vendor` assertion to the current test would fail for the wrong reason.

Move the source-side conflicting commit until after a green `rebase-test`, then launch the real `merge` stage. `mergeTaskDeepestFirst` fetches the task branch into the canonical source submodule before its rebase attempt, so the ensuing conflict can validly prove that neither root nor source-submodule task refs were cleaned up.

### `tests/runMergePhase.test.ts`: type the real CLI helper and use the active Node executable

**Old — current `tests/runMergePhase.test.ts:10`:**

```ts
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest } from "../scripts/prepareTasks.ts";
```

**New:**

```ts
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest, type WorkflowArguments } from "../scripts/prepareTasks.ts";
```

**Old — current `tests/runMergePhase.test.ts:350-358`:**

```ts
// Runs the real prepareTasks.ts CLI, so fixtures exercise the same origin-gated preparation path as production.
const prepareThroughCli = (root: string, taskNumber: number): any => {
    const stdout = execFileSync(
        "node",
        [join(REPO_ROOT, "scripts", "prepareTasks.ts"), String(taskNumber)],
        { cwd: root, encoding: "utf8" },
    );
    return JSON.parse(stdout);
};
```

**New:**

```ts
type PreparedPipeline = WorkflowArguments & {
    repositoryManifest: RepositoryManifest;
};

// Runs the real prepareTasks.ts CLI, so fixtures exercise the same origin-gated preparation path as production.
const prepareThroughCli = (root: string, taskNumber: number): PreparedPipeline => {
    const stdout = execFileSync(
        process.execPath,
        [join(REPO_ROOT, "scripts", "prepareTasks.ts"), String(taskNumber)],
        { cwd: root, encoding: "utf8" },
    );
    return JSON.parse(stdout) as PreparedPipeline;
};
```

At current `tests/runMergePhase.test.ts:741-742`, the typed return makes the `group` lookup possibly undefined. Replace:

```ts
    const group = prepared.groups.find((entry: { tasks: { number: number }[] }) => entry.tasks[0]?.number === taskNumber);
    const worktreePath = group.worktree;
```

with:

```ts
    const group = prepared.groups.find((entry) => entry.tasks[0]?.number === taskNumber);
    if (!group) throw new Error(`prepareTasks did not return task ${taskNumber}`);
    const worktreePath = group.worktree;
```

Apply the same replacement to the root-only fixture at current `tests/runMergePhase.test.ts:387-388`.

### `tests/runMergePhase.test.ts`: replace the rebase-only conflict scenario with a merge-stage conflict

**Old — current `tests/runMergePhase.test.ts:826-903`:**

```ts
test("test_endToEndQueueFeedsARealSubmoduleRebaseConflictIntoRecordStageOutcomeAndBuildMergeReport", async () => {
    const taskNumber = 9104;
    const trace: string[] = [];
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor"]);
    const { root, worktreePath, submoduleOrigin, repositoryManifest, prepared } = fixture;
    trace.push("prepare");
    try {
        const worktreeVendorPath = join(worktreePath, "vendor");
        const mainVendorPath = join(root, "vendor");

        let queue = createMergeQueue();

        const planEnvelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedPlanImplementAgent(taskNumber, worktreePath, "vendor", () => {
                writeFileSync(join(worktreeVendorPath, "seed.txt"), "from-worktree\n");
                git(worktreeVendorPath, "add", "seed.txt");
                git(worktreeVendorPath, "commit", "-q", "-m", "worktree edit");
            }),
        );
        trace.push("notification:plan+implement");
        const consumedPlan = consumeTaskWorkflowResult(queue, planEnvelope);
        assert.equal(consumedPlan.kind, "approval");
        if (consumedPlan.kind !== "approval") return assert.fail("expected approval result");
        assert.equal(consumedPlan.approval.status, "done");
        assert.deepEqual(consumedPlan.approval.fenceViolations, []);
        trace.push("gate:approve");
        queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);

        writeFileSync(join(mainVendorPath, "seed.txt"), "from-main\n");
        git(mainVendorPath, "add", "seed.txt");
        git(mainVendorPath, "commit", "-q", "-m", "main edit");

        const action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root }, givingUpAgent);
        trace.push("notification:rebase-test");

        const consumed = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumed.kind, "queue");
        if (consumed.kind !== "queue") return assert.fail("expected queue result");
        assert.notEqual(consumed.status, "green");
        queue = consumed.queue;

        assert.deepEqual(trace, ["prepare", "notification:plan+implement", "gate:approve", "notification:rebase-test"]);
        assert.equal(currentLapIsComplete(queue), true);
        assert.deepEqual(queue.merged, []);
        assert.equal(queue.carryover.length, 1);
        assert.equal(queue.carryover[0]!.taskNumber, taskNumber);
        assert.equal(queue.carryover[0]!.lapsAttempted, 1);
        assert.match(queue.carryover[0]!.lastFailure as string, /submodule|vendor/i);
        assert.match(queue.carryover[0]!.lastFailure as string, /conflict|unresolved/i);
        assert.equal(shouldEndQueue(queue, false), "stuck");

        const report = buildMergeReport(queue);
        assert.equal(report.unmerged.length, 1);
        assert.equal(report.unmerged[0]!.taskNumber, taskNumber);
        assert.equal(report.unmerged[0]!.terminalReason, "zero-merge lap ended the queue");
        assert.match(report.unmerged[0]!.lastFailure, /submodule|vendor/i);
        assert.match(report.unmerged[0]!.lastFailure, /conflict|unresolved/i);

        const archived = readCompleted(root);
        assert.deepEqual(archived.map((t) => t.taskNumber), []);

        // A conflict must leave every task ref recoverable: no cleanup ran.
        const openTasks = readTasks(root);
        assert.equal(openTasks.some((t) => t.taskNumber === taskNumber), true);
        assert.equal(existsSync(worktreePath), true);
        // Source submodule fetches the task branch only on merge; a rebase-test conflict has no such ref yet.
        assert.doesNotThrow(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
        rmSync(fixture.origin, { recursive: true, force: true });
    }
});
```

**New — replace the entire current test with:**

```ts
test("test_endToEndQueueRetainsRootAndSourceSubmoduleRefsAfterARealMergeConflict", async () => {
    const taskNumber = 9104;
    const trace: string[] = [];
    const fixture = makeQueueFixtureRepoWithSubmoduleV2(taskNumber, ["vendor"]);
    const { root, worktreePath, submoduleOrigin, repositoryManifest, prepared } = fixture;
    trace.push("prepare");
    try {
        const worktreeVendorPath = join(worktreePath, "vendor");
        const mainVendorPath = join(root, "vendor");

        let queue = createMergeQueue();
        const planEnvelope = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "plan+implement", typecheckCommand: prepared.typecheckCommand, sourceRoot: root, repositoryManifest },
            scriptedPlanImplementAgent(taskNumber, worktreePath, "vendor", () => {
                writeFileSync(join(worktreeVendorPath, "seed.txt"), "from-worktree\n");
                git(worktreeVendorPath, "add", "seed.txt");
                git(worktreeVendorPath, "commit", "-q", "-m", "worktree edit");
            }),
        );
        trace.push("notification:plan+implement");
        const consumedPlan = consumeTaskWorkflowResult(queue, planEnvelope);
        assert.equal(consumedPlan.kind, "approval");
        if (consumedPlan.kind !== "approval") return assert.fail("expected approval result");
        assert.equal(consumedPlan.approval.status, "done");
        assert.deepEqual(consumedPlan.approval.fenceViolations, []);
        trace.push("gate:approve");
        queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);

        // First prove the serial tail reached a green rebase-test against the
        // then-current source. The source-side conflict is introduced only afterward.
        let action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "rebase-test" } });
        const rebaseTestResult = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root },
        );
        trace.push("notification:rebase-test");
        const consumedRebase = consumeTaskWorkflowResult(queue, rebaseTestResult);
        assert.equal(consumedRebase.kind, "queue");
        if (consumedRebase.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedRebase.status, "green");
        queue = consumedRebase.queue;

        // Advance canonical vendor after the green check. The merge stage now
        // fetches task-N into the source submodule, then conflicts while rebasing it.
        writeFileSync(join(mainVendorPath, "seed.txt"), "from-main\n");
        git(mainVendorPath, "add", "seed.txt");
        git(mainVendorPath, "commit", "-q", "-m", "main edit after green rebase-test");

        action = nextQueueAction(queue, { any: false, tail: false });
        assert.deepEqual(action, { kind: "launch", step: { taskNumber, stage: "merge" } });
        const mergeResult = await runTaskWorkflowStage(
            worktreePath,
            { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root },
        );
        trace.push("notification:merge");
        const consumedMerge = consumeTaskWorkflowResult(queue, mergeResult);
        assert.equal(consumedMerge.kind, "queue");
        if (consumedMerge.kind !== "queue") return assert.fail("expected queue result");
        assert.equal(consumedMerge.status, "submodule-conflicted");
        queue = consumedMerge.queue;

        assert.deepEqual(trace, [
            "prepare",
            "notification:plan+implement",
            "gate:approve",
            "notification:rebase-test",
            "notification:merge",
        ]);
        assert.equal(currentLapIsComplete(queue), true);
        assert.deepEqual(queue.merged, []);
        assert.equal(queue.carryover.length, 1);
        assert.equal(queue.carryover[0]!.taskNumber, taskNumber);
        assert.equal(queue.carryover[0]!.lapsAttempted, 1);
        assert.match(queue.carryover[0]!.lastFailure as string, /submodule|vendor/i);
        assert.match(queue.carryover[0]!.lastFailure as string, /conflict|unresolved/i);
        assert.equal(shouldEndQueue(queue, false), "stuck");

        const report = buildMergeReport(queue);
        assert.equal(report.unmerged.length, 1);
        assert.equal(report.unmerged[0]!.taskNumber, taskNumber);
        assert.equal(report.unmerged[0]!.terminalReason, "zero-merge lap ended the queue");
        assert.match(report.unmerged[0]!.lastFailure, /submodule|vendor/i);
        assert.match(report.unmerged[0]!.lastFailure, /conflict|unresolved/i);
        assert.deepEqual(readCompleted(root), []);
        assert.equal(readTasks(root).some((task) => task.taskNumber === taskNumber), true);
        assert.equal(existsSync(worktreePath), true);

        // mergeTaskDeepestFirst fetched task-N into canonical vendor before the
        // conflicting rebase. A failure must retain both recovery refs.
        for (const repo of [root, mainVendorPath]) {
            assert.doesNotThrow(() =>
                git(repo, "show-ref", "--verify", `refs/heads/task-${taskNumber}`),
            );
        }
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
        rmSync(fixture.origin, { recursive: true, force: true });
    }
});
```

Do not merely add `join(root, "vendor")` to the old rebase-test assertion. The source-submodule ref is intentionally absent until the merge path performs its fetch, so that version would test setup timing rather than cleanup retention.

## Completion check

Run at least:

```sh
npx tsc --noEmit
node --test \
  tests/addTaskFiles.test.ts \
  tests/closeTasks.test.ts \
  tests/mergeTaskWorktrees.test.ts \
  tests/prepareTasks.test.ts \
  tests/runMergePhase.test.ts \
  tests/taskArchival.test.ts \
  tests/taskFiles.test.ts \
  tests/taskWorkflowPlanImplementStage.test.ts
```

C86-08 is complete only when all four publication/boundary regressions pass under real process contention. C86-15 is complete only when the production-shaped conflict reaches the real merge stage and proves both the root and canonical source-submodule task refs survive.
