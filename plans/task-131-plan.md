# Task 131 plan: one worktree per task in prepareTasks.ts

## Goal recap

`node scripts/prepareTasks.ts '[131]'` must create exactly one worktree at
`$TMPDIR/taskTools-wt/<repo>/task-131` on branch `task-131` (same branch name
in every submodule), and that task's `files` must be its own `files` list
from tasks.json — not a group's combined list. Two requested task numbers
must produce two separate worktrees.

## Files covered

- `scripts/prepareTasks.ts` — edited (grouping call removed, one-worktree-per-task
  naming, files-per-task fix).
- `scripts/taskGroups.ts` — **no edit**. Untouched by design: `scripts/taskStats.ts` still
  calls `groupTasksByFileOverlap` for its parallel-commands display, and the brief is
  explicit that this task drops prepareTasks.ts's *call* to that function, not the file.
  `TaskGroup`/`TaskGroupScope` (the types, not the grouping function) stay imported into
  prepareTasks.ts and in the `PreparedGroup`/`WorkflowArguments` shape below.
- `tests/prepareTasks.test.ts` — edited (branch/worktree-naming assertions updated,
  `buildWorkflowArguments` tests take `TaskRecord[]` instead of `TaskGroup[]`, two new tests).
- `tests/prepareTasksIntegration.test.ts` — edited (drop the `groupTasksByFileOverlap` call,
  pass tasks straight into `buildWorkflowArguments`).
- `tests/taskGroups.test.ts` — **no edit**. Read in full: every test in this file constructs
  `TaskRecord`/`RepositoryManifest` objects and calls `groupTasksByFileOverlap` directly. It
  contains no reference to `prepareTasks.ts`, `PreparedGroup`, `WorkflowArguments`, or
  `createWorktreeForGroup`. Since `taskGroups.ts` itself is unchanged, every assertion in this
  file remains valid as written and needs no trimming.
