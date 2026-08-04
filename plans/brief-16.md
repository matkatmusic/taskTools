# Task 16: Deterministic N-way synchronization across occurrences

Phase 2 of the recursive repository-discovery redesign. AMENDED — the full text of the amendment is appended at the end of THIS brief, under "Appended: full text of plans/amended task 16.md". It is authoritative and supersedes any earlier plan; you do not need to open any other file.

This is no longer a new-module-only task. scripts/occurrenceTreeDelta.ts ships only computeOccurrenceTreeDelta({occurrencePath, baseRef, nestedOccurrencePaths?, excludePatterns?}) — a base-relative delta whose digest reads `git ls-files -s` index OIDs and modes, so unstaged modifications, deletions, and exec-bit changes can be invisible. A base-relative delta also cannot express a target-only edit at a path the source never touched, so replaying it never converges. Do not write a second private tree walker inside occurrenceSync.ts.

Extend the delta module with a shared OccurrenceTreeSpec {occurrencePath, nestedOccurrencePaths?, excludePatterns?} and current-tree primitives computeTreeDigest(spec) and computeTreeDelta(source, target), both built on one internal snapshot builder: Git-derived included path set honoring nested-occurrence, exclude, and ignore rules; deleted-from-worktree tracked paths omitted; lstat without following symlinks; hashes of actual file bytes and symlink target text; current exec mode; entries sorted by relative path; digest input covers path, type, mode, and content hash. computeOccurrenceTreeDelta keeps working on the corrected digest. Pairwise patches cover add, delete, modify, mode-only change, type/symlink-target change, and deterministic renames paired by exact content/type/mode match in sorted path order (ambiguous cases may degrade to delete+add leaving no old path).

Then scripts/occurrenceSync.ts: syncOccurrences(sourceOccurrencePath, occurrences: OccurrenceTreeSpec[], opts?: {maxIterations?}) returns {converged, iterations, changedPaths: Record<string, string[]>}. Validate non-empty list, unique normalized paths, exactly one member matching the source, positive-integer maxIterations. Star topology with the source as sole authority: digest all, return early when equal, else apply computeTreeDelta(source, target) to each sorted target, record both old and new paths for renames, recompute digests, repeat until converged or maxIterations. Sorted changed-path arrays so results are order-independent. Filesystem failures fail fast with source/target/path context — the loop bounds non-convergence, it does not retry I/O.

If Phase 1 ownership of the delta module must stay closed, split those two files into a prerequisite task and mark this one blocked by it.

No production call sites in this task.

Delta tests: unstaged byte change, unstaged tracked deletion, and unstaged exec-bit change each move the digest; changed symlink target moves it without following the link; source/target comparison reports a target-only edit; source-only untracked file becomes an addition; nested-occurrence and generated-output exclusions respected on both sides; a plain rename yields one deterministic rename or an accepted delete/add leaving no old path.

Sync tests: the original two-, three-, and N-way scenarios amended to OccurrenceTreeSpec, plus target-only modification removed/overwritten, target-only untracked file inside the included tree deleted, unstaged source modifications/deletions/mode changes propagated, nested occurrence contents untouched and excluded from digest/delta, excluded generated output untouched, reordering the array producing identical sorted changed paths and digests, duplicate paths and missing source rejected, filesystem failure throwing with context instead of a misleading non-converged result, and a second sync returning zero iterations with empty changed paths.

### scripts/occurrenceTreeDelta.ts

