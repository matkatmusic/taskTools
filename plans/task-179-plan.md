# Task 179 plan: record the real merge commit at merge time (C86-14)

## Problem

In `mergeTaskDeepestFirst` (scripts/mergeTaskWorktrees.ts), the skipped/no-op
branch (currently lines 568-574) records `git rev-parse baseBranch` — the
CURRENT source tip — as the occurrence's `oid`, on the assumption that the
tip is the merge commit. That assumption breaks on a merged-but-not-closed
retry: if task A merges, `closeTasks` fails, task B later merges and
advances `baseBranch`, and A is then retried, A hits the no-op path (its
operation branch is already an ancestor of `baseBranch`) and gets archived
with B's later tip instead of the commit that actually merged A.
`skills/tackle-tasks/task.workflow.js:706-707` reads `rootLayer.oid` as
`mergedCommitHash` and passes it straight to `closeTasks`.

## Fix design

Record the real merge commit the moment it is created (in the two "merged"
branches of `mergeTaskDeepestFirst`, for both submodule and root
occurrences) as a git ref scoped to that occurrence's own checkout,
keyed by `operationBranch`:

```
refs/taskTools/merged-commits/<operationBranch>
```

Each occurrence's ref lives in its own repo (`sourceCheckoutPath`), so a
root occurrence and a submodule occurrence sharing the same
`operationBranch` name (`task-N`) never collide — they write into different
`.git` directories.

The no-op/skip branch then reads that ref first, via `git rev-parse
refs/taskTools/merged-commits/<operationBranch>`, and uses its value as
`oid` when it exists. When the ref does not exist — meaning this occurrence
was never actually merged by `mergeTaskDeepestFirst` at all (task made no
change here, so there never was a merge commit to misattribute) — it falls
back to the current `git rev-parse baseBranch`, which is correct in that
case because nothing else can have advanced `baseBranch` on behalf of this
occurrence.

This satisfies the brief's fix direction exactly: the value is recorded at
merge time, persisted (as a ref, not by searching history), and reused by
the retry's no-op path instead of being re-derived by guessing at the
current tip.

`skills/tackle-tasks/task.workflow.js` needs no edit: it already reads
`rootLayer.oid` off whichever `MergeLayerOutcome` matched `occurrenceId ===
'root'`, regardless of whether that outcome's `status` is `"merged"` or
`"no-op"`. Once `mergeTaskDeepestFirst`'s no-op branch reports the correct
persisted oid, `mergedCommitHash` is correct without any change to how
`task.workflow.js` reads it.

## File: scripts/mergeTaskWorktrees.ts

### Edit 1 — add the ref helpers

Current text (lines 476-479):

```
function displayOccurrenceId(occurrenceId: string): string {
    return occurrenceId === "" ? "root" : occurrenceId;
}

export type MergeLayerOutcome =
```

Becomes:

```
function displayOccurrenceId(occurrenceId: string): string {
    return occurrenceId === "" ? "root" : occurrenceId;
}

function mergedCommitRefName(operationBranch: string): string {
    return `refs/taskTools/merged-commits/${operationBranch}`;
}

// Records the merge commit at merge time so a later retry's no-op path reuses it instead of guessing.
function recordMergedCommit(repoRoot: string, operationBranch: string, oid: string): void {
    git(repoRoot, "update-ref", mergedCommitRefName(operationBranch), oid);
}

function readRecordedMergedCommit(repoRoot: string, operationBranch: string): string | null {
    try {
        return git(repoRoot, "rev-parse", mergedCommitRefName(operationBranch)).trim();
    } catch {
        return null;
    }
}

export type MergeLayerOutcome =
```

### Edit 2 — the no-op/skip branch reads the recorded commit first

Current text (lines 568-574):

```
        if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "no-op", oid });
            if (occurrence.parentOccurrenceId !== null) git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
            continue;
        }
```

Becomes:

```
        if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
            const oid = readRecordedMergedCommit(sourceCheckoutPath, occurrence.operationBranch) ?? git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "no-op", oid });
            if (occurrence.parentOccurrenceId !== null) git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
            continue;
        }
```

(Only the `const oid = ...` line changes.)

### Edit 3 — record the commit right after a submodule merge

Current text (lines 597-601):

```
            git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
            continue;
```

Becomes:

```
            git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
            continue;
```

(A single new line, `recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);`, is inserted after the `const oid = ...` line.)

### Edit 4 — record the commit right after the root/parent merge

Current text (lines 627-630):

```
        const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
        sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
        completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
    }
```

Becomes:

```
        const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
        recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);
        sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
        completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
    }
```

