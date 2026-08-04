# Task 23 Plan: Snapshot-based worker ownership checks

Source: `plans/brief-23.md` (Phase 3 of the recursive repository-discovery redesign).

## Problem

Worker ownership checks currently key off commit ranges. That breaks when a
worker makes zero commits, several commits, or amends one — the range is
undefined or wrong. Replace commit-based diffing with before/after
filesystem snapshots taken directly across every occurrence (nested repo),
independent of what got committed.

## Ladder check (read before writing)

Before writing any traversal/hash/exec code, grep the repo for:
- an existing recursive occurrence-discovery helper (Phase 1/2 of this same
  redesign almost certainly built one — reuse its walk, don't re-walk).
- an existing "run git and parse output" helper used elsewhere in `scripts/`
  (reuse it instead of a new `execSync` wrapper).
- `scripts/ownershipKeys.ts`'s actual exported shape (function names/types)
  so the new module matches it instead of guessing a parallel type.

Only write new traversal/exec code for whatever isn't already there.

## Design

### Snapshot

A snapshot is taken per occurrence root and captures every path git knows
about (tracked + untracked-but-not-ignored), independent of commit history:

```ts
type PathState = {
  path: string;          // relative to occurrence root
  kind: 'file' | 'symlink' | 'dir';
  mode: string;           // e.g. '100644', '100755', '120000'
  hash: string | null;    // content hash (symlink: hash of link target); null for dirs
};
type Snapshot = Map<string, PathState>; // key: path
```

`takeSnapshot(occurrenceRoot: string): Snapshot`
1. List candidate paths via `git ls-files -z` (tracked) unioned with
   `git ls-files --others --exclude-standard -z` (untracked, respecting
   .gitignore) — reuses git's own ignore semantics instead of reimplementing
   gitignore matching.
2. For each path, `fs.lstatSync` for mode/kind, `fs.readFileSync`/`readlinkSync`
   + a stdlib hash (`node:crypto` `createHash('sha1')`) for content identity.
3. This is a pure filesystem read — no git add/commit/stash side effects, so
   it's safe to call before and after a worker runs regardless of what the
   worker committed.

### Diff

`diffSnapshots(before: Snapshot, after: Snapshot): Change[]`

For the union of keys:
- key only in `after` → candidate **added**
- key only in `before` → candidate **deleted**
- key in both, `hash` differs → **modified**
- key in both, `mode` differs (including file↔symlink kind change) →
  **mode-changed** / **symlink-changed**
- key in both, identical → skip

**Rename pass**: pair up a candidate-added and candidate-deleted entry that
share an identical `hash` → **renamed** (from/to path). Exact-hash match
only, no fuzzy similarity scoring.
`// ponytail: exact-hash rename match only, add similarity scoring if renamed+edited-in-one-step needs attribution`

Each `Change` carries `{ occurrenceRoot, path, type, fromPath? }`.

### Occurrence attribution

Reuse the existing recursive occurrence-discovery output (list of occurrence
roots, each possibly nested inside another). For a `Change`, attribute it to
the **deepest** occurrence root whose directory contains the change's
absolute path — i.e. sort candidate roots by path length descending and take
the first match. This satisfies the "nested occurrence, not parent" test.

### Ownership check

`checkOwnership(workerId, changes: Change[], ownershipKeys): Violation[]`

For each `Change`, resolve its owning occurrence, then ask
`ownershipKeys.ts`'s existing matcher whether `workerId`'s declared ownership
covers `(occurrenceId, path)`. Anything not covered becomes a
`Violation { occurrenceId, path, type, reason: 'out-of-ownership' }` —
repository-qualified so a human can see which occurrence a fence was
crossed in.

### Group boundary (final check)

`checkGroupBoundary(changes: Change[], allWorkersOwnershipKeys): Violation[]`

Same attribution, but a change is a violation only if **no** worker in the
group declares ownership over it. Run this after all per-worker ownership
checks as the last gate, per the brief.

## Files

- `scripts/ownershipSnapshots.ts` — new module: `takeSnapshot`,
  `diffSnapshots`, `checkOwnership`, `checkGroupBoundary`, plus the
  `PathState` / `Snapshot` / `Change` / `Violation` types. Keep it under the
  250-line file cap; if attribution + git-listing + hashing doesn't fit,
  split hashing/listing into a small internal helper before the cap forces
  an awkward split.
- `tests/ownershipSnapshots.test.ts` — new tests, using real temp git repos
  (nested occurrence dirs, each its own `git init`) so the "no commit" case
  is actually exercised, not simulated.

No existing files change. No production call sites are wired up yet (per
brief — this task ships the module and its tests only).

## Test plan (from brief, one case each)

1. Edit outside declared ownership → reported, with zero commits made
   (change left in the working tree only).
2. Edit inside declared ownership → no violation.
3. Deletion → attributed to the right occurrence/path as `deleted`.
4. Rename → attributed as `renamed` with correct from/to paths.
5. Mode change (chmod +x on a tracked file) → attributed as `mode-changed`.
6. Symlink change (new symlink, or file replaced by symlink) → attributed
   as `symlink-changed`.
7. Nested occurrence: a change inside occurrence B, itself nested inside
   occurrence A → attributed to B, not A.
8. Group boundary: a change matching no worker's declared ownership in the
   group is rejected by `checkGroupBoundary` even though no single-worker
   check ran against it.

Each test builds its snapshots via real `takeSnapshot` calls against temp
dirs (not hand-built `Snapshot` maps), so the git-listing step is exercised
too.

## Open questions / assumptions to confirm at implementation time

- Exact exported shape of `scripts/ownershipKeys.ts` (function names, how it
  keys a worker's declared paths) — read it then, match it, don't duplicate
  its matching logic here.
- Whether a recursive occurrence-discovery helper already exists from
  Phase 1/2; if genuinely absent, add the minimal directory-walk-for-nested-
  `.git`-roots here rather than inventing a second discovery module.
