# Task 39 plan: merge-worktree-tasks skill

## Why (one paragraph, for context only — the How below is what to build)

`prepareTasks.ts` recomputes `groupId` fresh every run and worktrees live at
`tmpdir()/taskTools-wt/<basename(repoRoot)>/group-<groupId>`, so a worktree
left over from an interrupted run (agent forgot to commit, or the pipeline
was killed before merge) can't be matched back to task numbers by groupId —
next run's group 3 is unrelated task content. The only durable link is the
worktree's **changed files** against the **declared files** on still-open
tasks. This task adds discovery + merge CLI modes to
`scripts/mergeTaskWorktrees.ts` and a `merge-worktree-tasks` skill that
reports matches and merges only after explicit user approval.

Verified live in this repo right now: `git worktree list --porcelain` shows
six leftover `taskTools-wt/taskTools/group-{1..6}` worktrees on branches
`task-group-{1..6}` — real data to sanity-check `--discover` against once
built.

## Files touched

- `scripts/mergeTaskWorktrees.ts` — extend only, no existing exported
  function's behavior changes (`mergeGroupBranchIntoRepo`,
  `mergeSubmoduleBranchIntoRepo`, `resolveGitlinkConflicts`,
  `removeWorktreeAndBranch` stay exactly as they are).
- `tests/mergeTaskWorktrees.test.ts` — new tests only, do not touch existing
  tests.
- `skills/merge-worktree-tasks/SKILL.md` — new file.

## Step 1 — `listTaskWorktrees(repoRoot)`

### Behavior (plain English)

Given a repo root, ask git which worktrees it knows about
(`git worktree list --porcelain`), parse that block format, and keep only
the ones whose path is `tmpdir()/taskTools-wt/<basename(repoRoot)>/group-<N>`
— i.e. one this plugin's own `createWorktreeForGroup` created. Return each
match's path and the branch checked out in it. The main worktree (repoRoot
itself) and any unrelated worktree (a manual `git worktree add` elsewhere)
must never be returned.

### Porcelain format (confirmed by running it in this repo)

Blocks are separated by a blank line; each block is `worktree <path>`,
`HEAD <sha>`, `branch refs/heads/<name>` (a detached worktree has `detached`
instead of the `branch` line — skip those, they have no branch to compare).

### Add to `scripts/mergeTaskWorktrees.ts`

Change the import line
```ts
import { join } from "node:path";
```
to
```ts
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
```

Add near the top, after the existing `gitErrorText` helper:

```ts
export type TaskWorktree = { path: string; branch: string };

function parseWorktreeListPorcelain(output: string): TaskWorktree[] {
    const blocks = output.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const worktrees: TaskWorktree[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
        if (!pathLine) continue;
        if (!branchLine) continue;
        worktrees.push({
            path: pathLine.slice("worktree ".length),
            branch: branchLine.slice("branch refs/heads/".length),
        });
    }
    return worktrees;
}

export function listTaskWorktrees(repoRoot: string): TaskWorktree[] {
    const conventionRoot = join(tmpdir(), "taskTools-wt", basename(repoRoot));
    const output = git(repoRoot, "worktree", "list", "--porcelain");
    return parseWorktreeListPorcelain(output).filter((worktree) => {
        if (!worktree.path.startsWith(`${conventionRoot}/`)) return false;
        return /^group-\d+$/.test(basename(worktree.path));
    });
}
```

(Two single-condition `if`s inside the loop, not one chained `&&` — matches
the repo's branching guide. Same reasoning for the two guard lines in the
filter callback.)

### Tests (add to `tests/mergeTaskWorktrees.test.ts`, after the existing
`import` block — no new imports needed beyond what Step 4 below adds)

```ts
test("test_listTaskWorktreesReturnsOnlyPathsMatchingTheTaskToolsWtConvention", () => {
    // Setup: one real taskTools-wt worktree; repoRoot itself is a worktree too but not one of ours.
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 7);
    // Test action: list every worktree git knows about for this repo.
    const worktrees = listTaskWorktrees(repoRoot);
    // Verification: only the group worktree is reported, never repoRoot.
    assert.deepEqual(worktrees.map((w) => w.path), [group.worktree]);
});

test("test_listTaskWorktreesReportsTheBranchCheckedOutInTheMatchedWorktree", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 7);
    const worktrees = listTaskWorktrees(repoRoot);
    assert.equal(worktrees[0].branch, group.branch);
});
```

Add `listTaskWorktrees` to the existing import from `"../scripts/mergeTaskWorktrees.ts"`.

