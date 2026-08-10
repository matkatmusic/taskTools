# Task 180 plan: complete the production-shaped end-to-end matrix (C86-15)

## Scope

Edit only `tests/runMergePhase.test.ts`. Repair the existing root-only scenario's fixture to use
real `prepareTasks.ts` output (no hand-built worktree path, no hand-set `operationBranch`), and add
two new end-to-end tests: submodule success, submodule conflict. Both new tests drive the same
`prepare -> notification -> gate -> queue -> close -> cleanup` chain as the existing root scenario:
build a real worktree via `createWorktreeForGroup`, drive `rebase-test`/`merge` stages through
`runTaskWorkflowStage` (the existing in-file harness around `skills/tackle-tasks/task.workflow.js`),
and drive the queue via `runMergePhase.ts`'s exported functions.

Verified starting point: `git merge-base --is-ancestor b421390 HEAD` (task 167's close commit) reports
"yes" — tasks 166 and 167 are already ancestors of the current `HEAD`, so the file contents read below
already reflect their landed state. No conditional handling for "if 166/167 haven't landed yet" is
needed.

### Why "notification" and "gate" are not separately driven in these tests

`prepare -> notification -> gate -> queue -> close -> cleanup` names the full production chain, but
"notification" and "gate" are not code that lives in any of this task's owned files, and they are not
automatable in a `node --test` process. Per `plans/brief-157.md`: "The main orchestrator conversation
is the only actor that can launch a workflow, receive its completion notification, and ask the
approval gate — AskUserQuestion is not a workflow-script hook and is stripped from every subagent."
That orchestration lives in `scripts/tackleTasksBrief.ts`, owned by task 157/169/170, not by this task.
`enqueueApprovedTask` is the queue's documented entry point for "the gate already said yes" — its own
name records that the approval gate has already happened before a task reaches the queue. This is why
the existing, already-accepted root-success test
(`test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`, unmodified in
structure by this plan — only its fixture-building is repaired per Edit 2) starts its production-shaped
chain at `enqueueApprovedTask`, not at a simulated notification+gate step, and the two new submodule
tests in Edit 3 mirror that same, already-accepted starting point for the same reason. Simulating
"notification" and "gate" inside `tests/runMergePhase.test.ts` would mean inventing gate/notification
code that does not exist in any file this task owns — out of scope here.

## Why no other owned file changes

- `scripts/runMergePhase.ts` — already exports every queue primitive the tests need
  (`createMergeQueue`, `enqueueApprovedTask`, `nextQueueStep`, `recordStageOutcome`,
  `currentLapIsComplete`, `shouldEndQueue`, `beginNextLap`, `buildMergeReport`). No edit.
- `scripts/prepareTasks.ts` — already exports `createWorktreeForGroup`, `loadRepositoryManifest`,
  and `attachOperationBranch`, which is exactly the "real prepareTasks output" the audit finding
  demands the test fixture use instead of hand-building a worktree path and `operationBranch`. No
  edit.
- `scripts/mergeTaskWorktrees.ts` — already supports submodules end-to-end (`mergeTaskDeepestFirst`,
  `rebaseSubmoduleLayersDeepestFirst`); nothing here needs to change for the test fixture to exercise
  a submodule. No edit.
- `tests/mergeTaskWorktrees.test.ts` — has proven-working helpers for building a submodule fixture
  (`makeTempRepoWithLocalSubmodule`, `buildNestedFixtureWithTask`, `buildMergePrimitiveFixture`), but
  every one of them builds a fixture shaped for driving `mergeTaskWorktrees.ts`'s own CLI (a
  `cliInput`/`DiscoveryManifest` object consumed by `runMergePipeline` or `mergeTaskDeepestFirst`
  directly). `tests/runMergePhase.test.ts`'s end-to-end tests instead drive
  `skills/tackle-tasks/task.workflow.js` stage-by-stage via `runTaskWorkflowStage`, which takes a
  `repositoryManifest` argument, not a `cliInput`/`DiscoveryManifest`. Because the fixture shapes
  differ, this task mirrors the proven git-fixture-building technique (real `git submodule add`, a
  committed test script landed on the submodule's origin before it is added, `createWorktreeForGroup`
  for the worktree) directly inside `tests/runMergePhase.test.ts` as new local helpers, per the
  brief's "reuse or mirror rather than rebuild." No export needs to be added to
  `tests/mergeTaskWorktrees.test.ts`, so it needs no edit.

## Edits to `tests/runMergePhase.test.ts`

### Edit 1 — imports

Current text (file lines 8–10):
```
import { randomUUID } from "node:crypto";
import { compileFunction, constants as vmConstants } from "node:vm";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
```

