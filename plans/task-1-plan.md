# Plan: Merge every repository in a tackle-tasks worktree back to its source branch

Implements `~/.claude/plans/submodule-merge-tackle-tasks.md` per `plans/brief-1.md`.

## Root cause being fixed

`mergeTaskWorktrees.ts` merges only the parent branch, then `removeWorktreeAndBranch` runs
`git worktree remove --force`, deleting `<main>/.git/worktrees/<name>/modules/<submodule>` —
the only git directory that ever held the submodule's worker commits. Fix: treat a worktree as
a set of repositories (parent + every submodule, any depth), branch and merge all of them the
same way, and delete nothing.

## Design decisions carried into every step below

- `createBranchInEveryRepository` operates on the **worktree's** copy of each repository (parent
  + submodules), not the main repo's. `git submodule update --init --recursive` leaves worktree
  submodules on a **detached HEAD** at the exact commit the parent's tree recorded — that
  detachment is normal and must NOT trip the same "refuse on detached HEAD" check used at
  prepare time. So the function must check out `branchName` (creating it if absent), never just
  create-without-checkout, and it takes plain paths, not `RepositorySource[]`.
- `collectRepositorySources` runs once, on the **source repo** (`repoRoot`), before any worktree
  exists, purely to (a) record each repository's current branch as its merge destination and
  (b) refuse if anything is detached. It never touches a worktree.
- `mergeGroupBranchIntoRepo` and `mergeSubmoduleBranchIntoRepo` both explicitly `checkout` the
  recorded source branch before merging — do not rely on the process's cwd already being on the
  right branch, since the rule must be uniform across parent and submodules and the merge script
  can run in any state.
- Submodules merge deepest-first (most path segments first) so a nested submodule's branch lands
  before the submodule that references it, and the parent merges last so its gitlink conflict
  resolves against an already-merged submodule commit.
- A submodule merge conflict marks the whole group conflicted and the parent merge for that
  group is skipped entirely (parent is left untouched, still on whatever branch/commit it had).
- `removeWorktreeAndBranch` stays in `mergeTaskWorktrees.ts`, untouched, with its existing direct
  unit tests untouched — it's just never called from `runAsCli` anymore. This matches the
  brief's verification step ("re-add the `removeWorktreeAndBranch` call and confirm the
  worktree-survives test fails"), which only works if the function still exists to be re-added.

## Order of work (strict RED → GREEN per file)

### Step 1 (RED): `tests/repositoryBranches.test.ts` (new file)

Write these failing tests against not-yet-existing `scripts/repositoryBranches.ts`:

- `test_submodulePathsListsTheParentRepositorysSubmodules` — repo with a `vendor` submodule;
  `submodulePaths(repoRoot)` returns `["vendor"]`. Repo with no submodules returns `[]`.