Run `node --test tests/mergeTaskWorktrees.test.ts` — red first (function
doesn't exist), then implement Step 1's code above until green, before
moving on.

## Step 2 — `findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks)`

### Behavior (plain English)

For every worktree `listTaskWorktrees` finds: count commits on its branch
that aren't on `sourceBranch` yet (`git rev-list --count sourceBranch..branch`
in `repoRoot`), collect the files those commits touched
(`git diff --name-only sourceBranch...branch`, triple-dot so it's relative to
the merge base), and separately collect any file that's uncommitted *inside
the worktree itself* (`git status --porcelain` run with the worktree as the
`-C` root). Union those two file lists. A worktree with zero unmerged
commits and no uncommitted changes is already merged/clean — drop it, it's
not an "unmerged worktree". For the rest, compare the unioned changed files
against `declaredFiles(task)` (from `taskGroups.ts`) for every task in
`openTasks`; any task with at least one overlapping path is a match.

### Add to `scripts/mergeTaskWorktrees.ts`

Import additions at the top:
```ts
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
```

Helpers (near `listTaskWorktrees`):

```ts
function unmergedCommitCount(repoRoot: string, sourceBranch: string, branch: string): number {
    return Number(git(repoRoot, "rev-list", "--count", `${sourceBranch}..${branch}`).trim());
}

function commitChangedFiles(repoRoot: string, sourceBranch: string, branch: string): string[] {
    return git(repoRoot, "diff", "--name-only", `${sourceBranch}...${branch}`).split("\n").filter(Boolean);
}

// Porcelain v1 rename lines read "R  old -> new"; every other status line is "XY path".
function uncommittedChangedFiles(worktreePath: string): string[] {
    return git(worktreePath, "status", "--porcelain").split("\n").filter(Boolean).map((line) => {
        const path = line.slice(3);
        if (!path.includes(" -> ")) return path;
        return path.split(" -> ")[1];
    });
}
```

Public function:

```ts
export type UnmergedTaskWorktree = {
    worktree: string;
    branch: string;
    unmergedCommitCount: number;
    hasUncommittedChanges: boolean;
    changedFilePaths: string[];
    matchedTaskNumbers: number[];
};

export function findUnmergedTaskWorktrees(
    repoRoot: string,
    sourceBranch: string,
    openTasks: TaskRecord[],
): UnmergedTaskWorktree[] {
    const results = listTaskWorktrees(repoRoot).map((worktree) => {
        const commitChanged = commitChangedFiles(repoRoot, sourceBranch, worktree.branch);
        const uncommittedChanged = uncommittedChangedFiles(worktree.path);
        const changedFilePaths = [...new Set([...commitChanged, ...uncommittedChanged])];
        const matchedTaskNumbers = openTasks
            .filter((task) => declaredFiles(task).some((file) => changedFilePaths.includes(file)))
            .map((task) => task.taskNumber);
        return {
            worktree: worktree.path,
            branch: worktree.branch,
            unmergedCommitCount: unmergedCommitCount(repoRoot, sourceBranch, worktree.branch),
            hasUncommittedChanges: uncommittedChanged.length > 0,
            changedFilePaths,
            matchedTaskNumbers,
        };
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}
```

### Tests

```ts
test("test_findUnmergedTaskWorktreesExcludesAWorktreeWithNoUnmergedCommitsAndNoUncommittedChanges", () => {
    // Setup: worktree branched from HEAD, nothing committed or edited in it since.
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    makeGroup(repoRoot, 1);
    // Test action + verification: nothing to report.
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, []);
    assert.deepEqual(results, []);
});

test("test_findUnmergedTaskWorktreesCountsCommitsOnTheBranchNotYetOnTheSourceBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].unmergedCommitCount, 1);
});

test("test_findUnmergedTaskWorktreesFlagsUncommittedChangesAndListsTheChangedFile", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "dirty.txt"), "uncommitted\n");

    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].hasUncommittedChanges, true);
    assert.ok(results[0].changedFilePaths.includes("dirty.txt"));
});

test("test_findUnmergedTaskWorktreesMatchesAnOpenTaskWhoseDeclaredFilesOverlapTheChangedFiles", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "owned.txt"), "brand new\n");
    git(group.worktree, "add", "owned.txt");
    git(group.worktree, "commit", "-q", "-m", "add owned.txt");
    const openTasks = [{ taskNumber: 42, files: ["owned.txt"] }];

    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    assert.deepEqual(results[0].matchedTaskNumbers, [42]);
});

test("test_findUnmergedTaskWorktreesReturnsNoMatchedTasksWhenNoDeclaredFilesOverlap", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "owned.txt"), "brand new\n");
    git(group.worktree, "add", "owned.txt");
    git(group.worktree, "commit", "-q", "-m", "add owned.txt");
    const openTasks = [{ taskNumber: 42, files: ["unrelated.txt"] }];

    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    assert.deepEqual(results[0].matchedTaskNumbers, []);
});
```

