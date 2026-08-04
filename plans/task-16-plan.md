# Task 16 Plan: scripts/occurrenceSync.ts

Phase 2 of the recursive repository-discovery redesign: deterministic N-way
sync of accepted changes across every occurrence of a logical repository,
built on top of `scripts/occurrenceTreeDelta.ts` (Phase 1).

Note: per instruction, this plan was written from `plans/brief-16.md` alone —
`scripts/occurrenceTreeDelta.ts`'s actual exported names/signatures were not
read. The implementer must open that file first and reconcile the
"Assumed delta-module interface" section below against what it really
exports before writing code.

## Goal

Given one source occurrence (the "latest writer," holding an accepted
change) and the full N-member set of occurrences of the same logical
repository, fan the source's changes out to every other occurrence, then
confirm all N occurrences report the same code-tree digest. Return the
changed paths per occurrence and a convergence result. No production call
sites yet — this is a standalone module plus tests.

## Assumed delta-module interface (verify against real file first)

```ts
type ChangeKind = "add" | "delete" | "modify" | "rename" | "modeChange" | "symlink";
interface DeltaChange {
  kind: ChangeKind;
  path: string;        // path relative to occurrence root
  fromPath?: string;    // rename: previous relative path
  mode?: number;         // POSIX mode bits for add/modeChange/symlink
  symlinkTarget?: string; // symlink change kind
}
declare function computeDelta(sourceDir: string, targetDir: string): Promise<DeltaChange[]>;
declare function computeTreeDigest(dir: string): Promise<string>;
```

The critical property this plan relies on: `computeDelta` /
`computeTreeDigest` already exclude nested submodule contents and generated
output (stated as Phase 1's job in the brief). `occurrenceSync.ts` must not
re-walk the filesystem itself — it only ever acts on paths the delta module
reports. That's what makes "submodule files never copied" true for free,
without any submodule-detection logic in the new module.

If the real module's shape differs (different kind names, a single
`symlinkChange` field instead of a `symlink` kind, etc.), adapt the apply
step 1:1 — the algorithm below doesn't depend on the exact field names, only
on "one DeltaChange per path, tagged with what changed."

## Public API

```ts
// scripts/occurrenceSync.ts
export interface SyncResult {
  converged: boolean;
  iterations: number;
  changedPaths: Record<string /* occurrence path */, string[]>;
}

export async function syncOccurrences(
  sourceOccurrence: string,
  occurrences: string[],   // full set, source included; order irrelevant
  opts?: { maxIterations?: number },
): Promise<SyncResult>;
```

