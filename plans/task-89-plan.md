# Task 89 Plan: rebase step in scripts/mergeTaskWorktrees.ts

## Why (read once, not repeated per line below)

Task 88 was split into 4 children; this is child 1 of 4. It owns only the
rebase mechanics: rebase the group's linked worktree onto the current tip of
the source branch, and return a discriminated result. It must not run tests,
retry the merge, or emit a verdict — those belong to sibling children editing
`scripts/runMergePhase.ts`, `tests/runMergePhase.test.ts`, and
`scripts/mergePipeline.ts`.

Everything this task requires — the `RebaseOutcome` type, `rebaseGitPath`,
`rebaseInProgress`, `collectConflictedRebasePaths`, `abortRebase`, and
`rebaseGroupOntoSource` — lives in `scripts/mergeTaskWorktrees.ts`, matching
the task's `files` field of exactly `["scripts/mergeTaskWorktrees.ts"]`. No
second script file is created.

Decision flow (final — matches the codex review exactly, six outcomes):

1. Successful rebase -> `rebased-clean`.
2. Failed rebase, no rebase state in progress -> `cleanup-failed`, carrying
   the rebase error.
3. Rebase state in progress with conflicts -> collect the conflicting
   paths, abort the rebase, then return `conflicted`.
4. Abort succeeded but the collected conflict-path list is empty ->
   `cleanup-failed` carrying the original rebase error. This must never
   return `conflicted` with an empty `conflictedFilePaths` array.
5. Abort failed -> `cleanup-failed` carrying both the original rebase error
   (plus the detection/collection error, if one occurred first) and the
   abort error.
6. Rebase-state detection failure or conflict-collection failure -> still
   attempt the abort, and report both the triggering error and the abort
   error (if abort also failed).

Detection, collection, and the abort call are each wrapped in their own
try/catch inside `rebaseGroupOntoSource`; their errors are captured into
named variables (`stateError`, `collectionError`) and folded into
`failureReason` — never silently swallowed into `false` or `[]`.

## Edit 1 — scripts/mergeTaskWorktrees.ts: add `isAbsolute` to the existing import

Current text (line 3):
```
import { basename, join } from "node:path";
```

Becomes:
```
import { basename, isAbsolute, join } from "node:path";
```

No new import line — this only adds `isAbsolute` to the existing named
import list. No other change to the top of the file.

## Edit 2 — scripts/mergeTaskWorktrees.ts: insert the rebase type and functions

Current text (lines 100-104, unchanged from the live file):
```
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export function mergeGroupBranchIntoRepo(
```

Becomes (insert one blank line, then the block below, then one blank line,
before `export function mergeGroupBranchIntoRepo(`):
```
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export type RebaseOutcome =
    | { status: "rebased-clean" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string };

function rebaseGitPath(worktreePath: string, relativePath: string): string {
    const output = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    return isAbsolute(output) ? output : join(worktreePath, output);
}

function rebaseInProgress(worktreePath: string): boolean {
    return existsSync(rebaseGitPath(worktreePath, "rebase-merge")) || existsSync(rebaseGitPath(worktreePath, "rebase-apply"));
}

function collectConflictedRebasePaths(worktreePath: string): string[] {
    return git(worktreePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

function abortRebase(worktreePath: string): { aborted: boolean; failureReason: string | null } {
    try {
        git(worktreePath, "rebase", "--abort");
        return { aborted: true, failureReason: null };
    } catch (error) {
        return { aborted: false, failureReason: gitErrorText(error) };
    }
}

function combineFailureReasons(...parts: (string | null)[]): string {
    return parts.filter((part): part is string => part !== null).join("; ");
}

export function rebaseGroupOntoSource(worktreePath: string, sourceBranch: string): RebaseOutcome {
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        const originalReason = gitErrorText(rebaseError);

        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: originalReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(collectionError), abortFailure) };
        }

        const abortResult = abortRebase(worktreePath);
        if (!abortResult.aborted) {
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, `abort also failed: ${abortResult.failureReason}`) };
        }

        if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: originalReason };

        return { status: "conflicted", conflictedFilePaths };
    }
}

export function mergeGroupBranchIntoRepo(
```

No other edits to `scripts/mergeTaskWorktrees.ts`. Every other line (the
rest of the imports, `git`, `gitErrorText`, `parseWorktreeListPorcelain`,
`listTaskWorktrees`, `unmergedCommitCount`, `commitChangedFiles`,
`uncommittedChangedFiles`, `findUnmergedTaskWorktrees`, and everything from
`mergeGroupBranchIntoRepo` onward — `resolveGitlinkConflicts`,
`mergeSubmoduleBranchIntoRepo`, `removeWorktreeAndBranch`, the CLI functions,
and the CLI entry guard) is unchanged, since those belong to the merge step
(sibling scope) or to worktree discovery, not to this task's rebase step.
No second file is created.

This satisfies the brief's hard constraints, mapped onto the six-branch
decision flow in the "Why" section above:
- Constraint 2 (finding 3): `rebaseGitPath` uses `git rev-parse --git-path`
  output as-is when `isAbsolute(output)` is true, and only joins onto
  `worktreePath` when it is relative.
- Constraint 3 ("nothing can throw out of the function"): rebase-state
  detection (branch 6, `stateError`), conflict-path collection (branch 6,
  `collectionError`), and the abort call are each wrapped in their own
  try/catch inside `rebaseGroupOntoSource`. `abortRebase` never throws — it
  converts its own failure into `{ aborted: false, failureReason }` — so
  nothing ever escapes the exported entry point.