Add `findUnmergedTaskWorktrees` to the import list. Red, then implement,
then green, before Step 3.

## Step 3 — CLI `--discover`

### Behavior

`node scripts/mergeTaskWorktrees.ts --discover`, run with the repo as `cwd`,
prints the JSON array `findUnmergedTaskWorktrees` returns, using
`process.cwd()` as `repoRoot`, `currentBranchName(repoRoot)` as
`sourceBranch`, and the open tasks read via `resolveTaskFiles` +
`readTaskFile` from `taskFiles.ts` (same pair-resolution every other skill
script already uses). Read-only — no git mutation.

### Add

Import additions:
```ts
import { currentBranchName } from "./repositoryBranches.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
```
(`currentBranchName` is already imported by `prepareTasks.ts`'s tests, not
by this file yet — add it here.)

```ts
function runDiscoverCli(): void {
    const repoRoot = process.cwd();
    const sourceBranch = currentBranchName(repoRoot);
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    process.stdout.write(JSON.stringify(results));
}
```

Rename the existing `runAsCli` body to `runPipelineCli` (identical contents,
name only), then replace `runAsCli` with a dispatcher:

```ts
function runAsCli(): void {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    runPipelineCli();
}
```

(`runMergeCli` is Step 4 — write both branches together since the dispatcher
references it, or stub it as `function runMergeCli(_worktreePath: string): void {}`
between steps if strict red-green ordering matters more than a compiling
intermediate state; either is fine here since Step 4 follows immediately.)

### Test

```ts
test("test_runAsCliDiscoverPrintsTheSameShapeAsFindUnmergedTaskWorktrees", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const output = execFileSync("node", ["--no-inspect", SCRIPT, "--discover"], { cwd: repoRoot, encoding: "utf8" });
    const parsed = JSON.parse(output);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].worktree, group.worktree);
});
```

No `tasks.json` exists in the temp repo — `readTaskFile` catches the missing
file and returns `[]`, so this needs no fixture setup.

## Step 4 — CLI `--merge <worktree>`

### Behavior

`node scripts/mergeTaskWorktrees.ts --merge <worktreePath>`, run with the
repo as `cwd`. Resolve the parent repo's source branch and submodule paths
via `collectRepositorySources(process.cwd())` (reused, not reimplemented —
this is the same call `prepareTasks.ts` already makes), read the worktree's
own branch via `currentBranchName(worktreePath)`, build a minimal
`PreparedGroup` (`groupId: 0` — nothing downstream of this call reads it,
the group is a single leftover worktree, not a pipeline group), call
`mergeGroupBranchIntoRepo` exactly as the pipeline mode does, and on success
call `removeWorktreeAndBranch`. On conflict, leave the worktree in place
(same behavior the pipeline mode already has) and let the printed
`MergeOutcome` carry the reason.

**Scope limit, deliberate:** this reuses only the four functions named in
the brief. It merges the parent repo's branch (auto-resolving submodule
*gitlink pointer* conflicts, same as the pipeline) but does not merge a
submodule's own content branch the way `mergeSubmoduleBranchIntoRepo` does
for the main pipeline — that function isn't in the reuse list, and wiring it
here means resolving a *second* worktree-relative submodule path pair
per submodule, which the brief doesn't ask for. Note this in the skill body
(Step 5) so the report doesn't silently drop submodule-only work.

### Add

```ts
function runMergeCli(worktreePath: string): void {
    const repoRoot = process.cwd();
    const repositorySources = collectRepositorySources(repoRoot);
    const parentSource = repositorySources.find((source) => source.path === "");
    if (!parentSource) throw new Error(`no recorded source branch for repository path "${repoRoot}"`);
    const submodulePathsDeepestFirst = repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const branch = currentBranchName(worktreePath);
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}
```

Import addition: `collectRepositorySources` alongside `currentBranchName`
from `"./repositoryBranches.ts"`.

### Tests