- `plans/task-86-spec.md` — **no edit**. It is background/design context inlined into the brief
  for reading only; nothing in the task instructs changing this file, and it is a `.md` doc (not
  authoritative per the user's global "trust source code, not docs" instruction) — editing it is
  out of this task's scope.

## Design decision: shape of the new output

`WorkflowArguments.groups: PreparedGroup[]` **stays** — `PreparedGroup` and `PreparedTask` are
not renamed, restructured, or removed. `skills/tackle-tasks/task.workflow.js` and
`plan.workflow.js` are explicitly out of scope for this task (brief: "chained behind this one")
and are the consumers of this exact JSON shape; changing `groups` to a flattened `tasks` field
would break them with no way to fix that breakage inside this task's owned files. So the JSON
contract does not change shape — only its *content* changes: `buildWorkflowArguments` now takes
`TaskRecord[]` instead of `TaskGroup[]` and builds exactly one singleton `PreparedGroup` per task
(`groupId: task.taskNumber`, `scope: "declared"`, one entry in `tasks: [...]`), rather than
calling `groupTasksByFileOverlap` to cluster multiple tasks into one group. This satisfies
`plans/task-86-spec.md`'s "one task, one worktree, one branch" while keeping the downstream
consumers' parsing (`workflowArguments.groups[i].tasks[j]`, `.worktree`, `.branch`) unchanged.

Branch/worktree naming changes from `task-group-<groupId>` / `group-<groupId>` to
`task-<groupId>` / `task-<groupId>` — since `groupId` is now always the task's own number, this
produces exactly the goal's `task-<N>` naming with no other code path affected.

## Edits to scripts/prepareTasks.ts

### Edit 1 — top-of-file comment (line 1)

Current:
```
// Writes task briefs, creates one worktree per file-disjoint group, prints WorkflowArguments. CLI entry point at bottom.
```

New:
```
// Writes task briefs, creates one worktree per task, prints WorkflowArguments. CLI entry point at bottom.
```

### Edit 2 — drop only the grouping-function import (line 9)

Current (lines 8-9):
```
import type { TaskGroup, TaskGroupScope } from "./taskGroups.ts";
import { groupTasksByFileOverlap } from "./taskGroups.ts";
```

New:
```
import type { TaskGroup, TaskGroupScope } from "./taskGroups.ts";
```

(Only the `groupTasksByFileOverlap` import is dropped. `TaskGroup` stays — it is still used
inside `buildWorkflowArguments` to build the synthetic singleton group passed to
`createWorktreeForGroup`, and by test files. `TaskGroupScope` stays — `PreparedGroup.scope` is
still typed as `TaskGroupScope`.)

**No other type changes in this file.** `PreparedTask` (lines 14-19), `PreparedGroup`
(lines 21-27), and `WorkflowArguments` (lines 29-34) are **not edited** — they keep their current
shape exactly as it is in the file today.

### Edit 3 — branchNameForGroup's naming scheme (lines 96-98)

Current:
```
function branchNameForGroup(groupId: number): string {
    return `task-group-${groupId}`;
}
```

New:
```
function branchNameForGroup(groupId: number): string {
    return `task-${groupId}`;
}
```

(Function name, signature, and every call site stay unchanged — only the returned string's
format changes. Since every caller now always passes `groupId === task.taskNumber` after Edit 5
below, this produces branch name `task-<N>` for task N, matching the goal.)

### Edit 4 — createWorktreeForGroup's worktree-path naming scheme (line 135)

Current (lines 134-155):
```
export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
    const worktreePath = join(tmpdir(), "taskTools-wt", basename(repoRoot), `group-${group.groupId}`);
    const branchName = branchNameForGroup(group.groupId);
    if (existsSync(worktreePath)) {
        // A worktree left by an earlier run holds that run's commits; re-base it on the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        execFileSync(
            "git",
            ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, "HEAD"],
            { stdio: "ignore" },
        );
    }
    initializeSubmodulesInWorktree(worktreePath);
    createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName);
    return worktreePath;
}
```

New (only line 135 changes; every other line in the function body is byte-identical):
```
export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
    const worktreePath = join(tmpdir(), "taskTools-wt", basename(repoRoot), `task-${group.groupId}`);
    const branchName = branchNameForGroup(group.groupId);
    if (existsSync(worktreePath)) {
        // A worktree left by an earlier run holds that run's commits; re-base it on the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        execFileSync(
            "git",
            ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, "HEAD"],
            { stdio: "ignore" },
        );
    }
    initializeSubmodulesInWorktree(worktreePath);
    createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName);
    return worktreePath;
}
```

(Function name and signature are unchanged — it still takes a `TaskGroup`. `createBranchInEveryRepository`
at the old line 153 is reused unchanged, exactly as the brief specifies.)

### Edit 5 — buildWorkflowArguments takes tasks, builds one singleton group per task, and fixes the combined-files bug (lines 157-176)

Current:
```
export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            files: group.filePaths,
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```

New:
```
export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    tasks: TaskRecord[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = tasks.map((task) => {
        const group: TaskGroup = {
            groupId: task.taskNumber,
            taskNumbers: [task.taskNumber],
            filePaths: declaredFiles(task),
            scope: "declared",
        };
        return {
            groupId: group.groupId,
            worktree: createWorktreeForGroup(repoRoot, group),
            branch: branchNameForGroup(group.groupId),
            scope: group.scope,
            tasks: [{
                number: task.taskNumber,
                briefFile: join(repoRoot, "plans", `brief-${task.taskNumber}.md`),
                planFile: join(repoRoot, "plans", `task-${task.taskNumber}-plan.md`),
                files: declaredFiles(task),
            }],
        };
    });
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```

(Third parameter's type changes from `TaskGroup[]` to `TaskRecord[]` — `TaskRecord` is already
imported in this file at line 10. `declaredFiles` is the existing private helper at lines 100-102,
unchanged. `groupTasksByFileOverlap` is no longer called anywhere in this file — that call, and
the clustering of multiple tasks into one group, moves out entirely; each task becomes its own
singleton group with its own `files` list, which is the fix for the combined-files bug: no task
can see another task's files through `group.filePaths` because there is no longer a multi-task
group to combine files from.)

### Edit 6 — runAsCli drops the grouping call (lines 210-215)

Current:
```
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const runId = generateRunId();
    const manifest = loadRepositoryManifest(repoRoot);
    manifest.occurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
    const groups = groupTasksByFileOverlap(tasks, manifest);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
```

New:
```
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const runId = generateRunId();
    const manifest = loadRepositoryManifest(repoRoot);
    manifest.occurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks);
```

(`manifest` stays — it is still needed a few lines below for `repositoryManifest: manifest` in
`pipelineArguments`; only the `groups` line is deleted and the argument passed to
`buildWorkflowArguments` changes from `groups` to `tasks`.)

No other lines in `scripts/prepareTasks.ts` reference `groupTasksByFileOverlap` — the file's full
text was read in this planning pass and every occurrence is accounted for above. `TaskGroup`,
`PreparedGroup`, `createWorktreeForGroup`, and `branchNameForGroup` all stay in the file, unrenamed.

## Edits to tests/prepareTasks.test.ts

### Edit 1 — imports (lines 8-16): add the `TaskRecord` type import

Current:
```
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";
```

New:
```
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

(`buildWorkflowArguments` and `createWorktreeForGroup` keep their current names and are still
imported the same way. `TaskGroup` stays imported — it is still used by tests that call
`createWorktreeForGroup` directly with a hand-built group literal. `TaskRecord` is newly imported
for the `buildWorkflowArguments` tests below, which now pass `TaskRecord[]`.)

### Edit 2 — line 72 only (`test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch`)

Current (lines 66-73):
```
test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});
```

New (only the final assertion's expected string changes):
```
test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-1");
});
```

### Edit 3 — lines 75-81 (`test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath`)

No edit. This test does not assert on the branch or worktree-path string, only that two calls
with the same group return the same path — unaffected by the naming-scheme change.

### Edit 4 — lines 83-102 (`test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip`)

No edit. This test does not assert on the branch or worktree-path string — unaffected.

### Edit 5 — lines 104-112 (`test_createWorktreeForGroupPopulatesSubmoduleWorkingTrees`)

No edit. Unaffected for the same reason.

### Edit 6 — lines 114-121 (`test_createWorktreeForGroupThrowsWhenSubmoduleInitFails`)

No edit. Unaffected for the same reason.

### Edit 7 — lines 123-130 (`test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask`)

Current:
```
test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});
```

New (input becomes two `TaskRecord`s; since `buildWorkflowArguments` now makes one singleton
group per task instead of one group holding both, the two tasks land in two different
`workflowArguments.groups` entries — so the lookup flattens across all groups instead of reading
`groups[0]`):
```
test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 268, files: ["a.ts"] },
        { taskNumber: 270, files: ["b.ts"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const tasks = workflowArguments.groups.flatMap((g) => g.tasks);
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});
```

### Edit 8 — lines 132-138 (`test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput`)

Current:
```
test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});
```

New:
```
test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"] }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});
```

### Edit 9 — line 216 only (`test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch`)

Current (lines 211-217):
```
test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});
```

New (only the final assertion's expected string changes):
```
test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-1");
});
```

### Edit 10 — lines 219-225 (`test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory`)

Current:
```
test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups));
    assert.equal(existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "group-1")), false);
});
```

New (input becomes a `TaskRecord[]`, and the checked directory name changes from `group-1` to
`task-1` to match the new naming scheme):
```
test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"] }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords));
    assert.equal(existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "task-1")), false);
});
```

### Edit 11 — lines 227-234 (`test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch`)

Current:
```
test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});
```

New:
```
test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"] }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});
```

### Edit 12 — append two new tests after the final `});` at line 234 (end of file)

Append, as new content after the existing final line:
```