- Constraint 4: rebase state is only ever read through
  `git rev-parse --git-path`, via `rebaseGitPath` — no direct
  `group/.git/...` path construction anywhere.
- Branch 2: a failed rebase with `inProgress === false` returns
  `cleanup-failed` carrying only `originalReason`, with no abort attempted
  (there is nothing to abort).
- Branch 4: even after a successful abort, an empty `conflictedFilePaths`
  falls through to `cleanup-failed` carrying `originalReason` — it is never
  reported as `conflicted` with an empty array.
- Branches 5 and 6: `stateError`/`collectionError` are never silently
  treated as "not in progress" / "no conflicts" — each still triggers an
  abort attempt, and `combineFailureReasons` folds the original rebase
  error, the triggering error (if any), and the abort error (if abort also
  failed) into one `failureReason` string, so the original error is never
  dropped.
- Branch 3: conflicts are collected before the abort runs, so
  `conflictedFilePaths` reflects the pre-abort state.
- `conflicted` (branch 3) is returned only when detection succeeded,
  collection succeeded, abort succeeded, AND the collected list is
  non-empty; every other path returns `cleanup-failed`.

## Edit 3 — tests/mergeTaskWorktrees.test.ts: add rebase tests

Current text (line 7):
```
import { dirname, join } from "node:path";
```
Becomes:
```
import { dirname, isAbsolute, join } from "node:path";
```

Current text (lines 13-18):
```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```
Becomes:
```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

Current text (last 4 lines of the file, lines 650-653):
```
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "tasks.json"), []);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "completedTasks.json"), [9102]);
    for (const path of clean.runFiles) assert.equal(existsSync(path), false);
});
```
Becomes (unchanged, then append the block below at end of file):
```
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "tasks.json"), []);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "completedTasks.json"), [9102]);
    for (const path of clean.runFiles) assert.equal(existsSync(path), false);
});

function gitPathExists(worktreePath: string, relativePath: string): boolean {
    const raw = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    const full = isAbsolute(raw) ? raw : join(worktreePath, raw);
    return existsSync(full);
}

test("test_rebaseGroupOntoSourceReportsRebasedCleanForANonConflictingRebase", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "group.txt"), "group work\n");
    git(group.worktree, "add", "group.txt");
    git(group.worktree, "commit", "-q", "-m", "group work");

    writeFileSync(join(repoRoot, "main.txt"), "main advance\n");
    git(repoRoot, "add", "main.txt");
    git(repoRoot, "commit", "-q", "-m", "advance main");

    const outcome = rebaseGroupOntoSource(group.worktree, sourceBranch);
    assert.deepEqual(outcome, { status: "rebased-clean" });
});

test("test_rebaseGroupOntoSourceReportsConflictedPathsAndLeavesNoRebaseInProgress", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
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

    const outcome = rebaseGroupOntoSource(group.worktree, sourceBranch);
    assert.deepEqual(outcome, { status: "conflicted", conflictedFilePaths: ["shared.txt"] });
    assert.equal(gitPathExists(group.worktree, "rebase-merge"), false);
    assert.equal(gitPathExists(group.worktree, "rebase-apply"), false);
});

test("test_rebaseGroupOntoSourceReportsCleanupFailedWhenAbortFails", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
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

    // Only intercepts abortRebase's "-C <worktree> rebase --abort"; the earlier real rebase call above still hits real git.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), "fake-git-"));
    const shimPath = join(shimDir, "git");
    writeFileSync(
        shimPath,
        [
            "#!/bin/sh",
            'if [ "$1" = "-C" ] && [ "$3" = "rebase" ] && [ "$4" = "--abort" ]; then',
            '  echo "fake abort failure" >&2',
            "  exit 1",
            "fi",
            `exec "${realGit}" "$@"`,
            "",
        ].join("\n"),
    );
    execFileSync("chmod", ["+x", shimPath]);

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    let outcome;
    try {
        outcome = rebaseGroupOntoSource(group.worktree, sourceBranch);
    } finally {
        process.env.PATH = originalPath;
    }

    assert.equal(outcome.status, "cleanup-failed");
    if (outcome.status === "cleanup-failed") assert.match(outcome.failureReason, /abort also failed: fake abort failure/);
});
```

No other edits to `tests/mergeTaskWorktrees.test.ts`. All three new tests reuse the
file's existing `makeTempRepoWithCommit`, `makeGroup`, and `git` helpers, so every
worktree they exercise is a real linked worktree created via
`createWorktreeForGroup` (`git -C repoRoot worktree add -B task-group-N worktreePath HEAD`
in `scripts/prepareTasks.ts`), never an independent clone.

## Verification

Run from the repo root `/Users/matkatmusicllc/Programming/taskTools`.

### 1. Rebase tests pass
```
node --test tests/mergeTaskWorktrees.test.ts
```
Expected: all tests pass, including the three added in Edit 3, and no
existing test in the file regresses.

### 2. No stray edits outside scope
```
git diff --stat scripts/mergeTaskWorktrees.ts tests/mergeTaskWorktrees.test.ts
git status --porcelain scripts/ tests/
```
Expected: `scripts/mergeTaskWorktrees.ts` shows only the two inserted
regions from Edit 1 and Edit 2; `tests/mergeTaskWorktrees.test.ts` shows
only the import updates and the appended tests from Edit 3; no other file
under `scripts/` or `tests/` is modified or added (in particular,
`scripts/runMergePhase.ts`, `scripts/mergePipeline.ts`, and
`tests/runMergePhase.test.ts` are untouched — those belong to sibling
children).
