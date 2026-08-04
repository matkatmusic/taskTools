# Task 12 Plan — LogicalRepository records overlaid on the occurrence graph

Source brief: `plans/brief-12.md`. Phase 2 of the recursive repository-discovery
redesign. New module only — nothing in this task wires the new module into
any existing discovery/manifest-writing call site.

## Step 0 — Investigate before writing any code

Do these lookups first; do not guess at shapes.

1. Open `scripts/submoduleUrlIdentity.ts` and note its exact exported
   normalization function name, its input type (what it accepts — a raw URL
   string vs. an occurrence object), and its return type (call it
   `NormalizedSubmoduleIdentity` below, but use whatever it's actually
   named). Reuse this type/function as-is — do not re-implement URL
   normalization here (ladder rung 2: it already exists).
2. Find the existing occurrence-tree type from phase 1 of this redesign
   (search with `rg -i "occurrence" scripts/` and `rg -i "occurrence" tests/`).
   Identify the field names for: occurrence id, parent edge (parent
   occurrence id / null for root), path, and whichever field holds the raw
   submodule URL that feeds `submoduleUrlIdentity.ts`. Call this type
   `Occurrence` below — substitute the real name/fields you find.
3. Open one existing test file under `tests/` to confirm the test runner and
   import style in use (this repo prefers `bun`, so expect
   `import { describe, test, expect } from "bun:test"` — confirm rather than
   assume).
4. Check whether a "run manifest" type already exists in the codebase (e.g.
   `rg -i "manifest" scripts/`). If one exists, note its shape but **do not
   edit it** — see the "Run manifest" note below for why.

## Why these fields, and why nothing more

The brief lists six things the record must hold: normalized identity, all
occurrence ids sharing it, a selected base, a canonical occurrence, a
last-writer occurrence, a convergence digest, and consolidation state — plus
persistence into the run manifest. The brief does not specify *how* to pick
the base/canonical/last-writer occurrence, nor what convergence-digest
input or consolidation states should be — those selection policies are a
later phase's concern (nothing calls this module yet, so nothing depends on
the policy being "correct," only on the shape existing and the grouping
being right). Build the simplest deterministic placeholder for each,
mark it `ponytail:` in the code, and let a future task swap in a real
policy once there's a call site that needs one. Inventing a scoring/merge
algorithm now would be speculative work the brief never asked for.

## Step 1 — Types and grouping logic (`scripts/logicalRepository.ts`)

```ts
export type ConsolidationState = "single" | "grouped";

export interface LogicalRepository {
    normalizedIdentity: NormalizedSubmoduleIdentity;
    occurrenceIds: string[];
    selectedBaseOccurrenceId: string;
    canonicalOccurrenceId: string;
    lastWriterOccurrenceId: string;
    convergenceDigest: string;
    consolidationState: ConsolidationState;
}

export function buildLogicalRepositories(occurrences: Occurrence[]): LogicalRepository[] {
    const groupsByIdentityKey = new Map<string, Occurrence[]>();
    for (const occurrence of occurrences) {
        const identity = normalizeSubmoduleUrl(occurrence.rawUrl);
        const key = identityToMapKey(identity);
        const group = groupsByIdentityKey.get(key) ?? [];
        group.push(occurrence);
        groupsByIdentityKey.set(key, group);
    }
    return Array.from(groupsByIdentityKey.values()).map(buildLogicalRepositoryFromGroup);
}
```

Notes on this shape, so an implementer can answer "why" for each line:

- Grouping uses a `Map` keyed by a stable string form of the normalized
  identity, built by iterating `occurrences` once, in input order. This
  naturally supports any group size (1, 2, 3, N) with no special-casing —
  satisfies "no code path may assume one or two."
- `occurrenceIds` on each group preserves the original discovery order of
  `occurrences` (the order they appear in the input array), because nothing
  in the brief asks for re-sorting and re-sorting would be an unrequested
  transformation of caller-supplied order.
- The function only *reads* fields off each `Occurrence` — it never
  mutates an occurrence and never touches parent/path fields. This is what
  keeps the occurrence tree intact; the overlay is purely additive grouping
  metadata layered on top.
