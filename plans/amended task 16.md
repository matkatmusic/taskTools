# Amended Task 16: Deterministic N-way synchronization

This amendment replaces the assumed delta API in `plans/task-16-plan.md` with
an extension based on the Phase 1 module that actually shipped. Task 16 is no
longer a new-module-only task because `scripts/occurrenceTreeDelta.ts` lacks a
current-tree-to-current-tree comparison operation, and its digest must be
corrected before it can prove convergence.

## Confirmed Phase 1 contract and gaps

`scripts/occurrenceTreeDelta.ts` currently exports:

```ts
computeOccurrenceTreeDelta({
    occurrencePath,
    baseRef,
    nestedOccurrencePaths?,
    excludePatterns?,
})
```

It returns one occurrence's changes relative to `baseRef` plus a digest. It
does not export `computeDelta(sourceDir, targetDir)` or
`computeTreeDigest(dir)`.

The base-relative delta is insufficient for synchronization by itself. If a
target contains a target-only edit and the source is unchanged at that path,
the source delta never mentions the path, so replaying it cannot make the
target converge.

The current digest also uses `git ls-files -s` for tracked entries. That reads
index object IDs and index modes rather than the actual working tree. An
unstaged tracked modification, deletion, or executable-bit change can
therefore be missing from the digest even though synchronization must compare
the current trees.

Finally, nested-occurrence and generated-output exclusions are caller-supplied
options that default to empty. The original Task 16 string-only API has no way
to pass them and must not claim they happen automatically.

## Amended scope

Files changed by this task:

- `scripts/occurrenceTreeDelta.ts`
- `tests/occurrenceTreeDelta.test.ts`
- `scripts/occurrenceSync.ts`
- `tests/occurrenceSync.test.ts`

If Phase 1 ownership must remain closed, split the first two files into a
prerequisite Task 15a and mark Task 16 blocked by it. Do not implement a private
second tree walker inside `occurrenceSync.ts`.

## Current-tree primitives

Add a shared specification for the inclusion boundary:

```ts
export interface OccurrenceTreeSpec {
    occurrencePath: string;
    nestedOccurrencePaths?: string[];
    excludePatterns?: string[];
}
```

Keep `ComputeOccurrenceTreeDeltaOptions` for the existing base-relative API,
preferably by extending `OccurrenceTreeSpec` with `baseRef`.

Add current-tree operations:

```ts
export async function computeTreeDigest(
    occurrence: OccurrenceTreeSpec,
): Promise<string>;

export async function computeTreeDelta(
    source: OccurrenceTreeSpec,
    target: OccurrenceTreeSpec,
): Promise<TreePatch[]>;
```

`computeOccurrenceTreeDelta` remains available and uses the corrected current
tree digest internally.

### Snapshot and digest rules

Use one internal snapshot builder for both new operations. It must:

- ask Git for the included tracked and untracked path set while applying
  `nestedOccurrencePaths`, `excludePatterns`, and standard ignore rules;
- omit tracked paths that are deleted from the working tree;
- inspect each included path with `lstat`, never following symlinks;
- hash actual regular-file bytes and symlink target text rather than index
  object IDs;
- record the current executable mode;
- sort entries by relative path before hashing;
- include path, entry type, mode, and content hash in the digest input.

The same inclusion rules must drive snapshots, pairwise deltas, and digests.
No caller should be able to compare one path set and hash a different one.

### Pairwise patch rules

`computeTreeDelta(source, target)` describes the operations needed to make the
target's included current tree equal the source's included current tree:

- source-only path: add/write it;
- target-only path: delete it;
- same path with different bytes: modify/write it;
- same path with different executable mode only: change its mode;
- same path with a changed type or symlink target: replace it correctly;
- deterministically identifiable move: rename it, carrying old and new paths.

The patch type may differ from the existing base-relative `TreeChange` type if
that produces a clearer apply contract. It must contain the destination path,
old path for renames, and the source mode/type information needed to apply the
operation. File bytes and symlink targets may be read from the source while
applying, but the source must be treated as immutable for the duration of a
sync pass.

Rename detection must be deterministic. Pair exact content/type/mode matches
in sorted path order; ambiguous or rename-plus-edit cases may safely become a
delete plus add as long as the resulting tree and changed-path report are
correct. A plain rename must not leave the old target path behind.

## Amended synchronization API

Every occurrence carries its own inclusion context:

