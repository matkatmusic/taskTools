# Task 15: Recursive occurrence tree delta against the recorded base

Phase 2 of the recursive repository-discovery redesign.

Create scripts/occurrenceTreeDelta.ts: derive one occurrence's changes relative to its recorded base, covering tracked and untracked additions, modifications, deletions, renames, mode changes (including the executable bit), and symlinks. Produce a content digest of the occurrence's own code tree suitable for equality comparison between occurrences.

The delta excludes .git, ignored and generated output, and the contents of nested submodules that are represented by their own occurrences — a nested occurrence's files are that occurrence's business, never ordinary files of the parent.

New module only; no production call sites yet.

Tests: each change kind (added, modified, deleted, renamed, mode-changed, symlink, untracked) appears in the delta with the right classification; files under a nested occurrence path are absent from the parent's delta; ignored and generated paths are absent; the digest is identical for two occurrences with identical trees and differs when a mode, symlink target, or byte differs.

### scripts/occurrenceTreeDelta.ts

(missing: file not found on disk)

### tests/occurrenceTreeDelta.test.ts

(missing: file not found on disk)
