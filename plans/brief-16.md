# Task 16: Deterministic N-way synchronization across occurrences

Phase 2 of the recursive repository-discovery redesign.

Create scripts/occurrenceSync.ts: fan each accepted change from its latest writer occurrence to every other occurrence of the same logical repository, repeating until every occurrence reports the same code-tree digest from scripts/occurrenceTreeDelta.ts. Accept one source occurrence and an N-member set; return the changed paths and a convergence result.

No pairwise assumptions anywhere — the algorithm must handle two, three, and larger sets identically, and its result must not depend on iteration order. All change kinds from the delta module apply, including deletions, renames, modes, and symlinks. Nested submodule contents and generated output are never copied as ordinary files.

New module only; no production call sites yet.

Tests: a fix originating in any one of three tmux_lib copies fans out to the other two and all three digests converge; two-copy fixtures for claude_plugin_lib and scenarios converge; deletions, renames, mode changes, symlinks, and untracked additions all propagate; a nested submodule's files are never copied into a sibling occurrence; running the sync twice is a no-op.

### scripts/occurrenceSync.ts

(missing: file not found on disk)

### tests/occurrenceSync.test.ts

(missing: file not found on disk)
