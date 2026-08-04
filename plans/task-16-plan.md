# Task 16 Plan: Deterministic N-way synchronization across occurrences

Source of truth: `plans/brief-16.md`, specifically the appended
"Amended Task 16" section, which supersedes everything above it in that file
(including any prior version of this plan file, which assumed a
`computeDelta(sourceDir, targetDir)` / `computeTreeDigest(dir)` API that the
amendment confirms was never shipped).

## Scope decision

The amendment's file list (`scripts/occurrenceTreeDelta.ts`,
`tests/occurrenceTreeDelta.test.ts`, `scripts/occurrenceSync.ts`,
`tests/occurrenceSync.test.ts`) already includes the delta module. That
resolves the brief's fallback question ("split Phase 1 ownership into a
prerequisite task?") — **no split, no Task 15a.** This plan edits all four
files directly, in one task.

## Files touched

- `scripts/occurrenceTreeDelta.ts` — extend (existing file, ships today with
  only `computeOccurrenceTreeDelta`)
- `tests/occurrenceTreeDelta.test.ts` — extend (11 existing tests stay; add
  regressions + new-primitive tests)
- `scripts/occurrenceSync.ts` — new
- `tests/occurrenceSync.test.ts` — new

**Line-cap contingency** (project rule: files capped at 250 lines, split
before the cap is hit, not after). Estimated growth for
`occurrenceTreeDelta.ts` puts it right at the cap. Two checkpoints are called
out below (end of Phase 1, end of Phase 2) where you must run
`wc -l scripts/occurrenceTreeDelta.ts` and, if it is over ~200 lines, extract
`buildIncludedPaths` + `buildSnapshot` (+ the `SnapshotEntry` type) into a new
internal module `scripts/occurrenceTreeSnapshot.ts` before writing
`computeTreeDelta`. Same check applies to `occurrenceSync.ts` after Phase 4 —
extract `applyTreePatch` into `scripts/occurrenceTreePatchApply.ts` if needed.
These extraction files are not in the brief's list because they're an
implementation-detail consequence of the line cap, not a scope change — no
new exports beyond what the four files above already commit to.

## Why this is one task, not a bigger redesign

`computeOccurrenceTreeDelta`'s digest is currently built from
`git ls-files -s` (index OIDs/modes) — it cannot see unstaged edits. Fixing
that digest and adding source-vs-target comparison are the same underlying
fix: both need one "what does this path actually look like on disk right
now" primitive. Building it once, shared by both the corrected digest and the
new pairwise delta, is smaller than building it twice — this is the
"one internal snapshot builder" the amendment insists on.

---

## Type additions to `scripts/occurrenceTreeDelta.ts`

```ts
export interface OccurrenceTreeSpec {
    occurrencePath: string;
    nestedOccurrencePaths?: string[];
    excludePatterns?: string[];
}

export type ComputeOccurrenceTreeDeltaOptions = OccurrenceTreeSpec & { baseRef: string };

type SnapshotEntry = { path: string; mode: string; contentHash: string };

export type TreePatchKind = "add" | "delete" | "modify" | "mode-changed" | "renamed";

export type TreePatch = {
    path: string;
    kind: TreePatchKind;
    oldPath?: string;
    mode?: string;
};
```

`mode` already distinguishes symlink (`120000`) from regular file
(`100644`/`100755`) — no separate `type` field needed, matching the git
mode convention `trackedEntries` already used. Note this so a reviewer
doesn't ask "where's the type field" — it's folded into `mode`.

Delete the existing `TreeEntry`, `trackedEntries`, and `untrackedEntries` —
superseded by the shared snapshot builder below.

---

## Phase 1 — RED then GREEN: correct the digest (unstaged changes)

