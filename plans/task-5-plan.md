# Task 5 Plan: Direct gitlink reader for a parent commit

Phase 1 of the recursive repository-discovery redesign. New module only — no
production call sites are wired up in this task.

## Files touched

- `scripts/gitlinkReader.ts` (new)
- `tests/gitlinkReader.test.ts` (new)

## Why `git ls-tree -r` is the right primitive

`git ls-tree -r <commit>` recurses through **tree** objects (ordinary
directories) and lists every blob and gitlink it finds, but a gitlink
(mode `160000`) is a reference to a *commit* in a different repository, not a
tree — git has no object to descend into, so `-r` naturally stops at the
gitlink boundary. This gives exactly the required semantics with zero manual
recursion logic:

- A gitlink at a single-segment path (`vendor`) is listed directly.
- A gitlink at a multi-segment path (`external/tmux_lib`) is listed as one
  `160000` entry at path `external/tmux_lib`; the intermediate `external`
  directory is a plain tree and never appears in `-r` output as its own
  entry with a commit OID.
- A grandchild gitlink that lives inside a child repository's own tree is in
  a different object database than the parent commit's tree, so it is
  categorically unreachable from the parent's `ls-tree -r` — it cannot leak
  in even by accident.

This means "no recursion" isn't something the reader has to defensively
avoid — it falls out of using `ls-tree -r` (non-recursive `ls-tree` would
work for single-segment gitlinks but would list `external` as a bare tree
entry for multi-segment ones, forcing manual recursion into ordinary
directories only — `-r` avoids reimplementing that).

## `scripts/gitlinkReader.ts`

Follow the style of `scripts/repositoryBranches.ts` (same repo, same
plumbing-wrapper pattern): `execFileSync("git", [...], { encoding: "utf8" })`.

```ts
export type GitlinkEntry = {
    path: string;
    oid: string;
};

export function readDirectGitlinks(repoRoot: string, commitish: string): GitlinkEntry[]
```

Implementation:

1. Run `git -C <repoRoot> ls-tree -r <commitish>`.
2. Each output line has the form `<mode> <type> <oid>\t<path>`. Split on the
   first tab to separate the metadata columns from the path (paths can
   contain spaces). Split the metadata columns on whitespace to get `mode`,
   `type`, `oid`.
3. Keep only lines where `mode === "160000"`. (Type will read `commit` for
   these; filtering on mode alone is sufficient and matches the task's
   framing of "mode 160000 entries".)
4. Map surviving lines to `{ path, oid }` in the order `ls-tree` returns
   them.
5. Return `[]` when there are no gitlinks (empty git ls-tree output after
   filtering).

No recursive calls, no shelling out to `git submodule foreach`.

## `tests/gitlinkReader.test.ts`

Mirror the fixture-building conventions in
`tests/repositoryBranches.test.ts`: `node:test`, `mkdtempSync` under
`tmpdir()`, a local `git()` helper wrapping `execFileSync`, real `git init` +
`git submodule add` (with `GIT_ALLOW_PROTOCOL=file` set, same as the existing
test file, since local-path submodules are blocked by default on modern
git).

Fixture builder (single helper, reused by every test):

```ts
function makeTempRepoWithCommit(): string { ... }              // same as repositoryBranches.test.ts

function makeParentRepoWithGitlinks(): {
    parentRoot: string;
    parentCommit: string;
    singleSegmentOid: string;   // OID recorded for the "vendor" gitlink
    multiSegmentOid: string;    // OID recorded for the "external/tmux_lib" gitlink
} { ... }
```

`makeParentRepoWithGitlinks` builds:
- one submodule origin repo, added as `vendor` (single-segment path) in the
  parent
- a second submodule origin repo, added as `external/tmux_lib`
  (multi-segment path — `git submodule add <origin> external/tmux_lib`
  creates the intermediate `external/` directory automatically as an
  ordinary tree entry)
- commits the parent so both gitlinks exist in a real commit
- captures each submodule's recorded commit OID via
  `git -C <parentRoot> rev-parse HEAD:vendor` and
  `git -C <parentRoot> rev-parse HEAD:external/tmux_lib` for use as
  expected-value fixtures in assertions (do not hardcode OIDs)

Tests (one behavior each, per TDD granularity rules):

1. `test_readDirectGitlinksReturnsBothDirectChildrenWithCorrectOids` — build
   the fixture above, call `readDirectGitlinks(parentRoot, parentCommit)`,
   assert the result (order-independent, e.g. sort by `path` first or use a
   `Map`) deep-equals
   `[{ path: "vendor", oid: singleSegmentOid }, { path: "external/tmux_lib", oid: multiSegmentOid }]`.
2. `test_readDirectGitlinksReturnsEmptyListWhenRepoHasNoGitlinks` — use
   `makeTempRepoWithCommit()` (no submodules), assert
   `readDirectGitlinks(repoRoot, "HEAD")` deep-equals `[]`.
3. `test_readDirectGitlinksExcludesIntermediateDirectoriesFromResult` —
   reuse the fixture from test 1, assert no entry in the result has
   `path === "external"` (the intermediate tree must never surface as a
   gitlink).
4. `test_readDirectGitlinksExcludesGrandchildGitlinksInsideAChildRepository`
   — inside the `vendor` submodule's origin repo (before or after adding it
   to the parent — use the same origin repo object the fixture already
   built), add a nested submodule of its own (a third throwaway repo added
   as e.g. `nested` inside the `vendor` origin, committed there), then call
   `readDirectGitlinks(parentRoot, parentCommit)` on the **parent** and
   assert no returned entry has `path` containing `"nested"` — the
   grandchild gitlink living inside `vendor`'s own tree must not appear when
   reading the parent.

Each test builds its own fixture (or reuses a shared builder function) per
the "granular tests, no giant combined test" rule — do not fold these four
assertions into one test function.

## Order of implementation (red/green)

1. Write the four failing tests against a not-yet-existing
   `scripts/gitlinkReader.ts` (or a stub that returns `[]`) — confirm they
   fail for the right reason.
2. Implement `readDirectGitlinks` as described above.
3. Run `bun test tests/gitlinkReader.test.ts` (this repo's existing tests use
   `node --test tests/`, either runner is fine per the project's test
   header comment convention — match whichever the task runner in this repo
   actually invokes; check `package.json`/CI config if one appears before
   picking) and iterate until green.
4. Do not touch any other file — this task explicitly excludes wiring up
   production call sites.
</content>