test("test_buildWorkflowArgumentsGivesEachTaskItsOwnFilesNotTheCombinedList", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 1, files: ["a.ts"] },
        { taskNumber: 2, files: ["b.ts"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const tasks = workflowArguments.groups.flatMap((g) => g.tasks);
    assert.deepEqual(tasks.find((t) => t.number === 1)!.files, ["a.ts"]);
    assert.deepEqual(tasks.find((t) => t.number === 2)!.files, ["b.ts"]);
});

test("test_buildWorkflowArgumentsGivesEachTaskItsOwnWorktreeAndBranchAsASingletonGroup", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 1, files: ["a.ts"] },
        { taskNumber: 2, files: ["b.ts"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    assert.equal(workflowArguments.groups.length, 2);
    const group1 = workflowArguments.groups.find((g) => g.tasks[0].number === 1)!;
    const group2 = workflowArguments.groups.find((g) => g.tasks[0].number === 2)!;
    assert.equal(group1.tasks.length, 1);
    assert.equal(group2.tasks.length, 1);
    assert.notEqual(group1.worktree, group2.worktree);
    assert.match(group1.worktree, /task-1$/);
    assert.match(group2.worktree, /task-2$/);
    assert.equal(group1.branch, "task-1");
    assert.equal(group2.branch, "task-2");
});
```

Tests untouched (no edit — verified unaffected by reading full file above): lines 46-55
(`test_writeTaskBriefFileEmbedsTheDeclaredFileContents`), lines 57-64
(`test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing`), lines 140-146
(`test_generateRunIdProducesDifferentValuesOnEachCall`), lines 148-152
(`test_mergeScriptPathPointsAtTheSiblingMergeScriptAsAnAbsolutePath`), lines 154-209 (all seven
`selectRequestedTasks` tests), and the four `createWorktreeForGroup` tests named in Edits 3-6 above
— none of these reference anything this task changes.

## Edits to tests/prepareTasksIntegration.test.ts

### Edit 1 — drop the now-unused import (line 12)

Current:
```
import { groupTasksByFileOverlap } from "../scripts/taskGroups.ts";
```

New: delete this line entirely (the only remaining use of `groupTasksByFileOverlap` in this file
is removed by Edit 2 below; `TaskRecord` on line 14 is still imported and still used).

### Edit 2 — lines 80-99 (`test_groupTasksByFileOverlapReturnsRealGroupsInsteadOfThrowing`)

Current:
```
test("test_groupTasksByFileOverlapReturnsRealGroupsInsteadOfThrowing", () => {
    const tasks: TaskRecord[] = [
        { taskNumber: 1, files: ["scripts/foo.ts"] },
        { taskNumber: 2, files: ["external/sub/src/bar.ts"] },
    ];
    const groups = groupTasksByFileOverlap(tasks);
    assert.ok(groups.length > 0);

    // Bun drops process.env edits for children, so only a spawned process can carry the git override.
    const script = `
        const { buildWorkflowArguments } = await import(${JSON.stringify(prepareTasksModulePath)});
        const built = buildWorkflowArguments(${JSON.stringify(rootPath)}, "npx tsc --noEmit", ${JSON.stringify(groups)});
        process.stdout.write(String(built.groups.length));
    `;
    const groupCount = execFileSync("bun", ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    assert.ok(Number(groupCount) > 0);
});
```

New (feed `tasks` straight into `buildWorkflowArguments` — no grouping step — and tighten the
assertion from `> 0` to `=== 2` since two tasks now always produce exactly two singleton groups):
```
test("test_buildWorkflowArgumentsCreatesOneWorktreePerTaskAgainstARealRepo", () => {
    const tasks: TaskRecord[] = [
        { taskNumber: 1, files: ["scripts/foo.ts"] },
        { taskNumber: 2, files: ["external/sub/src/bar.ts"] },
    ];

    // Bun drops process.env edits for children, so only a spawned process can carry the git override.
    const script = `
        const { buildWorkflowArguments } = await import(${JSON.stringify(prepareTasksModulePath)});
        const built = buildWorkflowArguments(${JSON.stringify(rootPath)}, "npx tsc --noEmit", ${JSON.stringify(tasks)});
        process.stdout.write(String(built.groups.length));
    `;
    const groupCount = execFileSync("bun", ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    assert.equal(Number(groupCount), 2);
});
```

Tests untouched (no edit — read in full above): lines 60-64 (`test_ownershipResolvesForARootFilePath`),
lines 66-72 (`test_ownershipResolvesForASubmoduleFilePath`), lines 74-78
(`test_everyOccurrenceHasANonEmptyOriginUrl`) — none reference `prepareTasks.ts`,
`groupTasksByFileOverlap`, or worktrees/branches; the top-level setup block (lines 1-58) and
`after()` cleanup (lines 54-58) are also unaffected — the cleanup already removes the whole
`taskTools-wt/<basename(rootPath)>` directory recursively, which covers `task-1`/`task-2`
subdirectories exactly as it covered `group-1` before.

## tests/taskGroups.test.ts

No edit. Read in full above (80 lines): every test calls `groupTasksByFileOverlap` directly with
hand-built `TaskRecord`/`RepositoryManifest` values; nothing in the file imports from or references
`prepareTasks.ts`. Since `scripts/taskGroups.ts` is not modified by this task, every assertion here
stays valid unchanged.

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`):

1. `npx tsc --noEmit`
   Expected: exits 0, no type errors (confirms `buildWorkflowArguments`'s new `TaskRecord[]`
   parameter and the unchanged `PreparedGroup`/`WorkflowArguments` types are internally
   consistent, and that no call site still passes a `TaskGroup[]`).

2. `node --test tests/prepareTasks.test.ts tests/prepareTasksIntegration.test.ts tests/taskGroups.test.ts`
   Expected: all tests pass, 0 failures. This exercises the real per-task worktree/branch creation
   (via `makeTempRepoWithCommit`/`makeTempRepoWithLocalSubmodule` in temp directories) and the
   real-repo integration path — do **not** additionally run
   `node scripts/prepareTasks.ts '[131]'` against this actual repository/branch as a verification
   step, since that would create real worktrees and branches against the live task-86-chain checkout;
   the test suite already covers the same code path against disposable temp repos.

3. `rg -n "group-\\\$|task-group-|groupTasksByFileOverlap" scripts/prepareTasks.ts`
   Expected: no matches (confirms the old `group-N` worktree naming, the old `task-group-N` branch
   naming, and the grouping-function call are all gone from `prepareTasks.ts`).

4. `rg -n "task-group-|groupTasksByFileOverlap" tests/prepareTasks.test.ts tests/prepareTasksIntegration.test.ts`
   Expected: no matches (confirms the old group-branch string and the grouping-function call are
   gone from the updated tests).
</content>