### RED
Add to `tests/occurrenceTreeDelta.test.ts`, following the file's existing
`test("description", async () => {...})` style (not the `test_snake_case`
convention from the TDD guide — match the file that's already there):

```ts
test("digest changes on unstaged byte edit of a tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    const before = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    writeFileSync(join(repoPath, "seed.txt"), "changed\n");
    const after = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.notEqual(before.digest, after.digest);
});

test("digest changes on unstaged deletion of a tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    const before = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    rmSync(join(repoPath, "seed.txt"));
    const after = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.notEqual(before.digest, after.digest);
});

test("digest changes on unstaged exec-bit change of a tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    const before = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    chmodSync(join(repoPath, "seed.txt"), 0o755);
    const after = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.notEqual(before.digest, after.digest);
});
```

Run these three against the current source first — they must **fail**
(prove the bug) before you touch `occurrenceTreeDelta.ts`.

### GREEN
Implement the shared snapshot builder in `occurrenceTreeDelta.ts`:

```
buildIncludedPaths(spec: OccurrenceTreeSpec): string[]
    excludeSpec = buildExcludeSpec(spec.nestedOccurrencePaths ?? [], spec.excludePatterns ?? [])
    tracked   = runGit ls-files            -- . ...excludeSpec   (path list, no -s)
    untracked = runGit ls-files --others --exclude-standard -- . ...excludeSpec
    return dedupe(tracked ++ untracked)

buildSnapshot(spec: OccurrenceTreeSpec): Promise<SnapshotEntry[]>
    for each path in buildIncludedPaths(spec):
        absolutePath = join(spec.occurrencePath, path)
        try: stat = lstatSync(absolutePath)
        catch ENOENT: skip path (deleted from worktree, unstaged)
        if stat.isSymbolicLink():
            target = readlinkSync(absolutePath)
            entry = { path, mode: "120000", contentHash: sha256(target) }
        else:
            bytes = readFileSync(absolutePath)
            mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644"
            entry = { path, mode, contentHash: sha256(bytes) }
    sort entries by path, return
```

Use `createHash("sha256").update(x).digest("hex")` directly on bytes/target
text — no `git hash-object` round trip. That was only ever needed to get a
git-style blob id; a direct content hash is fewer subprocess calls and is
exactly what fixes the bug (the index-derived sha is the thing that goes
stale).

Reuse `buildDigest` (adjust its parameter type to `SnapshotEntry[]`, same
`${mode} ${contentHash} ${path}\n` join-and-hash body it already has).

Rewire `computeOccurrenceTreeDelta`'s digest line to:
`buildDigest(await buildSnapshot({ occurrencePath, nestedOccurrencePaths, excludePatterns }))`
and delete `trackedEntries`/`untrackedEntries`. The `changes` array (git-diff
classification against `baseRef`) is untouched — only the digest source
changes.

Run the 3 new tests plus all 11 existing tests. All green.

**Checkpoint:** `wc -l scripts/occurrenceTreeDelta.ts`. If over ~200 lines,
extract `buildIncludedPaths`/`buildSnapshot`/`SnapshotEntry` into
`scripts/occurrenceTreeSnapshot.ts` now, before Phase 2 adds more.

---

## Phase 2 — RED then GREEN: `computeTreeDigest` and `computeTreeDelta`

### RED
Add to `tests/occurrenceTreeDelta.test.ts`:

- `"computeTreeDigest changes when a symlink target changes"` — two repos,
  same tracked symlink path, different link targets; assert digests differ.
  (Mirrors the existing `computeOccurrenceTreeDelta` symlink-digest test but
  calls `computeTreeDigest({ occurrencePath })` directly — no `baseRef`.)
- `"computeTreeDelta reports a target-only edit"` — clone one repo into two
  dirs (or two independent `makeRepoWithCommit()` seeded identically), edit
  `seed.txt` bytes only in the target; `computeTreeDelta(source, target)`
  returns exactly one patch, `{ path: "seed.txt", kind: "modify" }`.
- `"computeTreeDelta reports a source-only untracked file as an addition"` —
  write an untracked file in source only; expect one `{ kind: "add" }` patch.
- `"computeTreeDelta respects nested-occurrence exclusions on both sides"` —
  give source and target each a `nested/` dir with different unstaged
  content, pass matching `nestedOccurrencePaths: ["nested"]` on both specs;
  expect an empty patch array.
- `"computeTreeDelta respects generated-output exclusions on both sides"` —
  same shape with `excludePatterns: ["dist/**"]`.
- `"computeTreeDelta yields a deterministic rename, or an accepted delete+add with no old path"` —
  target has `old.txt`, source has identical bytes at `new.txt` (no `old.txt`
  in source); assert the patch list is either exactly one
  `{ kind: "renamed", path: "new.txt", oldPath: "old.txt" }`, or exactly one
  `{ kind: "delete", path: "old.txt" }` plus one `{ kind: "add", path: "new.txt" }`
  — never a "renamed" patch that also leaves a phantom delete/add for the
  same pair.

Two repos for these tests only need `makeRepoWithCommit()` called twice
(source, target) then diverged by hand — no new fixture helper required.

### GREEN
```
computeTreeDigest(spec): Promise<string>
    return buildDigest(await buildSnapshot(spec))

computeTreeDelta(source, target): Promise<TreePatch[]>
    sourceEntries = await buildSnapshot(source)
    targetEntries = await buildSnapshot(target)
    sourceByPath = Map(path -> entry), targetByPath = Map(path -> entry)

    patches = []
    for path in union(sourceByPath.keys, targetByPath.keys) sorted:
        s = sourceByPath.get(path), t = targetByPath.get(path)
        if s && t:
            if s.contentHash !== t.contentHash: patches.push({ path, kind: "modify", mode: s.mode })
            else if s.mode !== t.mode:          patches.push({ path, kind: "mode-changed", mode: s.mode })
            // else identical, no patch
        else if s && !t:  sourceOnly.push(s)
        else if !s && t:  targetOnly.push(t)

    // deterministic rename pairing: exact (mode, contentHash) match, 1:1 only
    group sourceOnly and targetOnly by key = `${mode}:${contentHash}`
    for each key present in both groups:
        if sourceOnly[key].length === 1 && targetOnly[key].length === 1:
            patches.push({ path: sourceOnly[key][0].path, kind: "renamed",
                           oldPath: targetOnly[key][0].path, mode: sourceOnly[key][0].mode })
            remove both entries from their groups
    // whatever's left (including any ambiguous >1:1 groups) becomes plain add/delete
    for remaining s in sourceOnly: patches.push({ path: s.path, kind: "add", mode: s.mode })
    for remaining t in targetOnly: patches.push({ path: t.path, kind: "delete" })

    return patches sorted by path
```

Ambiguous groups (more than one candidate sharing a key on either side) fall
straight through to the add/delete loop — no attempt to guess a pairing.
That's the simplest rule that still satisfies "ambiguous cases may safely
degrade to delete+add," and it's the reason the pairing check is a strict
`=== 1 && === 1`, not "pick the closest path."

Run new tests + full existing delta suite. All green.

**Checkpoint:** `wc -l scripts/occurrenceTreeDelta.ts`. If still over 250,
extract now — don't let the sync module wait on this.

---

## Phase 3 — RED: `occurrenceSync.ts` input validation

Create `scripts/occurrenceSync.ts` with just enough to compile and validate
(loop/apply logic comes in Phase 4 — this phase's tests must be green before
that logic exists, since validation happens before any digesting):

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
): Promise<SyncResult>
```

Validation, run before anything else in `syncOccurrences`:

```
if occurrences.length === 0: throw Error("syncOccurrences: occurrences must be non-empty")

