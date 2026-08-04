# Task 9: Root-outward recursive repository discovery orchestrator

Phase 1 of the recursive repository-discovery redesign.

Create scripts/repositoryDiscovery.ts, composing scripts/gitlinkReader.ts, scripts/baseBranchResolution.ts, scripts/resolutionRequests.ts, scripts/operationBranches.ts, and scripts/repositoryGraph.ts into the root-outward setup sequence: record the root's checked-out branch and OID as its base; read each direct gitlink from the parent commit and initialize that child at the recorded OID; fetch branch refs and find branches whose tip exactly equals that OID; record a sole match as baseBranch or emit a resolution request for zero or multiple matches; create and check out the run-scoped operation branch at that OID; then recurse through that child's own direct submodules.

Discovery returns either a complete occurrence graph or a list of resolutionRequests — never a partially-guessed graph. Discovery must be resumable from a persisted manifest without repeating resolved choices or recreating completed worktrees.

New module only; production stays on the flat path until the Phase 4 cutover task.

Tests: a three-level fixture (root, child, grandchild) discovers every occurrence with correct parent edges and depths; a submodule at jfred/external/tmux_lib is recorded with parent jfred; a submodule below jfred/jfredToolsPlugin is recorded with that repository as parent; no synthetic path such as jfred/external appears as a repository; unresolved or detached repositories stop discovery before worker worktrees exist; a resumed run re-uses persisted answers. Phase 1 acceptance: a unique, deeply nested tree can be discovered, branched at recorded commits, and dry-run integrated using explicit parent edges.

### scripts/repositoryDiscovery.ts

(missing: file not found on disk)

### tests/repositoryDiscovery.test.ts

(missing: file not found on disk)