```
// Computes an occurrence's working-tree delta against a base ref: per-path changes plus an order-independent digest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type ComputeOccurrenceTreeDeltaOptions = {
    occurrencePath: string;
    baseRef: string;
    nestedOccurrencePaths?: string[];
    excludePatterns?: string[];
};

export type TreeChangeKind = "added" | "modified" | "deleted" | "renamed" | "mode-changed" | "symlink" | "untracked";

export type TreeChange = {
    path: string;
    kind: TreeChangeKind;
    oldPath?: string;
    oldMode?: string;
    newMode?: string;
};

export type OccurrenceTreeDelta = {
    occurrencePath: string;
    baseRef: string;
    changes: TreeChange[];
    digest: string;
};

type TreeEntry = { mode: string; sha: string; path: string };

type RawDiffEntry = {
    oldMode: string;
    newMode: string;
    oldSha: string;
    newSha: string;
    status: string;
    path: string;
    oldPath?: string;
};

function runGit(occurrencePath: string, args: string[], input?: string): string {
    return execFileSync("git", ["-C", occurrencePath, ...args], {
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
    }).trim();
}

function buildExcludeSpec(nestedOccurrencePaths: string[], excludePatterns: string[]): string[] {
    return [...nestedOccurrencePaths, ...excludePatterns].map((pattern) => `:(exclude)${pattern}`);
}

function parseRawDiffLine(line: string): RawDiffEntry {
    const [metadata, ...paths] = line.split("\t");
    const [oldModeRaw, newMode, oldSha, newSha, status] = metadata.split(" ");
    return {
        oldMode: oldModeRaw.replace(/^:/, ""),
        newMode,
        oldSha,
        newSha,
        status,
        path: paths[paths.length - 1],
        oldPath: paths.length > 1 ? paths[0] : undefined,
    };
}

function classify(entry: RawDiffEntry): TreeChangeKind {
    if (entry.oldMode === "120000" || entry.newMode === "120000") return "symlink";
    if (entry.status.startsWith("R")) return "renamed";
    if (entry.oldSha === entry.newSha && entry.oldMode !== entry.newMode) return "mode-changed";
    if (entry.status.startsWith("A")) return "added";
    if (entry.status.startsWith("D")) return "deleted";
    return "modified";
}

function toTreeChange(entry: RawDiffEntry): TreeChange {
    const kind = classify(entry);
    const change: TreeChange = { path: entry.path, kind, oldMode: entry.oldMode, newMode: entry.newMode };
    if (kind === "renamed") change.oldPath = entry.oldPath;
    return change;
}

function trackedEntries(occurrencePath: string, excludeSpec: string[]): TreeEntry[] {
    const output = runGit(occurrencePath, ["ls-files", "-s", "--", ".", ...excludeSpec]);
    return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [metadata, path] = line.split("\t");
            const [mode, sha] = metadata.split(" ");
            return { mode, sha, path };
        });
}

function untrackedEntries(occurrencePath: string, paths: string[]): TreeEntry[] {
    return paths.map((path) => {
        const absolutePath = join(occurrencePath, path);
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
            const target = readlinkSync(absolutePath);
            const sha = runGit(occurrencePath, ["hash-object", "--stdin"], target);
            return { mode: "120000", sha, path };
        }
        const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
        const sha = runGit(occurrencePath, ["hash-object", path]);
        return { mode, sha, path };
    });
}

function buildDigest(entries: TreeEntry[]): string {
    const content = [...entries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => `${entry.mode} ${entry.sha} ${entry.path}\n`)
        .join("");
    return createHash("sha256").update(content).digest("hex");
}

export async function computeOccurrenceTreeDelta(
    options: ComputeOccurrenceTreeDeltaOptions,
): Promise<OccurrenceTreeDelta> {
    const { occurrencePath, baseRef, nestedOccurrencePaths = [], excludePatterns = [] } = options;
    const excludeSpec = buildExcludeSpec(nestedOccurrencePaths, excludePatterns);

    const trackedChanges = runGit(occurrencePath, ["diff", "--raw", "-M", baseRef, "--", ".", ...excludeSpec])
        .split("\n")
        .filter(Boolean)
        .map(parseRawDiffLine)
        .map(toTreeChange);

    const untrackedPaths = runGit(occurrencePath, ["ls-files", "--others", "--exclude-standard", "--", ".", ...excludeSpec])
        .split("\n")
        .filter(Boolean);
    const untrackedChanges: TreeChange[] = untrackedPaths.map((path) => ({ path, kind: "untracked" }));

    const digest = buildDigest([
        ...trackedEntries(occurrencePath, excludeSpec),
        ...untrackedEntries(occurrencePath, untrackedPaths),
    ]);

    return {
        occurrencePath,
        baseRef,
        changes: [...trackedChanges, ...untrackedChanges],
        digest,
    };
}

```

### tests/occurrenceTreeDelta.test.ts

