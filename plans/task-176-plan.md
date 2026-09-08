# Task 176 plan: recognize task-N worktrees in listTaskWorktrees (audit C86-11)

## Problem

`listTaskWorktrees` in `scripts/mergeTaskWorktrees.ts` filters worktree basenames
against the retired naming convention `/^group-\d+$/` (line 59). The current
preparer (`createWorktreeForGroup` in `scripts/prepareTasks.ts`) creates worktrees
named `task-N`, so `listTaskWorktrees` never matches any worktree the current
implementation creates. `findUnmergedTaskWorktrees` calls `listTaskWorktrees`, so
the `--discover` recovery CLI path finds nothing to recover.

Per the brief's settled LEGACY DECISION: do not report, migrate, or delete the
leftover `group-*` worktrees / `task-group-*` branches from the retired
implementation. They are untouched and unmentioned by this change.

## Edits

### scripts/mergeTaskWorktrees.ts

One edit, line 59, inside `listTaskWorktrees`:

Current text:
```
        return /^group-\d+$/.test(basename(worktree.path));
```

New text:
```
        return /^task-\d+$/.test(basename(worktree.path));
```

No other line in this file references the `group-\d+` convention or needs
changing — the rest of `listTaskWorktrees` (lines 51-61), `findUnmergedTaskWorktrees`
(lines 89-111), and every other exported function are naming-convention-agnostic
and require no edit.

### tests/mergeTaskWorktrees.test.ts

`listTaskWorktrees` and `findUnmergedTaskWorktrees` currently have no test in this
file (confirmed: no reference to either name anywhere in the file's 1685 lines
before this change). Add one behavioral check that fails under the current
`group-\d+` regex and passes once the regex above is fixed, using the real
worktree-creation path (`createWorktreeForGroup` via the existing `makeGroup`
helper) rather than fabricating a worktree by hand — that is what proves
`listTaskWorktrees` recognizes what the actual preparer creates.

Three edits:

**Edit 1** — add `basename` to the `node:path` import, line 7:

Current text:
```
import { dirname, isAbsolute, join } from "node:path";
```

New text:
```
import { basename, dirname, isAbsolute, join } from "node:path";
```

**Edit 2** — add `listTaskWorktrees` to the import from `../scripts/mergeTaskWorktrees.ts`, lines 16-25:

Current text:
```
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    mergeTaskDeepestFirst,
    rebaseGroupOntoSource,
    rebaseParentOntoSourceAndTest,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

New text:
```
import {
    listTaskWorktrees,
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    mergeTaskDeepestFirst,
    rebaseGroupOntoSource,
    rebaseParentOntoSourceAndTest,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
```

**Edit 3** — append a new test after the file's final test, at the end of the file
(current last 4 lines, which close out
`test("test_mergeTaskDeepestFirstStopsAtASubmoduleConflictWithoutAttemptingTheParentMerge", ...)`):

Current text (final lines of the file):
```
    assert.equal(parentMergeCalled, false);
    assert.equal(report.status, "submodule-conflicted");
    assert.deepEqual(report.completedLayers, []);
});
```

New text:
```
    assert.equal(parentMergeCalled, false);
    assert.equal(report.status, "submodule-conflicted");
    assert.deepEqual(report.completedLayers, []);
});

test("test_listTaskWorktreesRecognizesATaskNWorktreeCreatedByThePreparer", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);

    const worktrees = listTaskWorktrees(repoRoot);

    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].branch, group.branch);
    assert.equal(basename(worktrees[0].path), basename(group.worktree));
});
```

Note on the path comparison: `listTaskWorktrees` returns the path exactly as
`git worktree list --porcelain` reports it, which on macOS is the symlink-resolved
form (e.g. `/private/var/...` instead of `/var/...`), per the existing comment at
`scripts/mergeTaskWorktrees.ts:53`. Comparing `basename(...)` instead of the full
path avoids a spurious mismatch from that resolution while still proving the
worktree that `listTaskWorktrees` found is the one `createWorktreeForGroup`
created (both must end in `task-1`), and `worktrees[0].branch` (an exact,
unresolved string from `git worktree list`) confirms it's the same worktree,
not merely a same-named coincidence.

## Verification

Run from the repo root:

```
npm test 2>&1 | tail -40
```

Expected: the full suite passes, including a line for
`test_listTaskWorktreesRecognizesATaskNWorktreeCreatedByThePreparer` with no
failure. Before the `scripts/mergeTaskWorktrees.ts` edit, this new test fails
(`worktrees.length` is `0` because the regex still matches only `group-\d+`);
after the edit, it passes.

Also confirm the retired convention is untouched:

```
grep -n "group-" scripts/mergeTaskWorktrees.ts
```

Expected: no output (the `group-\d+` regex is gone; nothing else in this file
mentions that string).