- `test_collectRepositorySourcesIncludesTheParentAndEverySubmodule` — returns entries for
  `path: ""` (parent) and `path: "vendor"`, each with the correct `sourceBranch` (read the
  actual current branch via `git branch --show-current`, don't hardcode `"master"`/`"main"`).
- `test_collectRepositorySourcesThrowsNamingEveryDetachedRepository` — detach the submodule
  (`git -C vendor checkout --detach HEAD`); assert the thrown message contains `"vendor"`. Also
  cover the parent itself detached.
- `test_createBranchInEveryRepositoryChecksOutTheBranchInParentAndSubmodule` — call with
  `paths: ["", "vendor"]`, a fresh worktree-like checkout (submodule left on detached HEAD after
  `submodule update --init`), assert both the parent and `vendor` report the new branch via
  `git branch --show-current`.
- `test_createBranchInEveryRepositoryIsIdempotentWhenTheBranchAlreadyExists` — call it twice
  with the same paths/branch name; second call does not throw.

Reuse the `GIT_ALLOW_PROTOCOL="file"` submodule fixture pattern already in
`tests/prepareTasks.test.ts` (`makeTempRepoWithLocalSubmodule`).

### Step 2 (GREEN): `scripts/repositoryBranches.ts` (new file)

```
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export type RepositorySource = {
    path: string;          // "" for the parent repo, else the submodule displaypath
    sourceBranch: string;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

export function currentBranchName(repoRoot: string): string {
    return git(repoRoot, "branch", "--show-current");
}

export function submodulePaths(repoRoot: string): string[] {
    const output = execFileSync(
        "git",
        ["-C", repoRoot, "submodule", "--quiet", "foreach", "--recursive", "echo $displaypath"],
        { encoding: "utf8" },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function collectRepositorySources(repoRoot: string): RepositorySource[] {
    const paths = ["", ...submodulePaths(repoRoot)];
    const detachedPaths: string[] = [];
    const sources: RepositorySource[] = [];
    for (const path of paths) {
        const fullPath = path === "" ? repoRoot : join(repoRoot, path);
        const branch = currentBranchName(fullPath);
        if (branch === "") {
            detachedPaths.push(path === "" ? "(parent)" : path);
            continue;
        }
        sources.push({ path, sourceBranch: branch });
    }
    if (detachedPaths.length > 0) {
        throw new Error(
            `these repositories are on a detached HEAD and cannot be task-branched: ${detachedPaths.join(", ")}`,
        );
    }
    return sources;
}

function branchExists(repoRoot: string, branchName: string): boolean {
    try {
        execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

export function createBranchInEveryRepository(repoRoot: string, paths: string[], branchName: string): void {
    for (const path of paths) {
        const fullPath = path === "" ? repoRoot : join(repoRoot, path);
        if (currentBranchName(fullPath) === branchName) continue;
        if (branchExists(fullPath, branchName)) {
            git(fullPath, "checkout", branchName);
        } else {
            git(fullPath, "checkout", "-b", branchName);
        }
    }
}
```

Run `node --test tests/repositoryBranches.test.ts` until green before moving on.

### Step 3 (RED): update `tests/prepareTasks.test.ts`

Add:

- `test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch` — after `createWorktreeForGroup`,
  `git -C <worktree>/vendor branch --show-current` equals `"task-group-1"`.
- `test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory` —
  detach `vendor` in `repoRoot`, call `buildWorkflowArguments`, assert it throws AND
  `existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "group-1"))` is `false`
  (import `basename`, `tmpdir`).
- `test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch` — assert
  `workflowArguments.repositorySources` has one entry with `path: ""` and one with
  `path: "vendor"`.

### Step 4 (GREEN): update `scripts/prepareTasks.ts`

- Import `collectRepositorySources`, `createBranchInEveryRepository`, `submodulePaths` from
  `./repositoryBranches.ts`.
- `WorkflowArguments` gains `repositorySources: RepositorySource[]`.
- `createWorktreeForGroup` — after the existing `initializeSubmodulesInWorktree(worktreePath)`
  call, add:
  ```
  createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchNameForGroup(group.groupId));
  ```
  (The `""` entry is a no-op when `git worktree add -b` already put the parent on that branch;
  it only matters on a re-run against an already-existing worktree.)
- `buildWorkflowArguments` — call `collectRepositorySources(repoRoot)` as the **first**
  statement in the function body, before the `groups.map(...)` that creates worktrees, so a
  detached submodule throws before any worktree directory is created. Thread the result into
  the returned object as `repositorySources`.
- `runAsCli` — no change needed beyond `buildWorkflowArguments` already returning the new field;
  it's spread into stdout via `...workflowArguments` already.

Run `node --test tests/prepareTasks.test.ts` until green.

### Step 5 (RED): update `tests/mergeTaskWorktrees.test.ts`

Update existing calls to `mergeGroupBranchIntoRepo` (its signature is changing — see Step 6) to
pass `sourceBranch` and `submodulePaths`:
- Capture `const sourceBranch = currentBranchName(repoRoot);` (import from
  `../scripts/repositoryBranches.ts`) right after `makeTempRepoWithCommit()`, before any branch
  switching, and pass it as the third argument; pass `[]` as the fourth (no submodules in these
  scenarios) so existing conflict/success assertions keep passing unchanged.

Add:

- `test_mergeGroupBranchIntoRepoChecksOutTheSourceBranchBeforeMerging` — check out some other
  branch in `repoRoot` before calling `mergeGroupBranchIntoRepo`; after the call, `git -C
  repoRoot branch --show-current` equals the passed `sourceBranch` and the group's new file is
  present.
- `test_mergeSubmoduleBranchSurvivesEvenWhenTheGroupConflicts` (the data-loss regression test) —
  build a repo+submodule fixture, create a worktree group, cause a conflicting edit to the
  **submodule's** file on both the worktree submodule branch and the main submodule's source
  branch so `mergeSubmoduleBranchIntoRepo` reports `merged: false`. Then assert
  `git -C <mainSubmodulePath> branch --list <groupBranch>` still lists the branch — the fetch
  step must have created it before the merge attempt.
- `test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge` — drive `runAsCli`
  end-to-end (spawn it the same way other CLI-entry-point tests in this repo already spawn a
  script under test — check `package.json`'s test script / any existing subprocess-invocation
  helper before writing a new one, and match it) with a clean, non-conflicting group. Assert
  `existsSync(group.worktree)` is `true` and `git -C repoRoot branch --list <branch>` still
  lists the group branch afterward.
- `test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict` — conflict only on the
  submodule gitlink path (e.g. by merging two branches that both moved the submodule pointer,
  where the working tree already has the intended resolved commit checked out); assert the
  function returns `{ resolved: true, ... }` and the merge commit exists (no `MERGE_HEAD`).
- `test_resolveGitlinkConflictsAbortsOnANonSubmoduleConflict` — reuse the existing
  `shared.txt` conflict scenario; assert `resolved: false`, `unexpectedConflicts` includes
  `"shared.txt"`, and `MERGE_HEAD` is gone (merge was aborted).

### Step 6 (GREEN): update `scripts/mergeTaskWorktrees.ts`

- Import `currentBranchName` from `./repositoryBranches.ts`, and `RepositorySource` as a type.
- `MergeOutcome` gains `submoduleConflicts: Array<{ path: string; conflictedFilePaths: string[] }>`
  (populate `[]` on the non-submodule-conflict paths so existing shape stays valid).
- `mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, submodulePaths = [])`:
  ```
  export function mergeGroupBranchIntoRepo(
      repoRoot: string,
      group: PreparedGroup,
      sourceBranch: string,
      submodulePaths: string[] = [],
  ): MergeOutcome {
      git(repoRoot, "checkout", sourceBranch);
      try {
          git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
          return { groupId: group.groupId, merged: true, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree };
      } catch {
          const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
          if (resolution.resolved) {
              return { groupId: group.groupId, merged: true, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree };
          }
          return { groupId: group.groupId, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, submoduleConflicts: [], worktree: group.worktree };
      }
  }
  ```
- `resolveGitlinkConflicts(repoRoot, submodulePaths)`:
  ```
  export function resolveGitlinkConflicts(
      repoRoot: string,
      submodulePaths: string[],
  ): { resolved: boolean; unexpectedConflicts: string[] } {
      const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
      const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
      if (unexpectedConflicts.length > 0) {
          git(repoRoot, "merge", "--abort");
          return { resolved: false, unexpectedConflicts };
      }
      for (const path of conflictedPaths) git(repoRoot, "add", path);
      git(repoRoot, "commit", "--no-edit");
      return { resolved: true, unexpectedConflicts: [] };
  }
  ```
- `mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch)`:
  ```
  export function mergeSubmoduleBranchIntoRepo(
      mainSubmodulePath: string,
      worktreeSubmodulePath: string,
      sourceBranch: string,
  ): { merged: boolean; conflictedFilePaths: string[] } {
      const groupBranch = currentBranchName(worktreeSubmodulePath);
      git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
      git(mainSubmodulePath, "checkout", sourceBranch);
      try {
          git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
          return { merged: true, conflictedFilePaths: [] };
      } catch {
          const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
          git(mainSubmodulePath, "merge", "--abort");
          return { merged: false, conflictedFilePaths };
      }
  }
  ```
  The fetch's `:refs/heads/<groupBranch>` half is what makes the commits permanent in the main
  submodule repo *before* the merge is attempted — do not fold this into a single `git pull` or
  drop the destination ref, or a conflict-and-abort loses the branch again.
- `runAsCli`:
  ```
  function runAsCli(): void {
      const input: CliInput = JSON.parse(process.argv[2]);
      const workflowArguments: WorkflowArguments = {
          repo: input.repo,
          typecheckCommand: input.typecheckCommand,
          groups: input.groups,
          repositorySources: input.repositorySources,
      };
      const sortedGroups = [...workflowArguments.groups].sort((a, b) => a.groupId - b.groupId);
      const submodulePathsDeepestFirst = workflowArguments.repositorySources
          .map((source) => source.path)
          .filter((path) => path !== "")
          .sort((a, b) => b.split("/").length - a.split("/").length);
      const findSourceBranch = (path: string): string => {
          const found = workflowArguments.repositorySources.find((source) => source.path === path);
          if (!found) throw new Error(`no recorded source branch for repository path "${path}"`);
          return found.sourceBranch;
      };

      const merged: MergeOutcome[] = [];
      const conflicts: MergeOutcome[] = [];
      for (const group of sortedGroups) {
          const submoduleConflicts: Array<{ path: string; conflictedFilePaths: string[] }> = [];
          for (const submodulePath of submodulePathsDeepestFirst) {
              const outcome = mergeSubmoduleBranchIntoRepo(
                  join(workflowArguments.repo, submodulePath),
                  join(group.worktree, submodulePath),
                  findSourceBranch(submodulePath),
              );
              if (!outcome.merged) submoduleConflicts.push({ path: submodulePath, conflictedFilePaths: outcome.conflictedFilePaths });
          }
          if (submoduleConflicts.length > 0) {
              conflicts.push({ groupId: group.groupId, merged: false, conflictedFilePaths: [], submoduleConflicts, worktree: group.worktree });
              continue;
          }
          const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
          if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
      }
      // ... existing appendRunMetricsRecord block unchanged, conflictCount: conflicts.length ...  no removeWorktreeAndBranch calls anywhere in this function anymore
      process.stdout.write(JSON.stringify({ merged, conflicts }));
  }
  ```
  Add `import { join } from "node:path";` if not already present.
- Do not modify `removeWorktreeAndBranch` itself — leave it defined and exported, just delete
  the two call sites that used to invoke it inside the old `runAsCli` loop.

Run `node --test tests/mergeTaskWorktrees.test.ts` until green.

### Step 7: full-suite and regression verification (matches brief's Verification section exactly)

1. `node --test 'tests/*.test.ts'` — all green.
2. Temporarily re-add a `removeWorktreeAndBranch(...)` call inside `runAsCli`'s success branch,
   rerun the worktree-survives test, confirm it now fails, then revert the temporary edit.
3. Temporarily change the fetch refspec in `mergeSubmoduleBranchIntoRepo` from
   `` `${groupBranch}:refs/heads/${groupBranch}` `` to plain `groupBranch` (drop the destination
   half), rerun the conflict-survival test, confirm it now fails, then revert.
4. End-to-end smoke test on a scratch repo: parent repo and one submodule both on `develop`,
   run `prepareTasks.ts` → simulate a worker commit in both the parent worktree and the
   submodule worktree → run `mergeTaskWorktrees.ts` → confirm both `develop` branches contain
   the new commits and both worktrees/branches still exist on disk.

## Known, accepted consequences (do not treat as bugs to fix in this task)

- A run is refused outright if any submodule in the source repo sits on a detached HEAD at
  prepare time.
- Worktrees and `task-group-N` branches accumulate indefinitely — no cleanup path remains after
  this change. This is intentional per the brief; do not add cleanup as part of this task.

## Line-count note

`scripts/mergeTaskWorktrees.ts` is short today (~80 lines); after adding
`mergeSubmoduleBranchIntoRepo`, `resolveGitlinkConflicts`, and the expanded `runAsCli` it will
grow but should stay comfortably under the 250-line cap. If it doesn't, split the merge-specific
helpers (`mergeSubmoduleBranchIntoRepo`, `resolveGitlinkConflicts`) into a sibling module before
`runAsCli` grows further, the same way `repositoryBranches.ts` was split out of `prepareTasks.ts`.
