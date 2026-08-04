# Task 14 Plan: occurrenceBranchNames.ts

Phase 2 of the recursive repository-discovery redesign. Brief: `plans/brief-14.md`.

## Context (grounds the "why" for the choices below)

- `scripts/repositoryDiscovery.ts` builds `occurrenceId` as the root-relative path of a
  checkout (`""` for the root, `"jfred/external/tmux_lib"` for a nested submodule, etc.),
  forward-slash delimited regardless of OS.
- `scripts/logicalRepository.ts` already groups occurrences that share an upstream
  identity into a `LogicalRepository` with `occurrenceIds: string[]` and
  `consolidationState: "single" | "grouped"`. A `"single"` logical repository has exactly
  one occurrence; a `"grouped"` one has two or more occurrences of the *same* underlying
  repo checked out at different paths (e.g. `tmux_lib` vendored three times under
  `jfred/`).
- `scripts/prepareTasks.ts` names the branch shared by every repo in a task group
  `task-group-${groupId}` — this is the "plain group operation branch name" the brief
  refers to. Today `scripts/repositoryBranches.ts#createBranchInEveryRepository` checks
  out that *same* branch name in the parent and every submodule.
- That collides once a submodule can appear at multiple occurrence paths: the same
  underlying git repo can't have two different occurrences both claim the branch name
  `task-group-3` and mean different things. `occurrenceBranchNames.ts` is the naming
  function that will let a future call site give each occurrence of a repeated logical
  repository its own branch, while a logical repository with only one occurrence keeps
  using the plain group branch name unchanged.
- This task only adds the naming module + its tests. It is not wired into
  `repositoryDiscovery.ts`, `repositoryBranches.ts`, or `logicalRepository.ts` — brief
  says "no production call sites yet."

## Design

Pure module, no git calls, no I/O. Operates on plain occurrence-path strings so it's
testable without constructing `RepositoryOccurrence` fixtures (nothing here needs the
richer manifest type yet).

`scripts/occurrenceBranchNames.ts`:

```ts
import { createHash } from "node:crypto";

// ponytail: 40-bit truncation (10 hex chars) of a sha256 digest — plenty for realistic occurrence counts per logical repository; widen HASH_LENGTH if collisions are ever observed.
const HASH_LENGTH = 10;

function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-");
    return cleaned === "" ? "seg" : cleaned;
}

function sanitizeOccurrencePath(occurrencePath: string): string {
    return occurrencePath.split("/").map(sanitizeSegment).join("/");
}

function collisionHash(occurrencePath: string): string {
    return createHash("sha256").update(occurrencePath).digest("hex").slice(0, HASH_LENGTH);
}

export function occurrenceBranchNames(
    groupBranchName: string,
    occurrencePaths: string[],
): Map<string, string> {
    const names = new Map<string, string>();
    if (occurrencePaths.length <= 1) {
        for (const path of occurrencePaths) names.set(path, groupBranchName);
        return names;
    }
    for (const path of occurrencePaths) {
        const sanitizedPath = sanitizeOccurrencePath(path);
        names.set(path, `${groupBranchName}/${sanitizedPath}-${collisionHash(path)}`);
    }
    return names;
}
```

Rationale for each piece (so the implementing agent can answer "why" for any line):

- **Input shape (`groupBranchName: string, occurrencePaths: string[]`) →
  `Map<occurrencePath, branchName>`**: mirrors the existing `Map`-returning helpers
  (`repositoryGraph.ts`, occurrence lookups in `repositoryManifest.ts`); the caller
  already has all occurrence paths for one logical repository (from
  `LogicalRepository.occurrenceIds`), so passing the whole list lets the function decide
  unique-vs-repeated itself instead of forcing the caller to branch on
  `consolidationState` beforehand.
- **`occurrencePaths.length <= 1` → plain `groupBranchName`**: this is the brief's "a
  unique repository gets the plain group operation branch name" rule. `<= 1` (not `=== 1`)
  so an empty list degenerates to an empty map instead of throwing — no test requires
  throwing on empty input, so don't add that branch (YAGNI).
- **Sanitizer keeps `/` as a hierarchy separator**: occurrence paths are already
  slash-delimited directory paths, and git refs use `/` natively for namespacing
  (`task-group-3/jfred/external/tmux_lib-<hash>` reads as nested namespaces, same pattern
  `tackle-op/<runId>/<occurrenceId>` already uses in `operationBranches.ts`).