`occurrences` is the full N-member set (the brief says "one source
occurrence and an N-member set" — treat the set as all occurrences of the
logical repo, filter `source` out internally to get the target list, so
callers don't have to remember to exclude it).

## Algorithm

Star topology, not pairwise: every target is synced independently from the
source, never from each other. That's what gives order-independence for
free — `applyToTarget(source, targetA)` and `applyToTarget(source, targetB)`
share no state, so running them in any order (or in parallel) produces the
same end state.

```
function syncOccurrences(source, occurrences, opts):
  targets = occurrences.filter(o => o !== source)
  changedPaths = {} for each occurrence -> []
  maxIterations = opts.maxIterations ?? 5

  for iteration in 1..maxIterations:
    digests = { [o]: computeTreeDigest(o) for o in occurrences }
    if all digests equal:
      return { converged: true, iterations: iteration - 1, changedPaths }

    for target in targets:                 # order does not affect outcome
      delta = computeDelta(source, target)
      applied = applyDelta(target, delta)  # returns list of paths touched
      changedPaths[target] += applied

  finalDigests = { [o]: computeTreeDigest(o) for o in occurrences }
  return {
    converged: all finalDigests equal,
    iterations: maxIterations,
    changedPaths,
  }
```

Loop rationale: a single fan-out pass should converge in practice (delta
already reflects the full diff), but the brief asks for "repeating until
every occurrence reports the same digest" and a convergence result, not a
single blind apply. The loop also makes the second-call no-op guarantee
cheap to prove: run 1 converges and records real changes; run 2's very
first digest check already matches, so `changedPaths` comes back empty and
`iterations` is 0.

`maxIterations` default of 5 is a ponytail-style ceiling, not a tuned
constant — one pass converges for every real delta; the loop exists so a
mid-apply failure (e.g. a transient fs error) gets a bounded retry instead
of an infinite loop. Bump only if a real scenario needs it.

## applyDelta(targetDir, changes) — per change kind

Straight fs operations, no cleverness:

- `add` / `modify`: read file bytes from source path, write to
  `targetDir/change.path`, create parent dirs as needed, `chmod` to
  `change.mode` when present.
- `delete`: `fs.rm(targetDir/change.path)`.
- `rename`: if the target still has the old path, `fs.rename` it to the new
  path; otherwise fall back to delete-old-if-present + write-new (handles
  the case where a prior partial apply already moved it). Preserve mode.
- `modeChange`: `fs.chmod(targetDir/change.path, change.mode)`.
- `symlink`: remove whatever is at the path (file, dir, or stale symlink),
  then `fs.symlink(change.symlinkTarget, targetDir/change.path)`.

Every op returns the relative path it touched; `applyDelta` collects those
into the list `syncOccurrences` records under `changedPaths[target]`.

No pairwise special-casing anywhere in this function — it only ever knows
about "one target, one delta list from the source." That's what makes 2, 3,
and larger occurrence sets behave identically: N-1 independent calls to the
same function.

## Edge cases

- **Empty delta** (target already matches source): `applyDelta` is a no-op,
  `changedPaths[target]` stays `[]`.
- **Single-member set** (`occurrences = [source]`): no targets, digest
  check trivially passes on iteration 1, `converged: true`, `iterations: 0`.
- **maxIterations exhausted without convergence**: return
  `converged: false` with whatever `changedPaths` accumulated — caller
  decides what to do (surface a diagnostic), this module doesn't throw.

## Test plan — tests/occurrenceSync.test.ts

Use real temp-directory fixtures (mirrors how `occurrenceTreeDelta.test.ts`
presumably works — confirm that pattern when implementing) rather than
mocking the delta module, since the digest-convergence check is the actual
thing under test.

1. **Three-way tmux_lib fan-out**: three occurrence dirs seeded identically,
   introduce a fix in one, run `syncOccurrences(source, [a, b, c])`, assert
   all three `computeTreeDigest` calls afterward are equal and
   `result.converged === true`.
2. **Two-copy claude_plugin_lib convergence**: same shape, N=2.
3. **Two-copy scenarios convergence**: same shape, N=2, different fixture
   content (confirms nothing tmux_lib-specific leaked into the algorithm).
4. **Deletion propagates**: delete a file in source, confirm it's absent
   from every target post-sync and appears in `changedPaths`.
5. **Rename propagates**: rename a file in source, confirm target reflects
   the rename (not a stray copy + orphaned old file).
6. **Mode change propagates**: flip an executable bit in source, assert
   target's mode matches after sync.
7. **Symlink propagates**: add/change a symlink in source, assert target's
   symlink target matches (use `fs.lstat`/`readlink`, not `fs.stat`, so the
   check doesn't follow the link).
8. **Untracked addition propagates**: add a new file in source with no
   history, confirm it's copied.
9. **Submodule isolation**: seed a nested submodule directory (or a
   directory shaped like one, matching whatever `occurrenceTreeDelta`
   fixtures use to signal "submodule") inside one occurrence only, run
   sync, assert the sibling occurrence's tree has zero files under that
   path afterward.
10. **Idempotent re-run**: call `syncOccurrences` twice in a row on the same
    fixture; assert the second call returns `converged: true`,
    `iterations: 0`, and every `changedPaths[o]` is `[]`.
11. **Order-independence** (covers the "no pairwise assumptions" requirement
    directly): run the 3-way fixture with `occurrences` passed as
    `[a, b, c]` and again as `[c, a, b]` (same source each time), assert
    the resulting digests and changed-path sets are identical regardless of
    array order.

## Files

- `scripts/occurrenceSync.ts` — new module, `syncOccurrences` + internal
  `applyDelta` helper. Single file; keep under the 250-line cap — if
  `applyDelta`'s per-kind branches push it over, split `applyDelta` into
  its own file (e.g. `scripts/occurrenceSyncApply.ts`) rather than
  trimming logic.
- `tests/occurrenceSync.test.ts` — new test file covering the 11 scenarios
  above.

## Skipped (ponytail)

- No retry/backoff tuning beyond the flat `maxIterations` cap — add real
  backoff only if a live run ever needs more than one iteration to
  converge.
- No CLI wrapper or production call site — brief says none yet.
- No dry-run/preview mode — not requested; add if a caller needs to show a
  diff before applying.
