# Task 19 Plan: scripts/syncReceipts.ts — machine-readable sync receipts

## Scope guardrail
New module only. Do not wire this into any production call site. Do not touch
scripts/occurrenceBranchNames.ts, scripts/relatedTests.ts, or any other
existing file except to read them for reuse.

## Step 0 — Reuse check (do this before defining any type)
Open `scripts/occurrenceBranchNames.ts` (task 14) and `scripts/relatedTests.ts`
(task 18) and look for an existing exported type that already models:
- an occurrence's identity (e.g. an `Occurrence`, `OccurrenceRef`, or similar
  type), and
- a logical-repository identifier (e.g. a branded `LogicalRepoId` or plain
  string alias).

If either exists, import and reuse it in `syncReceipts.ts` — do not redefine
an equivalent shape. This module's job is receipt assembly and serialization,
not occurrence modeling.

If no reusable occurrence type exists, define the minimal local type instead:

```ts
interface Occurrence {
    id: string;
    parentChain: string[];
}
```

`id` — the occurrence's identifier (whatever the discovery/sync layer already
uses, e.g. a repo-relative path). `parentChain` — ordered ancestor ids from
immediate parent to root; empty array for a top-level occurrence.

**Why the parent chain is caller-supplied, not computed here:** the module
that walks the recursive occurrence tree (from an earlier phase of this
redesign) already knows each occurrence's ancestry when it hands off to a
sync. Re-deriving that chain here would duplicate tree-walking logic in a
second place that has to be kept in sync with the first. `syncReceipts.ts`
trusts the `parentChain` it's given and reproduces it faithfully — this is
what the "full chain, not just immediate parent" and "distinct chains for
different parents" tests are checking: pass-through fidelity, not chain
computation.

## Step 1 — RED: write the tests first
Create `tests/syncReceipts.test.ts`. Match the import/runner style already
used in `tests/relatedTests.test.ts` (same test framework, same relative
import conventions) — check that file's header before writing imports here.

Write four tests, each with plain-English step comments in the body per
`~/.claude/guides/tdd.md`, named for the behavior they prove:

1. **`lists all destinations with their branches, digests, and distinct parent chains for a three-occurrence sync`**
   - Build one source `Occurrence` and three destination entries, each pairing
     a distinct `Occurrence` with its own `branch` string and `contentDigest`
     string.
   - Call `buildSyncReceipt(logicalRepoId, source, changedPaths, destinations)`.
   - Assert `receipt.destinations` has length 3, and each entry's `branch`,
     `contentDigest`, and `parentChain` equal the corresponding fixture input
     (order preserved).

2. **`serializes and parses a receipt losslessly`**
   - Build any valid receipt fixture (reuse fixture 1's inputs).
   - `const json = serializeSyncReceipt(receipt)`.
   - `const roundTripped = parseSyncReceipt(json)`.
   - Assert `roundTripped` deep-equals `receipt`.

3. **`records the full parent chain to root for a nested occurrence, not just the immediate parent`**
   - Build a destination `Occurrence` whose `parentChain` has 3+ ancestor ids
     (e.g. `["parentA", "grandparentB", "rootC"]`).
   - Call `buildSyncReceipt`.
   - Assert the output destination's `parentChain` equals the full array, not
     a 1-element slice.

4. **`gives two occurrences of the same logical child under different parents different parent chains`**
   - Build two destination `Occurrence` fixtures with the same trailing id
     segment (same logical child) but different `parentChain` arrays (e.g.
     one under `["repoA"]`, the other under `["repoB"]`).
   - Call `buildSyncReceipt` with both as destinations.
   - Assert the two output `parentChain` values are not deep-equal, and each
     matches its own fixture input.

Run the suite and confirm it fails (module doesn't exist yet) before writing
any implementation.

## Step 2 — GREEN: implement scripts/syncReceipts.ts
Minimum code to pass all four tests:

```ts
export interface Occurrence {
    id: string;
    parentChain: string[];
}

export interface SyncDestination {
    occurrence: Occurrence;
    branch: string;
    contentDigest: string;
}

export interface SyncReceipt {
    logicalRepoId: string;
    source: Occurrence;
    changedPaths: string[];
    destinations: SyncDestination[];
}

export function buildSyncReceipt(
    logicalRepoId: string,
    source: Occurrence,
    changedPaths: string[],
    destinations: SyncDestination[]
): SyncReceipt {
    return { logicalRepoId, source, changedPaths, destinations };
}

export function serializeSyncReceipt(receipt: SyncReceipt): string {
    return JSON.stringify(receipt);
}

export function parseSyncReceipt(json: string): SyncReceipt {
    return JSON.parse(json);
}
```

(Skip this local `Occurrence` definition if Step 0 found a reusable type —
import that one instead and drop it from this file's exports.)

Do not add a content-hashing helper. "Content digest" is a string the caller
already has (e.g. a git blob SHA) — computing one speculatively here, before
any call site exists or the hash input format is known, is exactly what to
skip. Add it when the real caller shows up needing one.

## Step 3 — verify
Run the test file (same command used for `tests/relatedTests.test.ts`,
presumably `bun test tests/syncReceipts.test.ts`) and confirm all four tests
pass. Confirm `scripts/syncReceipts.ts` stays well under the 250-line cap and
that no file besides `scripts/syncReceipts.ts` and `tests/syncReceipts.test.ts`
was modified.

## Definition of done
- [ ] `scripts/syncReceipts.ts` exists, exporting `Occurrence` (or the reused
      equivalent), `SyncDestination`, `SyncReceipt`, `buildSyncReceipt`,
      `serializeSyncReceipt`, `parseSyncReceipt`.
- [ ] `tests/syncReceipts.test.ts` exists with the four tests above, all
      green.
- [ ] No production call site wired up; no other file touched.
