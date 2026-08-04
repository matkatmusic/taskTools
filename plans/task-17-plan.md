# Task 17 Plan: Copy the Jot related-test hook into taskTools, batched by owning occurrence

Source brief: `plans/brief-17.md` (Phase 2 of the recursive repository-discovery redesign).

## Scope guard (from the brief, verbatim intent)

- Copy Jot's related-test hook into `scripts/relatedTests.ts` (entry point included). Jot's own source tree must not change — verify this, don't just avoid it.
- Extend the copy so file→test mapping is grouped **per owning Git occurrence**, resolved via the occurrence graph (task 14/18 modules), not via path-prefix string matching.
- Do **not** touch `hooks/hooks.json`. Registration is explicitly Phase 4's job — this task only delivers the module + entry point.

This plan does not include codebase exploration results (the planning pass for this task was scoped to the brief only, per the orchestrator's instruction). Step 0 below is discovery the implementing agent must do first; it is intentionally left as a search, not a hardcoded path, so a stale guess doesn't get baked into the plan.

## Step 0 — Locate the two things this task reuses (discovery, no edits)

1. Find Jot's related-test hook source. It's a sibling project/plugin, not inside `taskTools`. Search candidates:
   - `fd -HI -e ts -e js 'related.?test' ~/Programming ~/.claude/plugins/cache`
   - `rg -il 'related.test' ~/Programming/jot 2>/dev/null` (if a sibling `jot` repo exists at that path; adjust if not)
   Confirm you've found the actual hook implementation *and* its entry point (the file/block that wires it up as a runnable command) — the brief asks for both.

2. Find the occurrence-graph modules already built in this repo:
   - `git show 7665d32 --stat` — task 14, `occurrenceBranchNames` module (per-occurrence deterministic naming; check whether it exposes or sits next to nearest-git-root resolution).
   - `git show b07157f --stat` — task 18, per-occurrence test policy discovery (`related-test`/`complete-suite` commands).
   - Cross-check with `rg -l occurrenceBranchNames src` and `rg -l 'related-test|complete-suite' src` in case either moved since those commits.
   - Check for an existing three-level nested-git test fixture from that phase 1/task 14/18 work (`rg -l 'git init' tests`) before building a new one — the brief phrases "a three-level fixture" like it may already exist to be reused.

Do not proceed to Step 1 until you can name the exact file paths for: the Jot hook, the occurrence-root resolver, and the existing related-test/complete-suite discovery entry points. If the occurrence graph module's API doesn't cleanly support "resolve owning occurrence for an arbitrary file path," that's a blocker to raise, not a gap to paper over with path-prefix heuristics — the brief explicitly forbids that fallback.

## Step 1 — Tests first: `tests/relatedTests.test.ts`

Write this before touching `scripts/relatedTests.ts`, and confirm it fails for the right reason (module doesn't exist yet).

Reuse whatever fixture-building helper task 14/18's own tests already use for nested-git fixtures (found in Step 0) rather than writing a new one. If none exists, the minimal version is: a temp dir with three nested levels, each level `git init`-ed independently (root repo containing an "occurrence A" subdir that is itself a git repo, containing an "occurrence B" subdir that is itself a git repo). Keep the fixture minimal — only what's needed to exercise three ownership levels and multi-occurrence batching; don't build a general-purpose fixture library beyond what these four cases require.

Required cases (each maps 1:1 to a brief bullet — don't merge or add extra ones):

1. **Nearest-occurrence mapping** — an edited file inside occurrence B resolves to occurrence B's root, not A's or the root repo's. Assert via the occurrence resolver's own return value, not a re-derived path comparison.
2. **Per-occurrence batching** — an edit set with files from both occurrence A and occurrence B produces two distinct batches keyed by occurrence root, each containing only its own files. Assert the batch count and that no batch mixes files from more than one occurrence (this is the exact case a path-prefix approach gets wrong, so make it fail loudly if batches get merged).
3. **Root-repo file** — a file edited directly in the root repo (no nested occurrence involved) maps to the root as its owning occurrence.
4. **Jot untouched** — before running the suite, record the Jot hook's file path(s) (from Step 0) via content hash or `git status --porcelain <jotRepoPath>`; after the suite runs, assert it's unchanged. This is a repo-hygiene assertion, not a unit test of logic — one small check at the end of the file, not a snapshot suite.

## Step 2 — Implement `scripts/relatedTests.ts`

1. Copy the Jot hook's file content into `scripts/relatedTests.ts` verbatim as the starting point, including its entry point block (preserve whatever CLI/stdin contract it used for the edited-file list, so this is a drop-in once Phase 4 wires it up). Do not refactor Jot's logic while copying — refactor only what step 3 requires you to add.
2. Fix only what breaks from the copy: Jot-local imports won't resolve from `taskTools`. Re-point them to taskTools equivalents where one already exists (e.g. the test-policy discovery module from task 18), and inline anything with no taskTools equivalent. Don't introduce a new shared package for a one-time copy — the brief's "without modifying Jot itself" means two independent copies is the intended end state, not a refactor into a common library.
3. Add the ownership layer on top of the copied hook:
   - For each edited file, call the occurrence resolver (Step 0) to get its nearest owning Git root. Do not write a new path-prefix matcher — that's the exact mistake the brief calls out ("Ownership resolution uses the occurrence graph, not path prefixes").
   - Group files into `Map<occurrenceRoot, string[]>`.
   - For each occurrence group, invoke the existing test-policy discovery module (task 18) scoped to that occurrence root, producing one related-test batch per occurrence — not one merged run across all edited files.
4. Leave `hooks/hooks.json` untouched. No registration code, no config plumbing for it — that's Phase 4.

## Step 3 — Verify

- Run the new test file; all four cases green.
- `git status --porcelain` on the Jot source tree (path found in Step 0) is empty.
- `git status` on `taskTools` shows changes only in `scripts/relatedTests.ts` and `tests/relatedTests.test.ts` — nothing in `hooks/hooks.json` or elsewhere.

## Explicitly out of scope (don't do these here)

- Registering the hook in `hooks/hooks.json` — Phase 4.
- Modifying Jot in any way, including "just fixing" something noticed while copying.
- A shared/imported module between Jot's hook and this copy — the brief calls for a copy, not a shared package.
- Path-prefix-based ownership resolution as a fallback — the occurrence graph is the only resolution mechanism per the brief.

## Open questions for implementation time

- Exact location/name of Jot's related-test hook and entry point (search at implementation time; not identified during this planning pass since only the brief was read).
- Exact API surface of the task 14/18 occurrence-graph modules for owner resolution — confirm before writing the batching logic against it.