Becomes:
```
import { compileFunction, constants as vmConstants } from "node:vm";
import { type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
```

Reasoning: `randomUUID` was only used to mint the old fixture's artificial worktree path, which this
plan removes (Edit 2), so the import becomes unused and is dropped. `REPOSITORY_MANIFEST_VERSION` was
only used to hand-stamp the old fixture's manifest, which this plan replaces with
`loadRepositoryManifest`'s own manifest (Edit 2 and Edit 3), so it becomes unused and is dropped
(keeping the `RepositoryManifest` type import, still used for the fixtures' return type annotation).
`attachOperationBranch`, `createWorktreeForGroup`, and `loadRepositoryManifest` are added because the
repaired and new fixtures call all three. `currentBranchName` is added because both fixtures read the
worktree's real branch name back from git instead of hand-typing `task-${taskNumber}`.

### Edit 2 — repair `makeQueueFixtureRepo`

Current text (file lines 213–256):
```
// Mirrors makeRootWithWorktree in tests/taskWorkflowMergeStage.test.ts, plus seedTaskFiles/seedWorktreeTaskFile.
const makeQueueFixtureRepo = (taskNumber: number) => {
    const root = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");
    const sourceBranch = "main";
    const baseOid = git(root, "rev-parse", sourceBranch);
    const operationBranch = `task-${taskNumber}`;
    const worktreePath = join(tmpdir(), `run-merge-phase-e2e-wt-${randomUUID()}`);
    git(root, "worktree", "add", "-q", "-b", operationBranch, worktreePath, sourceBranch);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
    writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    const repositoryManifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [{
            occurrenceId: "",
            checkoutPath: root,
            parentOccurrenceId: null,
            pathInParent: null,
            gitlinkOid: null,
            depth: 0,
            originUrl: "",
            baseBranch: sourceBranch,
            baseOid,
            operationBranch,
            childOccurrenceIds: [],
            testState: "untested",
        }],
    };
    return { root, worktreePath, repositoryManifest };
};
```

Becomes:
```
// Mirrors makeRootWithWorktree in tests/taskWorkflowMergeStage.test.ts, plus seedTaskFiles/seedWorktreeTaskFile.
const makeQueueFixtureRepo = (taskNumber: number) => {
    const root = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");
    const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: "unknown" });
    const operationBranch = currentBranchName(worktreePath);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
    writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    const manifest = loadRepositoryManifest(root);
    const repositoryManifest: RepositoryManifest = { ...manifest, occurrences: attachOperationBranch(manifest.occurrences, operationBranch) };
    return { root, worktreePath, repositoryManifest };
};
```

Reasoning: `createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [],
scope: "unknown" })` is the same real `prepareTasks.ts` function and `TaskGroup` literal shape already
used by `makeGroup` in the owned `tests/mergeTaskWorktrees.test.ts` (line 47-50: `createWorktreeForGroup(repoRoot,
{ groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" })`), so it produces the real
convention path (`tmpdir()/taskTools-wt/<basename(root)>/task-<N>`) and creates the branch the same
way production does, instead of the fixture's own made-up temp path and a hand-typed
`operationBranch`. `currentBranchName(worktreePath)` reads the branch git actually created rather than
assuming the naming convention. `loadRepositoryManifest(root)` calls the same
`bootstrapRepositoryManifest` used by `prepareTasks.ts`'s own CLI, so the manifest's `checkoutPath`,
`baseBranch`, `baseOid`, `originUrl`, and version all come from real discovery instead of being typed
by hand; `attachOperationBranch` (also a real `prepareTasks.ts` export) is the only place that sets
`operationBranch`, matching how the real pipeline attaches it.

No changes are needed to the two existing tests that call `makeQueueFixtureRepo`
(`test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`,
`test_endToEndQueueFeedsARealMergeStageCleanupFailureIntoRecordStageOutcomeAndBuildMergeReport`): both
already destructure `{ root, worktreePath, repositoryManifest }`, which the repaired fixture still
returns with the same shape and semantics.

### Edit 3 — add a submodule fixture helper and two new end-to-end tests

Current text (file's final lines, the tail of
`test_endToEndQueueFeedsARealMergeStageCleanupFailureIntoRecordStageOutcomeAndBuildMergeReport`):
```
        queue = recordStageOutcome(queue, taskNumber, "merge", { status: "failure", reason: mergeOutcome.lastFailure });

        assert.equal(shouldEndQueue(queue, false), "stuck");
        const report = buildMergeReport(queue);
        assert.deepEqual(report.unmerged, [
            { taskNumber, lastFailure: mergeOutcome.lastFailure, terminalReason: "zero-merge lap ended the queue" },
        ]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});
```

Becomes (same text, with the new helper and two new tests appended after the closing `});`):
```
        queue = recordStageOutcome(queue, taskNumber, "merge", { status: "failure", reason: mergeOutcome.lastFailure });

        assert.equal(shouldEndQueue(queue, false), "stuck");
        const report = buildMergeReport(queue);
        assert.deepEqual(report.unmerged, [
            { taskNumber, lastFailure: mergeOutcome.lastFailure, terminalReason: "zero-merge lap ended the queue" },
        ]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});

// Same production-shaped path as makeQueueFixtureRepo, extended with a real "git submodule add" child repo.
const makeQueueFixtureRepoWithSubmodule = (taskNumber: number) => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-submodule-origin-"));
    git(submoduleOrigin, "init", "-q", "-b", "main");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    git(submoduleOrigin, "config", "commit.gpgsign", "false");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");
    writeFileSync(join(submoduleOrigin, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(submoduleOrigin, "add", "package.json");
    git(submoduleOrigin, "commit", "-q", "-m", "add test script");

    const root = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    git(root, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(root, "commit", "-q", "-m", "add submodule");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");

    const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: "unknown" });
    const operationBranch = currentBranchName(worktreePath);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
    writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    const manifest = loadRepositoryManifest(root);
    const repositoryManifest: RepositoryManifest = { ...manifest, occurrences: attachOperationBranch(manifest.occurrences, operationBranch) };
    return { root, worktreePath, submoduleOrigin, repositoryManifest };
};

test("test_endToEndQueueDrivesARealTaskThroughASubmoduleRebaseTestThenMergeAndReportsItMerged", async () => {
    const taskNumber = 9103;
    const { root, worktreePath, submoduleOrigin, repositoryManifest } = makeQueueFixtureRepoWithSubmodule(taskNumber);
    try {
        writeFileSync(join(worktreePath, "vendor", "vendor-new.txt"), "vendor new\n");
        git(join(worktreePath, "vendor"), "add", "vendor-new.txt");
        git(join(worktreePath, "vendor"), "commit", "-q", "-m", "add vendor-new.txt");
        git(worktreePath, "add", "vendor");
        git(worktreePath, "commit", "-q", "-m", "bump vendor gitlink");

        let queue = createMergeQueue();
        queue = enqueueApprovedTask(queue, taskNumber);

        let step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "rebase-test" });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest });
        const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
        assert.equal(rebaseTestOutcome.status, "green");
        queue = recordStageOutcome(queue, taskNumber, "rebase-test", { status: "success" });

        step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "merge" });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest });
        const mergeOutcome = mergeResult.results[0] as { status: string };
        assert.equal(mergeOutcome.status, "merged");
        queue = recordStageOutcome(queue, taskNumber, "merge", { status: "success" });

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueStep(queue), null);
        // All work landed and nothing is outstanding: the terminal state is "done", not "stuck".
        assert.equal(shouldEndQueue(queue, false), "done");
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [] });

        const archived = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
        assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
    }
});

test("test_endToEndQueueFeedsARealSubmoduleRebaseConflictIntoRecordStageOutcomeAndBuildMergeReport", async () => {
    const taskNumber = 9104;
    const { root, worktreePath, submoduleOrigin, repositoryManifest } = makeQueueFixtureRepoWithSubmodule(taskNumber);
    try {
        const worktreeVendorPath = join(worktreePath, "vendor");
        const mainVendorPath = join(root, "vendor");
        writeFileSync(join(worktreeVendorPath, "seed.txt"), "from-worktree\n");
        git(worktreeVendorPath, "add", "seed.txt");
        git(worktreeVendorPath, "commit", "-q", "-m", "worktree edit");

        writeFileSync(join(mainVendorPath, "seed.txt"), "from-main\n");
        git(mainVendorPath, "add", "seed.txt");
        git(mainVendorPath, "commit", "-q", "-m", "main edit");

        let queue = createMergeQueue();
        queue = enqueueApprovedTask(queue, taskNumber);

        const step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "rebase-test" });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest });
        const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
        assert.notEqual(rebaseTestOutcome.status, "green");
        queue = recordStageOutcome(queue, taskNumber, "rebase-test", { status: "failure", reason: "submodule rebase conflicted: seed.txt" });

        assert.equal(currentLapIsComplete(queue), true);
        assert.deepEqual(queue.merged, []);
        assert.deepEqual(queue.carryover, [{ taskNumber, stage: "rebase-test", lapsAttempted: 1, lastFailure: "submodule rebase conflicted: seed.txt" }]);
        assert.equal(shouldEndQueue(queue, false), "stuck");

        const report = buildMergeReport(queue);
        assert.deepEqual(report.unmerged, [
            { taskNumber, lastFailure: "submodule rebase conflicted: seed.txt", terminalReason: "zero-merge lap ended the queue" },
        ]);

        const archived = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
        assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), []);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(submoduleOrigin, { recursive: true, force: true });
    }
});
```

Reasoning for Edit 3:

- `makeQueueFixtureRepoWithSubmodule` mirrors the git-fixture-building technique already proven in the
  owned `tests/mergeTaskWorktrees.test.ts` (`makeTempRepoWithLocalSubmodule` creates a submodule
  origin then `git submodule add`s it; `addPassingTestScriptToSubmoduleOrigin` lands the test script on
  the submodule's origin because a worktree clones from origin, not the live checkout — this plan lands
  the test script on `submoduleOrigin` before `git submodule add`, so no separate propagation step is
  needed), combined with the repaired `makeQueueFixtureRepo`'s pattern of real
  `createWorktreeForGroup` / `loadRepositoryManifest` / `attachOperationBranch` calls. `createWorktreeForGroup`
  itself calls `initializeSubmodulesInWorktree`, so `worktreePath/vendor` is already populated by
  `git submodule update --init --recursive` before either new test runs.
- `test_endToEndQueueDrivesARealTaskThroughASubmoduleRebaseTestThenMergeAndReportsItMerged` commits a
  change inside the worktree's submodule and bumps the parent gitlink, then drives the same
  `rebase-test` → `merge` → queue → archive chain as the existing root scenario, asserting the task
  ends up merged and archived — this is the "submodule success" scenario.
- `test_endToEndQueueFeedsARealSubmoduleRebaseConflictIntoRecordStageOutcomeAndBuildMergeReport`
  creates a genuine git conflict at the submodule layer by editing the same file (`seed.txt`)
  differently in the worktree's submodule copy and in the submodule's live checkout
  (`join(root, "vendor")`) — the identical technique already proven in the owned
  `tests/mergeTaskWorktrees.test.ts`'s
  `test_mergeTaskDeepestFirstStopsAtASubmoduleConflictWithoutAttemptingTheParentMerge` (which edits
  `seed.txt` in `worktreeSubmodulePath` and `mainSubmodulePath` on separate commits to force a
  conflict). The assertion only checks `rebaseTestOutcome.status !== "green"` (not a specific failure
  string), since the exact failure status string is internal to `skills/tackle-tasks/task.workflow.js`,
  which is outside this task's owned files; the `reason` string passed into
  `recordStageOutcome` afterward is a literal chosen for the test, not read from the stage's result, so
  the test does not depend on that internal shape. This is the "submodule conflict" scenario, and it
  exercises `recordStageOutcome`'s failure path and `buildMergeReport`'s `carryover` reporting exactly
  as the existing pure-unit tests already prove that logic behaves (`test_shouldEndQueueEndsTheQueueWhenALapMergesZeroTasksAndNoWorkflowIsOutstanding`,
  `test_buildMergeReportNamesTheQueueExitNotTheCeilingWhenATaskWasStillRetryable`), but now fed by a
  real conflict instead of a synthetic one. It stays at one failed lap (not two) because the queue's
  2-lap retry arithmetic is already covered by
  `test_recordStageOutcomeLeavesATaskUnmergedAfterItsSecondLapFails` as a pure unit test; re-deriving a
  second real conflict here would duplicate that coverage without adding anything the audit finding
  asks for.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npx tsc --noEmit
```
Expected: exits 0, no type errors (the new imports and the new tests' object literals must satisfy
`TaskGroup`, `RepositoryManifest`, `MergeQueue`, `MergeReport`, and the other imported types with no
`any`).

```
node --test tests/runMergePhase.test.ts
```
Expected: exits 0. The two existing end-to-end tests
(`test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`,
`test_endToEndQueueFeedsARealMergeStageCleanupFailureIntoRecordStageOutcomeAndBuildMergeReport`) still
pass against the repaired fixture, and the two new tests
(`test_endToEndQueueDrivesARealTaskThroughASubmoduleRebaseTestThenMergeAndReportsItMerged`,
`test_endToEndQueueFeedsARealSubmoduleRebaseConflictIntoRecordStageOutcomeAndBuildMergeReport`) pass —
`node --test`'s summary line reports 0 fail.

```
npm test
```
Expected: exits 0 — the full suite (`tests/**/*.test.ts`, including the untouched
`tests/mergeTaskWorktrees.test.ts`) still passes, confirming this task's edits did not disturb any
other owned or unowned test file.