normalized = occurrences.map(o => ({ ...o, key: path.resolve(o.occurrencePath) }))
if new Set(normalized.map(n => n.key)).size !== normalized.length:
    throw Error("syncOccurrences: duplicate occurrence paths")

sourceKey = path.resolve(sourceOccurrencePath)
sourceMatches = normalized.filter(n => n.key === sourceKey)
if sourceMatches.length !== 1:
    throw Error(`syncOccurrences: expected exactly one occurrence matching source "${sourceOccurrencePath}", found ${sourceMatches.length}`)

maxIterations = opts?.maxIterations ?? 10
if !Number.isInteger(maxIterations) || maxIterations <= 0:
    throw Error(`syncOccurrences: maxIterations must be a positive integer, got ${opts?.maxIterations}`)
```

Default of `10` is arbitrary but generous for a design where a normal run
converges in one pass (see Phase 4) — it exists to bound the "unexpected
concurrent mutation" case the amendment calls out, not to allow slow
convergence.

Add to `tests/occurrenceSync.test.ts`:

- `"rejects an empty occurrences list"`
- `"rejects duplicate normalized occurrence paths"`
- `"rejects zero occurrences matching the source path"`
- `"rejects more than one occurrence matching the source path"`
- `"rejects a non-positive maxIterations"`
- `"rejects a non-integer maxIterations"`

Each just calls `syncOccurrences` with a bad input and
`assert.rejects(...)`. No filesystem fixture needed yet — these can use
in-memory spec objects pointing at any path string.

---

## Phase 4 — RED then GREEN: convergence, propagation, determinism

### RED
Add a `makeOccurrenceRepo()` fixture (mirrors the delta test file's
`makeRepoWithCommit`, but returns an independent repo per occurrence — sync
compares live working trees, not commits against each other, so each
occurrence is its own git repo/dir seeded with the same starting files).

Tests, all in `tests/occurrenceSync.test.ts`:

1. **Two-way convergence** — source has a file target lacks, target has a
   stale file source lacks. Run `syncOccurrences`. Assert `converged: true`,
   `iterations: 1` (a single pass always converges in this star topology
   when the source is untouched during the pass — see Algorithm note below),
   target's `changedPaths` contains both affected paths sorted, source's
   `changedPaths` is `[]`.
2. **Three-way convergence** — source plus two targets, each diverged
   differently. Assert `converged: true`, `iterations: 1`, each target's own
   changed-path set reflects only its own divergence.
3. **N-way convergence** (4 occurrences) — same shape, generalized.
4. **Target-only modification removed/overwritten** — target has an edited
   version of a file source has unedited; after sync, target's bytes equal
   source's, digests equal.
5. **Target-only untracked file deleted** — file exists only in target,
   inside the included tree (not nested/excluded); after sync it's gone from
   target.
6. **Unstaged source changes propagate** — mutate source's tracked file
   (byte edit, deletion, exec-bit change) before running sync; assert each
   propagates to every target.
7. **Nested occurrence contents untouched** — give every occurrence a
   `nested/` dir with different content, pass matching
   `nestedOccurrencePaths: ["nested"]` on every spec; after sync, each
   occurrence's `nested/` dir is byte-identical to what it was before the
   run (sync must not touch it, and it must not appear in any
   `changedPaths` entry).
8. **Excluded generated output untouched** — same shape with
   `excludePatterns`.
9. **Order-independence** — run the same starting fixture twice, occurrences
   array in two different orders (two independent copies of the fixture, one
   per run). Assert both runs produce identical final digests and identical
   sorted `changedPaths` for the corresponding occurrence.
10. **Filesystem failure throws with context** — force an apply-time error
    (e.g. a target patch write target's parent directory chmod'd
    non-writable, or a target occurrence path removed after digesting but
    before applying). Assert the thrown error's message contains the source
    path, the target path, and the failing file's relative path.
11. **Second sync is a no-op** — call `syncOccurrences` again on the
    fixture produced by test 1 (or any converged fixture). Assert
    `converged: true`, `iterations: 0`, every occurrence's `changedPaths` is
    `[]`.

### GREEN

```
applyTreePatch(sourceSpec, targetSpec, patch):
    targetAbs = join(targetSpec.occurrencePath, patch.path)
    try:
        mkdirSync(dirname(targetAbs), { recursive: true })
        switch patch.kind:
            "delete":
                rmSync(targetAbs, { force: true })
            "renamed":
                oldAbs = join(targetSpec.occurrencePath, patch.oldPath)
                rmSync(targetAbs, { force: true })   // clear any conflicting entry at destination
                renameSync(oldAbs, targetAbs)
            "mode-changed":
                chmodSync(targetAbs, modeToOctal(patch.mode))
            "add" | "modify":
                rmSync(targetAbs, { force: true })   // clear conflicting type (symlink<->file) before writing
                sourceAbs = join(sourceSpec.occurrencePath, patch.path)
                if patch.mode === "120000":
                    symlinkSync(readlinkSync(sourceAbs), targetAbs)
                else:
                    writeFileSync(targetAbs, readFileSync(sourceAbs))
                    chmodSync(targetAbs, modeToOctal(patch.mode))
    catch (error):
        throw new Error(
            `syncOccurrences: failed applying "${patch.kind}" for path "${patch.path}" ` +
            `from source "${sourceSpec.occurrencePath}" to target "${targetSpec.occurrencePath}": ${error.message}`
        )
