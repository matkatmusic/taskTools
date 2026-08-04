# Phase 2 — Repeated Logical Repositories

## Summary

Overlay logical-repository identity on the Phase 1 occurrence graph and support an arbitrary number of checkout paths for the same upstream repository. Add N-way code convergence and testing across every occurrence and every distinct affected parent chain. Do not push or update base branches in this phase.

## Implementation

- Add `LogicalRepository` records containing normalized upstream identity, all occurrence IDs, selected base, canonical occurrence, last-writer occurrence, convergence digest, and consolidation state. Keep the occurrence tree intact; logical equivalence must not collapse distinct parent chains.
- Resolve identity from fully resolved `.gitmodules` URLs:
  - Resolve relative URLs against the immediate parent's origin.
  - Normalize equivalent SSH, HTTPS, and scp-style URLs to one host/owner/repository identity.
  - Emit a resolution request when URLs differ or are unavailable rather than guessing equivalence.
- Support any number of occurrences. If members of one logical repository start at different recorded OIDs or base branches, require a persisted reconciliation choice before editing.
- Give unique repositories the group operation branch name. Give repeated occurrences distinct names using a sanitized full root-relative path plus a collision hash. Include all three RevEng forms: direct `tmux_lib`, `jfred/external/tmux_lib`, and `jfred/jfredToolsPlugin/external/tmux_lib`.
- Implement deterministic N-way file synchronization:
  - Derive tracked and untracked additions, modifications, deletions, renames, modes, and symlinks relative to the recorded base.
  - Fan each accepted change from its latest writer to every other occurrence.
  - Exclude `.git`, ignored/generated output, and nested submodule contents represented by separate occurrences.
  - Repeat until every occurrence has the same code-tree digest.
- Copy the Jot related-test hook into taskTools and enable its entry point without modifying Jot.
- Extend the copied hook to resolve each edited file's nearest Git root and batch related tests by owning occurrence.
- Add an explicit test policy to each occurrence: related-test mapping for ordinary edits and a complete suite command for parent validation. Discover unambiguous commands from repository configuration; otherwise emit a setup resolution request.
- Add a sync-receipt mode containing logical repository ID, source and destination occurrences, changed paths, expected branches, content digests, and each occurrence's parent chain.
- For every synchronization receipt:
  - Verify branches and byte/mode/symlink/deletion equivalence.
  - Run related tests in every occurrence.
  - Run the configured complete suite in every distinct affected parent while walking to the root.
  - Fail on missing tests, mismatched trees, branch drift, or test failures.
  - Persist a green receipt tied to the converged digest.
- Record `lastWriterOccurrence`. Deduplicate identical repository/test/digest executions, but never skip different parents merely because they contain the same logical child.
- Keep this capability behind the version boundary established in Phase 1; no remote push, semantic finalization, base mutation, or task archival is added here.

## Interfaces

- Logical identity resolution accepts explicit user answers for missing/different URLs and base reconciliation.
- Synchronization accepts one source occurrence and an N-member logical-repository set and returns changed paths plus a convergence receipt.
- Hook sync receipts are machine-readable and include per-occurrence and per-parent test results.
- The run manifest stores logical equivalence classes, branch names, reconciliation decisions, test policies, last writer, and final convergence digests.

## Tests and Acceptance

- Test relative/absolute URL resolution and SSH/HTTPS/scp normalization.
- Test two-, three-, and larger occurrence sets without pairwise assumptions.
- Test added, modified, deleted, renamed, executable, symlink, and untracked files.
- Verify nested submodule contents and generated output are never copied as ordinary files.
- Verify a fix originating in any of three `tmux_lib` copies fans out to the other two.
- Verify related tests run in all copies and complete suites run through every distinct parent chain.
- Add two-copy fixtures for `claude_plugin_lib` and `scenarios`.
- Verify differing URLs, recorded OIDs, or bases block editing until resolved.
- Phase 2 is complete when all repeated repositories in a RevEng-shaped graph converge to identical tested trees while retaining distinct occurrence branches and parentage.