(A single new line, `recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);`, is inserted after the `const oid = ...` line. This block is distinguished from Edit 3's identical-looking `const oid` line by its surrounding text — no preceding `branch "-D"` line, and it is followed directly by the closing `}` of the `for` loop and `return { status: "merged", completedLayers };` — so apply this edit to the *second* occurrence of the `const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();` / `sourceTipByOccurrenceId.set` / `completedLayers.push(...)` triple in the file, i.e. the one inside the root-handling branch after the `directChildPathsInParent` / `mergeStepOperations.mergeGroup` block, not the one inside the submodule branch handled by Edit 3.)

No other edits to this file. `unmergedCommitCount`, `propagateChildGitlinks`, `mergeGroupBranchIntoRepo`, `mergeSubmoduleBranchIntoRepo`, `resolveGitlinkConflicts`, and every function outside `mergeTaskDeepestFirst` are untouched — the bug and its fix are both scoped to that one function's skip/merge branches.

## File: skills/tackle-tasks/task.workflow.js

No edit needed. `runMerge` (lines 680-726) reads `mergedCommitHash` from
`rootLayer.oid` at line 706-707:

```
  const rootLayer = report.completedLayers.find((layer) => layer.occurrenceId === 'root');
  const mergedCommitHash = rootLayer.oid;
```

This already works for both `"merged"` and `"no-op"` outcomes — it just
reads whatever `oid` `mergeTaskDeepestFirst` reported. Once
`mergeTaskDeepestFirst`'s no-op branch reports the persisted merge commit
instead of the current source tip (Edit 2 above), `mergedCommitHash` is
correct on a merged-but-not-closed retry with no change here.

## File: tests/mergeTaskWorktrees.test.ts

No edit needed. Reviewed every `mergeTaskDeepestFirst` test in the file
(lines 1403-1743) against the fix:

- Tests that only ever run one merge lap (no retry) are unaffected: the
  ref is written but nothing re-reads it in the same run, and the "merged"
  status oid computation (`git rev-parse baseBranch` right after a real
  merge) is unchanged.
- `test_mergeTaskDeepestFirstSkipsAnOccurrenceAlreadyMergedIntoItsSourceWithoutInvokingItsRebaseOrMergeStep`
  (lines 1617-1648) pre-merges the submodule by calling
  `mergeSubmoduleBranchIntoRepo` *directly*, bypassing
  `mergeTaskDeepestFirst` entirely, so no `refs/taskTools/merged-commits/*`
  ref is ever written for that occurrence. When `mergeTaskDeepestFirst`
  then hits the no-op branch for it, `readRecordedMergedCommit` finds no
  ref and falls back to `git rev-parse baseBranch`, which still equals
  `submoduleOidAfterPreMerge` (asserted at line 1647) because nothing else
  advanced the submodule's source branch in that test. The assertion still
  holds unchanged.
- No test in this file asserts an exhaustive `for-each-ref` listing after
  calling `mergeTaskDeepestFirst`, so the new `refs/taskTools/merged-commits/*`
  refs do not trip any ref-count assertion.

## File: tests/taskWorkflowMergeStage.test.ts

### Edit — add one new regression test reproducing C86-14

Insert a new test immediately after the existing test `'a lap that merges
but cannot close keeps the worktree, and its retried cleanup makes no
second commit'` (which currently ends at line 182 with the closing `})`),
i.e. insert directly before line 184's
`test('rebase stage: a failing rebase command blocks the lap before any agent runs', async () => {`.

Insert this text between line 182 and line 184:

```

// C86-14: an unrelated later commit on main must not get archived as this task's hash.
test('a merged-but-not-closed retry archives the original merge commit even after main advances in between', async () => {
  const taskNumber = 9010
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')

    rmSync(join(root, '.taskTools', 'completedTasks.json'))
    mkdirSync(join(root, '.taskTools', 'completedTasks.json'))

    const first = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    const firstOutcome = first.results[0] as { status: string, mergedCommitHash: string }
    assert.equal(firstOutcome.status, 'merged-but-not-closed')

    rmSync(join(root, '.taskTools', 'completedTasks.json'), { recursive: true, force: true })
    writeFileSync(join(root, '.taskTools', 'completedTasks.json'), '[]')

    writeFileSync(join(root, 'advanced-by-another-task.txt'), 'another task merged later\n')
    git(root, 'add', 'advanced-by-another-task.txt')
    git(root, 'commit', '-q', '-m', 'unrelated later merge advances main')

    const second = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    const secondOutcome = second.results[0] as { status: string, mergedCommitHash: string, closed: number[] }
    assert.equal(secondOutcome.status, 'merged')
    assert.deepEqual(secondOutcome.closed, [taskNumber])
    assert.equal(secondOutcome.mergedCommitHash, firstOutcome.mergedCommitHash)
    assert.notEqual(secondOutcome.mergedCommitHash, git(root, 'rev-parse', 'main'))

    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived[0].commitHashes, [firstOutcome.mergedCommitHash])
  } finally {
    removeFixture(root, worktreePath)
  }
})
```

This test fails against the current (pre-fix) code — the second lap's
no-op branch would report `git rev-parse main` (the tip *after* the
`advanced-by-another-task.txt` commit) as `mergedCommitHash`, so
`secondOutcome.mergedCommitHash` would equal `firstOutcome.mergedCommitHash`'s
successor rather than itself, and `assert.notEqual(secondOutcome.mergedCommitHash,
git(root, 'rev-parse', 'main'))` would fail. After the fix (Edits 1-4 in
scripts/mergeTaskWorktrees.ts) it passes, because the retry's no-op branch
reads the ref recorded during the first lap's real merge instead of the
current tip of `main`.

No other edit to this file. Every helper it already imports/uses
(`makeRootWithWorktree`, `seedTaskFiles`, `runMergeStage`, `git`) is reused
as-is; no new import is needed since `rmSync`, `mkdirSync`, `writeFileSync`,
`readFileSync`, `join` are already imported at the top of the file
(line 4-6).

## Verification

1. `npx tsc --noEmit` from the repo root — expect no errors (the two new
   helper functions and their two call-site edits are ordinary
   already-typed `string`/`void` functions using the same `git()` helper
   already declared in the file; no new types are introduced).
2. `npm test` from the repo root — expect all tests in
   `tests/mergeTaskWorktrees.test.ts` and `tests/taskWorkflowMergeStage.test.ts`
   to pass, including the new test
   `'a merged-but-not-closed retry archives the original merge commit even after main advances in between'`,
   with the full suite reporting `# fail 0`.
