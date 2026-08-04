# Task 5: Direct gitlink reader for a parent commit

Phase 1 of the recursive repository-discovery redesign.

Create scripts/gitlinkReader.ts: read every direct gitlink entry from a given repository's commit — the path within that repository and the recorded child OID — using git plumbing (ls-tree of mode 160000 entries) rather than `git submodule foreach`.

Only direct gitlinks of that one repository are returned. A gitlink whose path spans several segments, such as external/tmux_lib, is one direct child of that repository; the intermediate directory is an ordinary tree and must never appear as a repository. The reader must not recurse on its own — recursion is the discovery orchestrator's job.

New module only; no production call sites yet.

Tests: a fixture repo with a gitlink at a single-segment path and one at a multi-segment path returns exactly two direct children with correct OIDs; a repo with no gitlinks returns an empty list; assert intermediate directories are absent from the result; assert a grandchild gitlink inside a child repository is not returned when reading the parent.

### scripts/gitlinkReader.ts

(missing: file not found on disk)

### tests/gitlinkReader.test.ts

(missing: file not found on disk)
