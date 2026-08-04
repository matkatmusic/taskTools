# Task 4: Occurrence-graph traversal helpers driven by explicit edges

Phase 1 of the recursive repository-discovery redesign.

Create scripts/repositoryGraph.ts with helpers that operate purely on the manifest edges from scripts/repositoryManifest.ts: direct children of an occurrence, the ancestor chain to the root, deepest-first ordering, the occurrence that owns a given root-relative path, and the path of a file within its owning repository.

Every helper must traverse recorded parent/child edges and recorded depth. None may use dirname(), path-segment removal, slash counting, or longest-prefix matching over raw path strings to infer structure. Ordering must be deterministic — deepest-first, then by path within the immediate parent.

New module only. The equivalent flat-path helpers in scripts/repositoryBranches.ts and scripts/mergeTaskWorktrees.ts stay in place; the Phase 4 cutover task swaps the call sites.

Tests: direct-child lookup, ancestor traversal, ownership, path-within-repository, and deepest-first ordering all verified against a fixture graph containing jfred, jfred/external/tmux_lib, jfred/jfredToolsPlugin, and jfred/jfredToolsPlugin/external/tmux_lib; assert the parent of jfred/external/tmux_lib is jfred and that no synthetic path such as jfred/external is ever returned as a repository.

### scripts/repositoryGraph.ts

(missing: file not found on disk)

### tests/repositoryGraph.test.ts

(missing: file not found on disk)