- `identityToMapKey`: if the normalization function/type from
  `submoduleUrlIdentity.ts` already returns (or can trivially produce) a
  primitive string, use that directly as the Map key and delete this helper
  — one line beats a helper function (ladder rung 6). Only write a
  `identityToMapKey` helper if the normalized identity is a non-primitive
  object without a ready-made string form.

`buildLogicalRepositoryFromGroup`:

```ts
function buildLogicalRepositoryFromGroup(group: Occurrence[]): LogicalRepository {
    const occurrenceIds = group.map((occurrence) => occurrence.id);
    const canonicalOccurrenceId = occurrenceIds[0];
    // ponytail: no write-timestamp field on Occurrence yet; last writer == last discovered until real mtime/write tracking exists upstream.
    const lastWriterOccurrenceId = occurrenceIds[occurrenceIds.length - 1];
    // ponytail: no base-selection policy specified by the brief; base defaults to canonical until a future task defines real selection.
    const selectedBaseOccurrenceId = canonicalOccurrenceId;
    const convergenceDigest = digestOccurrenceIds(occurrenceIds);
    const consolidationState: ConsolidationState =
        occurrenceIds.length === 1 ? "single" : "grouped";
    return {
        normalizedIdentity: normalizeSubmoduleUrl(group[0].rawUrl),
        occurrenceIds,
        selectedBaseOccurrenceId,
        canonicalOccurrenceId,
        lastWriterOccurrenceId,
        convergenceDigest,
        consolidationState,
    };
}
```

- `digestOccurrenceIds` hashes a *sorted* copy of the occurrence ids with
  `node:crypto` (`createHash("sha256").update(sorted.join("\n")).digest("hex")`).
  Sorting only inside the digest keeps the digest stable regardless of
  discovery order, while `occurrenceIds`/`canonicalOccurrenceId`/
  `lastWriterOccurrenceId` keep using the unsorted, discovery-ordered array —
  don't sort those, or you lose the "own parent edge and path" ordering the
  tests check against. This is stdlib-only (ladder rung 3), no new
  dependency.
- `ConsolidationState` only has two values because that's all this phase can
  honestly determine (one occurrence vs. more than one). Don't add
  `"converged" | "conflicted"` states now — there's no diffing logic in this
  task to ever produce them.

## Step 2 — Run manifest persistence

Do **not** add a serializer/wrapper function and do **not** edit any
existing run-manifest file. `LogicalRepository` is already plain
strings/arrays — it's directly `JSON.stringify`-safe. That satisfies
"persist the equivalence classes in the run manifest" structurally: the
array `buildLogicalRepositories` returns *is* the manifest-ready form. The
brief itself says "no production call sites yet," so writing a manifest
key/wiring code here would be building for a caller that doesn't exist —
skip it. Leave a one-line comment in the module noting this is the
manifest-ready shape, so the future wiring task knows it doesn't need to
transform anything.

## Step 3 — Tests (`tests/logicalRepository.test.ts`), TDD red→green

Confirm the test runner import (Step 0.3) before writing these. Write each
test in RED first (call the not-yet-written functions, watch it fail to
compile/run), then implement just enough of Step 1 to go GREEN. Keep each
test to one behavior per the granularity rule in the TDD guide.

Build one shared fixture-building helper at the top of the file (not a full
mock framework — just a small `makeOccurrence(id, parentId, path, rawUrl)`
literal-object factory) so each test stays short. Use it to construct this
fixture, matching the brief's scenario:

- Three occurrences of the same upstream, all sharing one `rawUrl` (or URL
  variants that normalize to the same identity — pick whichever the real
  `submoduleUrlIdentity.ts` normalizes, per Step 0.1):
  `tmux_lib`, `jfred/external/tmux_lib`, `jfred/jfredToolsPlugin/external/tmux_lib`,
  each with a distinct id, distinct parent id, distinct path.
- Two occurrences of `claude_plugin_lib` (same upstream identity, distinct
  ids/parents/paths).
- Two occurrences of `scenarios` (same upstream identity, distinct
  ids/parents/paths).
- One occurrence of a unique repo, e.g. `only_one_lib`.

Test functions:

1. `test_groupsThreeOccurrencesOfSameUpstreamIntoOneLogicalRepository`
   - Steps: build the fixture; call `buildLogicalRepositories`; find the
     logical repository whose `occurrenceIds` correspond to the three
     `tmux_lib` occurrences; assert `occurrenceIds.length === 3`; assert the
     set of ids matches exactly the three tmux_lib occurrence ids (no more,
     no fewer).