- **Sanitizer replaces every char outside `[A-Za-z0-9_-]` with `-`, including `.`**:
  git's `check-ref-format` forbids leading `.`, trailing `.`, `..` anywhere, and several
  other punctuation chars (space, `~^:?*[\`). Blanket-replacing `.` too (instead of
  allow-listing it and then separately guarding the `..`/leading/trailing cases) removes
  every one of those failure modes in one line — simpler than reproducing the full
  `check-ref-format` rule set.
- **Empty segment → `"seg"` fallback**: guards a pathological empty path segment (e.g. a
  stray `//`) from producing a `//` in the final ref, which `check-ref-format` rejects.
  Not expected to occur given how `repositoryDiscovery.ts` builds `occurrenceId`, but the
  fallback is one line and keeps the function total instead of throwing on malformed
  input.
- **Hash is `sha256(<raw, unsanitized path>)`, not the sanitized path**: this is what
  makes the "two paths that sanitize to the same string still differ by hash" guarantee
  hold — if the hash were computed from the sanitized string, two paths that sanitize
  identically would also hash identically and collide.
- **No `runId`/timestamp/random component**: the brief requires "byte-identical across
  repeated invocations." `operationBranches.ts`'s `operationBranchName` takes a `runId`
  because it names a branch for one run; this function names a branch for a repo
  occurrence and must be stable run-over-run, so it intentionally has no such input.

## File 1 (tests first): `tests/occurrenceBranchNames.test.ts`

Follow the repo's existing test conventions (see `tests/logicalRepository.test.ts`,
`tests/repositoryBranches.test.ts`): `node:test` + `node:assert/strict`, one `test(...)`
per behavior, names prefixed `test_`. Use `execFileSync("git", ["check-ref-format",
"--branch", name])` (throws on invalid) for the git-validity assertions — no temp repo
needed, `check-ref-format` doesn't require a `.git` directory.

Write these cases (they map 1:1 onto the brief's required test list):

1. `test_uniqueRepositoryGetsThePlainGroupBranchName` — call with a single-element
   `occurrencePaths` array; assert the returned map has exactly one entry whose value
   `=== groupBranchName` (not a derived/sanitized/hashed name).
2. `test_threeTmuxLibOccurrencesGetThreeDistinctValidBranchNames` — reuse the exact
   fixture paths from `tests/logicalRepository.test.ts`'s `buildMultiRepoFixture`:
   `"tmux_lib"`, `"jfred/external/tmux_lib"`,
   `"jfred/jfredToolsPlugin/external/tmux_lib"`. Assert the three returned names are
   pairwise distinct (`new Set(names).size === 3`) and each passes
   `check-ref-format --branch`.
3. `test_namesAreByteIdenticalAcrossRepeatedInvocations` — call
   `occurrenceBranchNames(...)` twice with the same inputs (same 3-path tmux_lib list);
   assert `deepEqual` between the two returned maps (convert to sorted entries array or
   compare `Object.fromEntries`).
4. `test_pathsThatSanitizeToTheSameStringStillDifferByHash` — construct two occurrence
   paths that sanitize to an identical string but are different raw strings, e.g.
   `"a:b/c"` and `"a?b/c"` (both sanitize to `"a-b/c"` since `:` and `?` both become `-`).
   Call with `occurrenceBranchNames("task-group-1", ["a:b/c", "a?b/c"])`; assert the two
   returned names differ.
5. `test_everyGeneratedNamePassesGitCheckRefFormat` — build one combined list covering:
   the plain-group case, the three tmux_lib occurrences, and the same-sanitized-string
   pair from case 4; for every value in every returned map, run
   `execFileSync("git", ["check-ref-format", "--branch", name])` and assert it does not
   throw (wrap in `assert.doesNotThrow`).

Write the full test file, run it, confirm every test fails with "Cannot find module
'../scripts/occurrenceBranchNames.ts'" (red) before writing the implementation.

## File 2: `scripts/occurrenceBranchNames.ts`

Write exactly the implementation in the Design section above. Add the one-line file
header comment convention used by every other file in `scripts/` (see the `//` comment
atop `operationBranches.ts`, `logicalRepository.ts`, etc.) — one line, states what the
module does, e.g.:

```ts
// Assigns each occurrence of a logical repository a valid, deterministic git branch name.
```

## Order of work

1. Write `tests/occurrenceBranchNames.test.ts` in full (all 5 cases above).
2. Run `node --test tests/occurrenceBranchNames.test.ts` — confirm it fails because the
   module doesn't exist yet (red).
3. Write `scripts/occurrenceBranchNames.ts` per the Design section.
4. Re-run `node --test tests/occurrenceBranchNames.test.ts` — all 5 tests green.
5. Run the full suite (`node --test tests/`) to confirm nothing else regressed — this
   task touches no other file, so this is a sanity check, not expected to find anything.

## Explicitly out of scope (don't do these; note them if asked)

- No changes to `repositoryDiscovery.ts`, `repositoryBranches.ts`,
  `operationBranches.ts`, or `logicalRepository.ts` — brief says no production call
  sites yet.
- No `RepositoryOccurrence`/`LogicalRepository` typed API — plain strings in, `Map` out,
  per the Design rationale above. A later phase that wires this in can adapt
  `LogicalRepository.occurrenceIds` into the `occurrencePaths` array at the call site.
- No branch-length/filesystem-path-length guard — not in the brief's test list; add only
  if a real collision or filesystem limit is observed (ponytail: don't build for an
  untested ceiling).