```

The `rmSync` before every `add`/`modify`/`renamed` write is what makes
"replace it correctly" (amendment's type/symlink-target-change rule) work —
overwriting a symlink path with `writeFileSync` would otherwise follow the
link or throw; clearing first and recreating the exact target type is the
only fully-correct order.

```
syncOccurrences(sourceOccurrencePath, occurrences, opts):
    validate (Phase 3 logic)
    sorted = occurrences sorted by normalized occurrencePath
    source = the one matching sourceOccurrencePath
    changedPaths = Object.fromEntries(sorted.map(o => [normalize(o.occurrencePath), new Set()]))

    iterations = 0
    digests = await Promise.all(sorted.map(computeTreeDigest))
    while not allEqual(digests):
        if iterations >= maxIterations:
            return { converged: false, iterations, changedPaths: toSortedArrays(changedPaths) }
        for target of sorted where target !== source:
            patches = await computeTreeDelta(source, target)
            for patch of patches:
                applyTreePatch(source, target, patch)
                key = normalize(target.occurrencePath)
                changedPaths[key].add(patch.path)
                if patch.oldPath: changedPaths[key].add(patch.oldPath)
        iterations += 1
        digests = await Promise.all(sorted.map(computeTreeDigest))

    return { converged: true, iterations, changedPaths: toSortedArrays(changedPaths) }