2. `test_preservesEachOccurrencesParentEdgeAndPath`
   - Steps: build the fixture; deep-clone/snapshot the fixture occurrences
     before calling `buildLogicalRepositories`; call it; assert the original
     fixture array's objects are unchanged (`parentId`/`path`/`id` per
     occurrence still match the pre-call snapshot) — proves the overlay is
     read-only and never rewrites parent edges or paths.

3. `test_groupsTwoOccurrencesOfClaudePluginLibIntoOwnTwoMemberClass`
   - Steps: build the fixture; call `buildLogicalRepositories`; find the
     logical repository for `claude_plugin_lib`; assert exactly 2 occurrence
     ids, both belonging to the two `claude_plugin_lib` fixture entries, and
     that this class is a different object from the `tmux_lib` and
     `scenarios` classes.

4. `test_groupsTwoOccurrencesOfScenariosIntoOwnTwoMemberClass`
   - Same shape as #3, for `scenarios`.

5. `test_formsOneMemberClassForUniqueRepository`
   - Steps: build the fixture; call `buildLogicalRepositories`; find the
     logical repository for `only_one_lib`; assert `occurrenceIds.length === 1`
     and `consolidationState === "single"`.

6. `test_supportsFourOrMoreOccurrencesOfOneLogicalRepository`
   - Steps: build a fixture with 5 occurrences of one shared upstream, no
     other repos; call `buildLogicalRepositories`; assert exactly one
     logical repository is returned with `occurrenceIds.length === 5` and
     all 5 ids present. This exists specifically to catch any accidental
     pairwise/binary assumption in the grouping code (brief: "no code path
     may assume one or two").

7. `test_overlayNeverDropsMergesOrReparentsAnyOccurrenceAcrossFullFixture`
   - Steps: build the full multi-repo fixture (tmux_lib x3,
     claude_plugin_lib x2, scenarios x2, only_one_lib x1 — 8 occurrences
     total); call `buildLogicalRepositories`; flatten every
     `occurrenceIds` array across all returned logical repositories; assert
     the flattened list, as a set, exactly equals the set of input
     occurrence ids (nothing dropped, nothing duplicated/merged across
     classes); assert total logical-repository count is 4 (one per distinct
     upstream); assert no id appears in more than one logical repository's
     `occurrenceIds` (proves no cross-class merge).

8. `test_eachLogicalRepositoryIncludesRequiredRecordFields`
   - Steps: build a small fixture with one 2-occurrence group; call
     `buildLogicalRepositories`; assert the returned record has all seven
     required fields (`normalizedIdentity`, `occurrenceIds`,
     `selectedBaseOccurrenceId`, `canonicalOccurrenceId`,
     `lastWriterOccurrenceId`, `convergenceDigest`, `consolidationState`)
     and that `selectedBaseOccurrenceId`/`canonicalOccurrenceId` are each one
     of the group's own `occurrenceIds` (not a foreign id).

## Step 4 — Verification

- Run the test file (`bun test tests/logicalRepository.test.ts`, confirm
  exact invocation from Step 0.3) — all 8 tests green.
- Run the full test suite once to confirm this new module doesn't collide
  with or break anything else (it shouldn't — it's additive and unimported
  elsewhere).
- Check `scripts/logicalRepository.ts` line count stays under the 250-line
  cap. If it's close, split types from grouping logic into two files rather
  than trimming comments/tests — don't preemptively split before checking.
- Confirm no other file was edited — this task is new-file-only
  (`scripts/logicalRepository.ts`, `tests/logicalRepository.test.ts`).

## Explicitly out of scope (say so, don't build it)

- No real base/canonical/last-writer *selection policy* — placeholders only,
  marked `ponytail:`, upgraded when a real policy is specified.
- No content-based convergence detection (diffing occurrence contents) —
  the digest is over occurrence ids only.
- No manifest-writer wiring, no call site anywhere in production code.
- No mutation helpers, no "reparent" API — the brief explicitly forbids
  collapsing/reparenting, so there's nothing to build for that beyond the
  read-only grouping function and its test coverage.
