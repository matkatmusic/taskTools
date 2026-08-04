# Task 2: Versioned repository manifest with RepositoryOccurrence records

Phase 1 of the recursive repository-discovery redesign.

Create scripts/repositoryManifest.ts: a versioned run manifest that replaces the flat repository-path model with an occurrence graph. Define a RepositoryOccurrence record holding a stable occurrence ID, the root-relative checkout path, the explicit parent occurrence ID, the path within the immediate parent, the recorded gitlink OID, depth, origin URL, base branch and base OID, the operation branch name, child occurrence IDs, and test state. Add a manifest version constant, read/write helpers, and a validator.

Parentage is always an explicit edge. Nothing in this module may derive a parent with dirname(), path-segment removal, or slash counting.

New module only: do not wire it into scripts/prepareTasks.ts, scripts/mergeTaskWorktrees.ts, or skills/tackle-tasks/tackle-tasks.workflow.js. Production stays on the existing flat path until the Phase 4 cutover task.

Tests: round-trip serialization preserves every field; the validator rejects dangling parent IDs, duplicate occurrence IDs, and depth values inconsistent with the parent chain; a manifest describing jfred/jfredToolsPlugin/external/tmux_lib records its parent as the jfred/jfredToolsPlugin occurrence, never a synthetic jfred/jfredToolsPlugin/external entry.

### scripts/repositoryManifest.ts

(missing: file not found on disk)

### tests/repositoryManifest.test.ts

(missing: file not found on disk)