```

Note for test 1/2/3: in this design every pass applies the *full* patch set
computed against the untouched source, so one pass is always sufficient
absent a concurrent mutation between the pre-pass and post-pass digest
reads — that's why the straightforward convergence tests assert
`iterations: 1`, not "some number ≤ maxIterations." `maxIterations` exists to
bound the case the amendment names explicitly (an unexpected concurrent
tree mutation causing a second pass to still not converge), not to allow
normal multi-pass convergence — don't write a test asserting iterations > 1
for a scenario with no concurrent mutation, that would be asserting a bug.

Run all Phase 4 tests plus everything from Phases 1–3. All green.

**Checkpoint:** `wc -l scripts/occurrenceSync.ts`. Extract `applyTreePatch`
into `scripts/occurrenceTreePatchApply.ts` if over 250 lines.

---

## Phase 5 — Whole-repo verification

1. Run the full test suite (not just the two new/changed files) — confirm
   nothing else regressed.
2. `rg -l "occurrenceSync|occurrenceTreeDelta" --type ts` outside
   `scripts/` and `tests/` — must return nothing. The brief is explicit:
   "No production call sites in this task."
3. Re-check both line-cap checkpoints landed (`wc -l` on every file touched
   or created).

---

## Out of scope (from the amendment — do not build these here)

- Production call sites or CLI wiring for `syncOccurrences`.
- Remote pushes, base-branch mutation, or semantic conflict resolution.
- Copying ignored/generated/nested-occurrence contents.
- Treating the iteration loop as a substitute for explicit I/O error
  handling — filesystem errors throw immediately with context; they are
  never caught, classified, and retried.