```ts
test("test_runAsCliMergeRemovesTheWorktreeAndBranchOnACleanMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const output = execFileSync("node", ["--no-inspect", SCRIPT, "--merge", group.worktree], { cwd: repoRoot, encoding: "utf8" });
    const outcome = JSON.parse(output);
    assert.equal(outcome.merged, true);
    assert.equal(existsSync(group.worktree), false);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_runAsCliMergeLeavesTheWorktreeInPlaceAndReportsConflictedFilePathsOnAConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const output = execFileSync("node", ["--no-inspect", SCRIPT, "--merge", group.worktree], { cwd: repoRoot, encoding: "utf8" });
    const outcome = JSON.parse(output);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, ["shared.txt"]);
    assert.equal(existsSync(group.worktree), true);
});
```

Run the full `tests/mergeTaskWorktrees.test.ts` file after this step — every
pre-existing test must still pass unchanged (they exercise the same exported
functions this step leaves untouched).

## Step 5 — `skills/merge-worktree-tasks/SKILL.md`

New file, following this repo's existing skill conventions (see
`skills/close-tasks/SKILL.md`, `skills/update-task-files/SKILL.md` for the
`!` frontmatter-injection / body-instruction split already in use). `mkdir -p
skills/merge-worktree-tasks` first.

```markdown
---
name: merge-worktree-tasks
description: check leftover taskTools worktrees for unmerged commits or uncommitted edits, match them to open tasks by file overlap, and merge back into the repo only after explicit user approval
---

- repo root: !`pwd`
- unmerged worktrees: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/mergeTaskWorktrees.ts" --discover`

Invoke `/ponytail:ponytail ultra`.

The block above is a JSON array of `UnmergedTaskWorktree` objects: `worktree`
(path), `branch`, `unmergedCommitCount`, `hasUncommittedChanges`,
`changedFilePaths`, and `matchedTaskNumbers` — the still-open task numbers
whose declared `files` overlap what changed in that worktree. An empty array
means nothing to merge: say so and stop, do not proceed to any step below.

## Report

List every worktree in the array: branch, worktree path, unmerged commit
count, whether it has uncommitted changes, and its matched task numbers. A
worktree with an empty `matchedTaskNumbers` is still reported — say "no open
task matched" for it, never drop it from the list silently.

## Approval gate

For each reported worktree, ask via `AskUserQuestion` whether to merge it —
name the branch, the worktree path, and the matched task numbers in the
question so the user knows exactly what they're approving. Never merge a
worktree without an explicit approval for that specific worktree; a blanket
"looks fine" for the whole list is not per-worktree approval unless the
question itself was posed that way and the user answered yes to it.

## Merge only what was approved

For every approved worktree, run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/mergeTaskWorktrees.ts" --merge <worktree path>`

Each call prints one `MergeOutcome` JSON object. If `merged: true`, the
worktree and its branch are already removed by the script — report success
and, if it had matched task numbers, note that those tasks' work is now on
the branch you were on when you ran `--discover`. If `merged: false`, report
`conflictedFilePaths` / `failureReason` and leave it — the worktree is still
on disk for manual resolution; do not retry the merge automatically and do
not delete the worktree yourself.

Do not run `--merge` for any worktree the user did not approve.

## Scope note

`--merge` merges only the parent repository's branch (it auto-resolves
submodule *pointer* conflicts the same way the normal tackle-tasks merge
step does). It does not merge a submodule's own content branch. If a
worktree touches a submodule, say so in the report so the user knows to
check that submodule separately — do not claim the merge is complete for
submodule work it didn't touch.
```

## Verification (after all steps)

1. `node --test tests/mergeTaskWorktrees.test.ts` — full file green,
   including every pre-existing test.
2. `npx tsc --noEmit` — no new type errors.
3. Manual sanity check against this repo's real leftover worktrees: from
   the repo root, run `node scripts/mergeTaskWorktrees.ts --discover` and
   confirm the six live `taskTools-wt/taskTools/group-{1..6}` worktrees
   (visible right now via `git worktree list --porcelain`) show up with
   plausible `changedFilePaths` — do **not** run `--merge` on them as part
   of verification, that requires the human approval step the skill exists
   to gate.

## Out of scope (say so, don't build it)

- Submodule content-branch merging in `--merge` (see Step 4's scope-limit
  note) — only add `mergeSubmoduleBranchIntoRepo` wiring here if a later
  task asks for it explicitly.
- Auto-deleting a worktree that has zero unmerged commits and zero
  uncommitted changes (i.e. already fully merged) — `findUnmergedTaskWorktrees`
  already excludes these from the report; cleaning up already-merged
  leftovers is a different, narrower task than this one.
