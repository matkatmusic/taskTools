# Task 4 Plan: Occurrence-graph traversal helpers driven by explicit edges

## Goal

Add `scripts/repositoryGraph.ts` — a new module of pure traversal helpers over
the manifest graph produced by `scripts/repositoryManifest.ts`. Phase 1 of the
recursive repository-discovery redesign. No existing call sites change; this
is additive only.

## Constraints (from brief)

- Every helper must walk recorded parent/child edges and recorded depth from
  the manifest — never `dirname()`, path-segment stripping, slash counting,
  or longest-prefix matching over raw path strings.
- Ordering must be deterministic: deepest-first, then by path within the
  immediate parent.
- New module only — do not touch `scripts/repositoryBranches.ts` or
  `scripts/mergeTaskWorktrees.ts` (their flat-path helpers stay in place
  until the Phase 4 cutover task).
- Must correctly distinguish real occurrences from synthetic path
  intermediates (e.g. `jfred/external` is a path segment, not a repository,
  and must never be returned as one).

## Step 0 — Read the manifest module first

Before writing any code, read `scripts/repositoryManifest.ts` in full to get
its exact exported types/functions: what an "occurrence" node looks like,
how parent/child edges are represented, how `depth` is recorded, and how a
root-relative path maps to an owning occurrence. This plan was written from
the brief only (explicitly barred from reading other files); the
implementer must confirm the real shape before coding against it, since the
helpers below are named/typed generically and must be adapted to match.

## Step 1 — Design the helper surface

Based on the brief, `scripts/repositoryGraph.ts` needs to export:

1. **`getChildren(occurrence)`** — direct children of an occurrence, read
   from recorded child edges only.
2. **`getAncestorChain(occurrence)`** — the chain from the occurrence up to
   the root, read from recorded parent edges only (stop when parent is
   absent/root).
3. **`getDeepestFirstOrder(occurrences)`** (or `orderDeepestFirst`) —
   returns all occurrences sorted deepest-first using recorded `depth`,
   with ties broken by path within the immediate parent (deterministic
   secondary sort — likely lexicographic on the path segment relative to
   the parent, not the full raw path).
4. **`getOwningOccurrence(rootRelativePath)`** — given a root-relative file
   path, returns the occurrence that owns it, resolved via the graph (e.g.
   walking occurrences and matching against each occurrence's own recorded
   root path plus edges), not via prefix-matching the string.
5. **`getPathWithinRepository(rootRelativePath, owningOccurrence)`** — the
   file's path relative to its owning occurrence's root.

Exact function names/signatures should match whatever naming convention
`repositoryManifest.ts` already established (verified in Step 0) so the
module reads as a natural companion, not a parallel vocabulary.

## Step 2 — Implement `scripts/repositoryGraph.ts`

- Import the manifest type(s) and any existing manifest-building function
  from `scripts/repositoryManifest.ts`; do not re-derive graph structure —
  only traverse what the manifest already recorded.
- Implement the five helpers from Step 1 as pure functions operating on the
  manifest data structure (no filesystem access, no string-path inference).
- Keep the file under the 250-line cap; if the honest implementation would
  exceed it, split ordering/lookup helpers into a second small file rather
  than compress the code.
- No comments beyond one-line clarifications where truly needed.

## Step 3 — Write `tests/repositoryGraph.test.ts`

Build one fixture graph matching the brief's exact scenario:

```
jfred
jfred/external/tmux_lib
jfred/jfredToolsPlugin
jfred/jfredToolsPlugin/external/tmux_lib
```

Note the fixture must model `jfred/external/tmux_lib` as a child whose
*parent* is `jfred` directly (i.e. `external` is not itself a repository
occurrence — it's a path segment inside `jfred` that contains a nested repo).
Construct the fixture using the manifest's real node/edge shape (from Step 0),
not by hand-rolling a different shape.

Test cases required by the brief:

1. **Direct-child lookup** — `getChildren(jfred)` returns exactly
   `[jfred/external/tmux_lib, jfred/jfredToolsPlugin]` (not
   `jfred/jfredToolsPlugin/external/tmux_lib`, which is two levels down).
2. **Ancestor traversal** — ancestor chain of
   `jfred/jfredToolsPlugin/external/tmux_lib` is
   `[jfred/jfredToolsPlugin, jfred]` (or including itself, per whatever
   convention Step 0 reveals — pick one and assert it consistently).
3. **Parent identity assertion (explicit brief requirement)** — assert the
   parent of `jfred/external/tmux_lib` is exactly `jfred`, proving the
   traversal used recorded edges and not a `dirname()`-style guess (which
   would wrongly imply a `jfred/external` repo).
4. **No synthetic path returned** — assert that no lookup or traversal ever
   yields `jfred/external` as an occurrence/repository; it does not exist
   as a node in the fixture and must never appear in any result set.
5. **Ownership** — `getOwningOccurrence` for a file path under
   `jfred/external/tmux_lib/...` returns the `jfred/external/tmux_lib`
   occurrence, not `jfred`.
6. **Path within repository** — `getPathWithinRepository` for that same
   file returns the path relative to `jfred/external/tmux_lib`'s root, not
   the full root-relative path.
7. **Deepest-first ordering** — ordering all four fixture occurrences
   yields the two depth-2 occurrences (`jfred/external/tmux_lib` and
   `jfred/jfredToolsPlugin`) before... actually per the given depths:
   `jfred` (depth 0), `jfred/external/tmux_lib` (depth 2 conceptually but
   directly parented at depth 1 relative edge), `jfred/jfredToolsPlugin`
   (depth 1), `jfred/jfredToolsPlugin/external/tmux_lib` (depth 2). Assert
   the deepest occurrence(s) sort first, `jfred` sorts last, and that ties
   at the same depth break by path within the immediate parent
   (deterministic, not insertion-order-dependent — verify by constructing
   the fixture in a shuffled insertion order and asserting the sort output
   is stable).

Use whatever test runner the repo's existing `tests/*.test.ts` files use
(check one sibling test file's imports during implementation, since this
plan may not read other files) — likely `bun:test` given the CLAUDE.md
preference for bun.

## Step 4 — Verify

- Run the new test file (e.g. `bun test tests/repositoryGraph.test.ts`).
- Confirm no other file was modified — this task is additive-only per the
  brief (`scripts/repositoryBranches.ts` and
  `scripts/mergeTaskWorktrees.ts` untouched).
- Confirm `scripts/repositoryGraph.ts` has zero occurrences of `dirname`,
  manual slash-splitting, or prefix-matching against raw path strings —
  grep for these as a self-check before calling the task done.

## Open items for the implementer

- Exact export names/types depend on `scripts/repositoryManifest.ts`'s real
  shape, unread by this planning pass — resolve in Step 0.
- Whether ancestor chain includes the occurrence itself is unspecified by
  the brief; pick one convention and document it with a one-line comment at
  the function.