```
// Behavioral checks for occurrenceTreeDelta.ts: tracked/untracked change classification + tree digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeOccurrenceTreeDelta } from "../scripts/occurrenceTreeDelta.ts";
import type { TreeChange } from "../scripts/occurrenceTreeDelta.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeRepoWithCommit(): { repoPath: string; baseRef: string } {
    const repoPath = mkdtempSync(join(tmpdir(), "occurrence-tree-delta-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return { repoPath, baseRef: git(repoPath, "rev-parse", "HEAD") };
}

function findChange(changes: TreeChange[], path: string): TreeChange {
    const found = changes.find((change) => change.path === path);
    if (!found) throw new Error(`no change for "${path}"`);
    return found;
}

test("added: staged new file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    writeFileSync(join(repoPath, "new.txt"), "new\n");
    git(repoPath, "add", "new.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "new.txt").kind, "added");
});

test("modified: unstaged edit of tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    writeFileSync(join(repoPath, "seed.txt"), "changed\n");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "seed.txt").kind, "modified");
});

test("deleted: removed tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    rmSync(join(repoPath, "seed.txt"));
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "seed.txt").kind, "deleted");
});

test("renamed: staged git mv", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    git(repoPath, "mv", "seed.txt", "renamed.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    const change = findChange(delta.changes, "renamed.txt");
    assert.equal(change.kind, "renamed");
    assert.equal(change.oldPath, "seed.txt");
});

test("mode-changed: staged chmod with no byte change", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    chmodSync(join(repoPath, "seed.txt"), 0o755);
    git(repoPath, "add", "seed.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    const change = findChange(delta.changes, "seed.txt");
    assert.equal(change.kind, "mode-changed");
    assert.notEqual(change.oldMode, change.newMode);
});

test("symlink: staged tracked symlink", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    symlinkSync("seed.txt", join(repoPath, "link.txt"));
    git(repoPath, "add", "link.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "link.txt").kind, "symlink");
});

test("untracked: new file not added", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    writeFileSync(join(repoPath, "untracked.txt"), "untracked\n");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "untracked.txt").kind, "untracked");
});

test("nested occurrence exclusion: absent from changes and digest", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    mkdirSync(join(repoPath, "nested"));
    writeFileSync(join(repoPath, "nested", "base.txt"), "base\n");
    git(repoPath, "add", "nested/base.txt");
    git(repoPath, "commit", "-q", "-m", "add nested");

    const pristineDelta = await computeOccurrenceTreeDelta({
        occurrencePath: repoPath,
        baseRef,
        nestedOccurrencePaths: ["nested"],
    });

    writeFileSync(join(repoPath, "nested", "base.txt"), "mutated\n");
    writeFileSync(join(repoPath, "nested", "new.txt"), "new\n");

    const delta = await computeOccurrenceTreeDelta({
        occurrencePath: repoPath,
        baseRef,
        nestedOccurrencePaths: ["nested"],
    });
    assert.equal(delta.changes.length, 0);
    assert.equal(delta.digest, pristineDelta.digest);
});

test("ignored exclusion: gitignored untracked file absent from changes", async () => {
    const { repoPath } = makeRepoWithCommit();
    writeFileSync(join(repoPath, ".gitignore"), "ignored.txt\n");
    git(repoPath, "add", ".gitignore");
    git(repoPath, "commit", "-q", "-m", "add gitignore");
    const baseRef = git(repoPath, "rev-parse", "HEAD");
    writeFileSync(join(repoPath, "ignored.txt"), "ignored\n");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 0);
});

test("generated-output exclusion: excludePatterns hides tracked path", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    mkdirSync(join(repoPath, "dist"));
    writeFileSync(join(repoPath, "dist", "gen.txt"), "gen\n");
    git(repoPath, "add", "dist/gen.txt");
    git(repoPath, "commit", "-q", "-m", "add dist");
    writeFileSync(join(repoPath, "dist", "gen.txt"), "gen changed\n");
    const delta = await computeOccurrenceTreeDelta({
        occurrencePath: repoPath,
        baseRef,
        excludePatterns: ["dist/**"],
    });
    assert.equal(delta.changes.length, 0);
});

test("digest equality: byte-identical trees produce equal digests", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.equal(deltaA.digest, deltaB.digest);
});

test("digest inequality: mode difference changes the digest", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    chmodSync(join(b.repoPath, "seed.txt"), 0o755);
    git(b.repoPath, "add", "seed.txt");
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.notEqual(deltaA.digest, deltaB.digest);
});

test("digest inequality: symlink target difference changes the digest", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    symlinkSync("target-a", join(a.repoPath, "link.txt"));
    git(a.repoPath, "add", "link.txt");
    symlinkSync("target-b", join(b.repoPath, "link.txt"));
    git(b.repoPath, "add", "link.txt");
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.notEqual(deltaA.digest, deltaB.digest);
});

test("digest inequality: one differing byte changes the digest", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    writeFileSync(join(b.repoPath, "seed.txt"), "seee\n");
    git(b.repoPath, "add", "seed.txt");
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.notEqual(deltaA.digest, deltaB.digest);
});

```

### scripts/occurrenceSync.ts

(missing: file not found on disk)

### tests/occurrenceSync.test.ts

(missing: file not found on disk)

---

# Appended: full text of plans/amended task 16.md (authoritative)

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
