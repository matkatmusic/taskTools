# Task 21 Plan: Canonical Ownership Keys with Occurrence and Ancestor-Gitlink Effect Expansion

## What this builds
A new module, `scripts/ownershipKeys.ts`, with no production call sites yet. It does two things, in order:
1. Canonicalizes a declared task path into an ownership key: `{ logicalRepoId, pathWithinRepo }`. Any occurrence-specific alias path that names the same logical file must canonicalize to the same key.
2. Expands that key's effects to every synchronized occurrence path for that logical repository, plus every distinct ancestor gitlink on each occurrence's parent chain up to the repository root.

This module does not discover occurrences, logical repositories, or gitlinks itself — those were built in earlier phases of the same "recursive repository-discovery redesign" (this plan was scoped to `plans/brief-21.md` only, so the earlier-phase module names below are not verified and must be confirmed by the implementer before writing code).

## Step 0 — Locate the Phase 1/2 dependencies (do this before writing any code)
Search `scripts/` and `tests/` for the existing occurrence-graph and logical-repository-map modules built in prior tasks of this redesign (git log shows task 14 added an `occurrenceBranchNames` module and task 18 added per-occurrence test-policy discovery — both imply an `Occurrence`/logical-repo concept already exists). Confirm, by reading that code directly (not from this plan):
- The exported type/function that, given any path, returns which logical repository it belongs to and the path relative to that repository's root.
- The exported type/function that, given a logical repository id, returns every synchronized occurrence path for it.
- The exported type/function that, given an occurrence path, returns its ordered ancestor gitlink chain up to the repository root.
- The fixture/example data already used in existing occurrence tests that has a repo occurring in exactly three places (the brief calls it `tmux_lib`) — reuse that same fixture rather than inventing a new one, so this module's tests exercise the same known example as the rest of the redesign.

Do not reimplement any of the above inside `ownershipKeys.ts`. Import and compose them.

## Types (scripts/ownershipKeys.ts)
```ts
interface OwnershipKey {
    logicalRepoId: string;
    pathWithinRepo: string;
}

interface OwnershipEffects {
    key: OwnershipKey;
    occurrencePaths: string[];
    ancestorGitlinks: string[];
}
```
Rename fields to match whatever terminology the Phase 1/2 modules already use for "logical repository id" and "path relative to repo root" — do not introduce parallel vocabulary for a concept that's already named.

## Functions, in build order
1. `computeCanonicalOwnershipKey(taskPath: string): OwnershipKey`
   - Look up which logical repository `taskPath` belongs to and its path relative to that repository's root, via the Phase 1/2 lookup.
   - Return `{ logicalRepoId, pathWithinRepo }`. Two occurrence-alias paths for the same logical file must produce identical output here — this is the entire canonicalization guarantee, so no other function should re-derive it differently.

2. `expandOwnershipEffects(key: OwnershipKey): OwnershipEffects`
   - Fetch every occurrence path registered for `key.logicalRepoId`; for each, append `key.pathWithinRepo` to build the full occurrence-path list.
   - For each occurrence path in that list, fetch its ancestor gitlink chain to the root and union all of them into one deduplicated list (a repo occurring in 3 places under different parent chains will share some ancestor gitlinks and differ in others — dedupe across occurrences, don't just concatenate).
   - Return `{ key, occurrencePaths, ancestorGitlinks }`.

3. `expandTaskPathEffects(taskPath: string): OwnershipEffects`
   - Thin composition: `expandOwnershipEffects(computeCanonicalOwnershipKey(taskPath))`. Every real caller needs both steps together, so this is the function later call sites should use.

## Tests (tests/ownershipKeys.test.ts)
One behavior per test, named `test_<behavior>`, with plain-English step comments above the assertions (per `~/.claude/guides/tdd.md`).

1. `test_twoAliasPathsForSameLogicalFileProduceSameCanonicalKey`
   - Two different occurrence paths naming the same logical file → `computeCanonicalOwnershipKey` on each → assert the two keys are deep-equal.

2. `test_pathInsideTmuxLibOccurrenceExpandsToAllThreeOccurrencePaths`
   - A path inside one `tmux_lib` occurrence → `expandTaskPathEffects` → assert `occurrencePaths` is exactly the three known `tmux_lib` occurrence paths.

3. `test_expansionIncludesEachDistinctAncestorGitlinkToRoot`
   - A path whose occurrences sit under different parent chains → `expandTaskPathEffects` → assert `ancestorGitlinks` contains every distinct gitlink across all occurrences' chains, with no duplicates.

4. `test_pathInUniqueRepositoryExpandsToItselfPlusAncestorGitlinks`
   - A path in a logical repository with exactly one occurrence → `expandTaskPathEffects` → assert `occurrencePaths === [taskPath]` and `ancestorGitlinks` matches that occurrence's ancestor chain.

5. `test_pathsInDifferentLogicalRepositoriesNeverShareAKey`
   - Two paths known to belong to different logical repositories → `computeCanonicalOwnershipKey` on each → assert the two keys are not deep-equal (differing `logicalRepoId`).

## Red-green order
1. Write test 1 with a stub `computeCanonicalOwnershipKey` → red.
2. Implement `computeCanonicalOwnershipKey` against the Phase 1/2 lookup → green on test 1.
3. Write test 5 against the same implementation — if it fails, the lookup in step 2 is wrong, fix there (no new logic needed).
4. Write test 4, add minimal `expandOwnershipEffects`/`expandTaskPathEffects` handling the single-occurrence case → green.
5. Write test 2 (three-occurrence case), extend `expandOwnershipEffects` to iterate all occurrences for the logical repo, not just the input path → green.
6. Write test 3 (ancestor dedupe across occurrences), extend to union+dedupe gitlinks across all occurrence paths → green.

## Constraints
- New module only. Do not wire `ownershipKeys.ts` into any existing call site — the brief is explicit that this phase has none yet.
- Do not reimplement occurrence discovery, logical-repo id assignment, or gitlink-ancestor walking; reuse the Phase 1/2 modules located in Step 0.
- Keep both new files under 250 lines; split further only if reuse forces it past the cap.
- TypeScript, 4-space indentation, no unrequested abstractions (no interface/factory for a single implementation).

## Open item for the implementer
The exact type/function names from the Phase 1/2 occurrence-graph and logical-repository-map modules are not named in this plan because this planning pass was scoped to `plans/brief-21.md` only. Resolve by reading the actual code in Step 0, not by guessing.
