# Task 11: Submodule URL identity resolution and normalization

Phase 2 of the recursive repository-discovery redesign.

Create scripts/submoduleUrlIdentity.ts: resolve each occurrence's upstream identity from its fully resolved .gitmodules URL. Relative URLs resolve against the immediate parent's origin. Equivalent SSH, HTTPS, and scp-style URLs normalize to one host/owner/repository identity (case, trailing .git, trailing slashes, and default ports included).

When URLs differ between occurrences of what looks like the same repository, or a URL is unavailable, emit a resolution request rather than guessing equivalence. Guessing is the failure mode this module exists to prevent.

New module only; no production call sites yet.

Tests: relative URLs such as ../tmux_lib.git resolve against the parent origin; git@host:owner/repo.git, ssh://git@host/owner/repo, and https://host/owner/repo.git all normalize to the same identity; a differing host or owner does not; a missing .gitmodules entry or missing origin produces a resolution request rather than a guess.

### scripts/submoduleUrlIdentity.ts

(missing: file not found on disk)

### tests/submoduleUrlIdentity.test.ts

(missing: file not found on disk)