```ts
export interface SyncResult {
    converged: boolean;
    iterations: number;
    changedPaths: Record<string, string[]>;
}

export async function syncOccurrences(
    sourceOccurrencePath: string,
    occurrences: OccurrenceTreeSpec[],
    opts?: { maxIterations?: number },
): Promise<SyncResult>;
```

Validate that:

- the list is non-empty;
- occurrence paths are unique after normalization;
- exactly one member matches `sourceOccurrencePath`;
- `maxIterations` is a positive integer when supplied.

Sort targets by normalized occurrence path before processing. Initialize a
changed-path set for every occurrence, including the source.

## Algorithm

Use an N-way star topology with the source as the only authority:

1. Compute the corrected current-tree digest for every occurrence.
2. If all digests match, return `converged: true`, `iterations: 0`, and empty
   changed-path arrays.
3. For each target, compute `computeTreeDelta(source, target)` and apply that
   patch only to the target.
4. Add both old and new paths for a rename, and the affected path for every
   other operation, to that target's changed-path set.
5. Recompute all digests after the pass. If they match, return converged.
6. Otherwise repeat from the same source until `maxIterations` is exhausted.
7. Return `converged: false` only after the final digest comparison.

Convert changed-path sets to sorted arrays before returning so results do not
depend on occurrence order, patch order, or the number of passes.

Filesystem failures are errors and should fail fast with source, target, and
path context. Do not describe the iteration loop as retrying transient I/O
errors unless errors are deliberately caught, classified as retryable, and
tested. The loop exists to detect or bound non-convergence, including an
unexpected concurrent tree mutation.

Apply operations must create parents where needed, replace conflicting entry
types safely, preserve executable modes, use `lstat`/`readlink` for symlinks,
and tolerate a path already being absent for a deletion. Never operate on a
path that was not produced by the shared pairwise delta.

## Tests for `occurrenceTreeDelta`

Keep the existing Phase 1 tests and add these regressions before implementing
the sync module:

1. An unstaged byte change changes the digest.
2. An unstaged tracked deletion changes the digest and removes the path from
   the current snapshot.
3. An unstaged executable-bit change changes the digest.
4. A changed symlink target changes the digest without following the link.
5. A source/target comparison reports a target-only edit so it can be removed
   or overwritten.
6. A source-only untracked file becomes an addition.
7. Pairwise comparison respects nested-occurrence exclusions on both sides.
8. Pairwise comparison respects generated-output exclusions on both sides.
9. A plain rename produces either one deterministic rename operation or an
   explicitly accepted delete/add pair that leaves no old path.

## Tests for `occurrenceSync`

Retain the original two-, three-, and N-way scenarios, amended to pass
`OccurrenceTreeSpec` values. In addition:

1. A target-only modification absent from the source is removed or overwritten
   and all digests converge.
2. A target-only untracked file is deleted when it is inside the included tree.
3. Unstaged source modifications, deletions, and mode changes propagate.
4. Nested occurrence contents remain untouched and absent from digest/delta
   comparison.
5. Generated output remains untouched when excluded.
6. Reordering the occurrence array produces identical sorted changed paths and
   final digests.
7. Duplicate occurrence paths and a missing source are rejected.
8. A filesystem failure throws with target/path context rather than returning a
   misleading non-converged result.
9. A second sync returns zero iterations and empty changed paths.

## Order of work

1. Add the three unstaged-digest regression tests and demonstrate the current
   failure.
2. Refactor a shared current-tree snapshot builder and correct the digest.
3. Add and test `computeTreeDigest` and `computeTreeDelta`.
4. Write the synchronization tests against the amended API.
5. Implement deterministic patch application and the star-topology loop.
6. Run focused delta/sync tests, then the complete repository test suite.

## Rejected fallback

It is technically possible to use the existing base-relative delta by
reverting every target to a common base and replaying the source's delta. That
requires inverse operations, reading deleted base blobs, special handling for
renames/type changes, and destructive target normalization. It also still
requires fixing the current digest and carrying base/exclusion context. The
pairwise current-tree primitive is smaller, safer, and directly expresses the
sync operation Task 16 needs.

## Out of scope

- Production call sites or CLI wiring.
- Remote pushes, base-branch mutation, or semantic conflict resolution.
- Copying ignored/generated/nested-occurrence contents.
- Treating iteration as a substitute for explicit I/O error handling.
