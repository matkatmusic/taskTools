# Task 14: Occurrence branch naming for unique and repeated repositories

Phase 2 of the recursive repository-discovery redesign.

Create scripts/occurrenceBranchNames.ts: a unique repository gets the plain group operation branch name. Each occurrence of a repeated logical repository gets a distinct name derived from its sanitized full root-relative path plus a collision hash, so two occurrences can never end up sharing a branch name.

Names must be valid git ref names, deterministic across runs, and stable for a given occurrence path. Sanitization must not be able to map two different paths to the same name without the hash disambiguating them.

New module only; no production call sites yet.

Tests: all three RevEng tmux_lib forms — tmux_lib, jfred/external/tmux_lib, and jfred/jfredToolsPlugin/external/tmux_lib — produce three distinct valid branch names; a unique repository gets the plain group branch name; names are byte-identical across repeated invocations; two paths that sanitize to the same string still differ by hash; every generated name passes git check-ref-format.

### scripts/occurrenceBranchNames.ts

(missing: file not found on disk)

### tests/occurrenceBranchNames.test.ts

(missing: file not found on disk)
