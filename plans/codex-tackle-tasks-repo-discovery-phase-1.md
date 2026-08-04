# Phase 1 — Unique Nested Repositories

## Summary

Replace the flat repository-path model with a recursive occurrence graph and make nested gitlink handling correct for repositories whose submodules live below ordinary directories. This phase supports one occurrence per logical repository. It establishes the graph and base-branch primitives required by later phases without enabling the new workflow in production yet.

## Implementation

- Introduce a versioned repository manifest with `RepositoryOccurrence` records containing:
  - Stable occurrence ID and root-relative checkout path.
  - Explicit parent occurrence ID and path within the immediate parent.
  - Recorded gitlink OID, depth, origin URL, base branch/OID, operation branch, children, and test state.
- Never infer repository parentage with filesystem `dirname`, path-segment removal, or slash counts. Traverse and sort using manifest edges and recorded depth. In particular, treat the parent of `jfred/jfredToolsPlugin/external/tmux_lib` as the `jfred/jfredToolsPlugin` repository occurrence, not a synthetic `jfred/jfredToolsPlugin/external` repository.
- Discover and set up repositories root outward:
  1. Record the root's checked-out branch and OID as its base.
  2. Read each direct gitlink from the parent commit and initialize that child at the recorded OID.
  3. Fetch branch refs and find branches whose tip exactly equals the recorded OID.
  4. Record the sole match as `baseBranch`; emit a resumable resolution request for zero or multiple matches.
  5. Create and check out the run-scoped operation branch at that OID.
  6. Recurse through that child's own direct submodules.
- Persist discovery questions and answers so setup resumes without repeating resolved choices or recreating completed worktrees.
- Add graph-based helpers for direct children, ancestors, deepest-first order, owning repository, and path-within-repository. Replace the corresponding flat-path helpers in owned-path and integration code.
- Add integration primitives that can substitute finalized child OIDs into the correct direct gitlinks and prepare a real `--no-ff` merge commit without moving a base ref. Phase 3 will compose these primitives across task groups.
- Mark old flat manifests as incompatible with the new finalizer. Preserve their worktrees and refs and return recovery instructions rather than converting them implicitly.
- Keep the new manifest path behind an explicit version/feature boundary. The existing production workflow remains the default until Phase 4 activates the complete design.

## Interfaces

- Discovery returns either a complete occurrence graph or `resolutionRequests` containing occurrence ID, recorded OID, candidate base branches, and reason.
- Resolution input maps each request ID to a selected branch and is stored in the run manifest.
- Graph APIs accept occurrence IDs, not inferred filesystem parents.
- Integration primitives return prepared commit OIDs or repository-qualified conflicts and never update branches.

## Tests and Acceptance

- Cover root-outward initialization and zero, one, and multiple exact branch-tip matches.
- Cover a submodule at `jfred/external/tmux_lib` whose immediate repository parent is `jfred`, plus a deeper submodule below `jfred/jfredToolsPlugin`.
- Assert no synthetic paths such as `jfred/external` are treated as Git repositories.
- Verify direct-child lookup, ancestor traversal, ownership, and deepest-first ordering from graph edges.
- Verify a child integration OID replaces only its declared gitlink in the immediate parent.
- Verify detached or unresolved repositories stop setup before worker worktrees are created.
- Verify legacy manifests are rejected without deleting worktrees or refs.
- Phase 1 is complete when a unique, deeply nested repository tree can be discovered, branched at recorded commits, and dry-run integrated using explicit parent edges.
