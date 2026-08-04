# Task 8 Plan: Run-scoped operation branch creation at the recorded OID

Source: `plans/brief-8.md` (Phase 1 of the recursive repository-discovery redesign).

## Behavior, in plain English

For a batch of "occurrences" (one per repo involved in a run), create a git
branch in each occurrence's repo that points at the OID recorded for that
occurrence — not at whatever commit the repo happens to have checked out —
check that branch out, and write the branch's name back onto the occurrence.
Before touching any repo, refuse to proceed at all if any occurrence is in a
state that can't safely be branched from (detached HEAD, or no resolved base
branch), and say exactly which occurrence(s). Running the whole thing twice
with the same inputs must be a no-op the second time.

Nouns: occurrence, run ID, recorded OID, operation branch, base branch,
detached HEAD, setup abort. Verbs: validate, create, check out, record.

## Pre-implementation check (do this before writing any code)

This plan was written from the brief alone (per instruction, no other repo
file was read while planning). Before implementing:

1. Search the codebase for an existing `Occurrence` type (this is phase 1 of
   a larger redesign — earlier tasks in the same series likely already
   define it, with fields for the repo path, the recorded OID, and the
   resolved base branch). **Reuse that type; do not declare a competing one
   in this file.** Add only the new field this task needs
   (`operationBranch`), matching whatever naming convention the existing
   fields use.
2. Search `scripts/` for an existing git-exec helper (a wrapper around
   `git` invocations with a `cwd`). `mergeTaskWorktrees.ts` is referenced in
   recent git history and likely has one, or calls one. Reuse it. Only write
   a local `runGit(repoPath, args)` helper in `operationBranches.ts` if
   nothing suitable exists.
3. Confirm the test framework already in use under `tests/` (this repo
   favors `bun`; look for `bun:test` imports in existing test files) and
   match it exactly — do not introduce a different test runner.
4. If any of the above turns up field/helper names that conflict with the
   ones below, use the codebase's names, not this plan's placeholder names.
   The shape of the solution does not change, only the identifiers.

## Files

- `scripts/operationBranches.ts` — new module, no production call sites.
  Do not wire this into `tackle-tasks` or any workflow file in this task.
- `tests/operationBranches.test.ts` — new test file.

Both files are small; nothing here should approach the 250-line cap. If it
does, split validation logic out before the file grows past the cap, not
after.

## Public shape of `scripts/operationBranches.ts`

```ts
export interface Occurrence {
    path: string;              // absolute path to the repo checkout — verify name against real type
    recordedOid: string;       // commit OID captured at discovery time — verify name against real type
    baseBranch?: string;       // resolved base branch, or unresolved — verify name against real type
    operationBranch?: string;  // NEW: set by this module
}

export class OperationBranchSetupError extends Error {}
export class OperationBranchConflictError extends Error {}

export function setUpOperationBranches(
    occurrences: Occurrence[],
    runId: string,
): Occurrence[]
```

`setUpOperationBranches` returns a **new** array (occurrences with
`operationBranch` filled in); it does not mutate the input array's objects.
Pure-in/pure-out keeps it trivially testable without shared-state cleanup
between assertions.

### Internal steps, in order

1. `validateOccurrencesReadyForBranching(occurrences)` — for every
   occurrence, check (a) the repo is not on a detached HEAD
   (`git symbolic-ref -q HEAD` fails/empty when detached) and (b)
   `occurrence.baseBranch` is set. Collect **every** failing occurrence
   (don't stop at the first one — the brief says "names the offending
   occurrence *paths*", plural). If the list is non-empty, throw a single
   `OperationBranchSetupError` listing every offending path and its reason,
   e.g.:
   ```
   Cannot set up operation branches, 2 occurrence(s) not ready:
     - /repos/foo: detached HEAD
     - /repos/bar: baseBranch not resolved
   ```
   This must run to completion for the whole batch **before** step 2 touches
   any repo — that's what makes "no worktree created on any failure path"
   true: nothing downstream of this module ever runs if validation fails.
2. For each occurrence, in order:
   a. Compute `operationBranchName(runId, occurrence)` — see naming below.
   b. `ensureOperationBranchAtOid(occurrence.path, branchName, occurrence.recordedOid)`:
      - branch doesn't exist yet → `git branch <branchName> <recordedOid>`.
        `git branch` creates the ref at the given OID regardless of what's
        currently checked out — this is why the checked-out commit being
        "elsewhere" doesn't matter.
      - branch exists and already points at `recordedOid` → no-op (this is
        the re-run/idempotent case).
      - branch exists and points elsewhere → throw
        `OperationBranchConflictError` naming `occurrence.path`, the branch
        name, the expected OID, and the actual OID. Do **not** reset the
        branch — leave it exactly as found.
   c. `git checkout <branchName>` in `occurrence.path`.
3. Return the occurrences array with `operationBranch: branchName` set on
   each entry.

A conflict on one occurrence in step 2 aborts the loop (throws out of
`setUpOperationBranches`) but does not undo branches already created for
earlier occurrences in the same call — they're valid and idempotent, so a
resumed run picks up where it left off. This matches the brief's "a resumed
run is safe" requirement.

### Branch naming

```ts
function operationBranchName(runId: string, occurrence: Occurrence): string {
    const slug = occurrenceSlug(occurrence.path);
    return `tackle-op/${runId}/${slug}`;
}
```

`occurrenceSlug` — if the real `Occurrence` type (see pre-implementation
check) already carries an id/repoName/slug field, use it directly. Otherwise
derive one from `occurrence.path` by stripping the leading separator and
replacing remaining `/` with `-`, so two occurrences with the same basename
but different parent directories don't collide on branch name.

The `tackle-op/` prefix keeps these branches visually distinct from the
existing `task-group-N` branches seen elsewhere in this repo's history.

## Tests: `tests/operationBranches.test.ts`

Write and run these in the order below (matches the brief's Tests
paragraph, increasing in complexity — this is also the natural red/green
order). Each test creates its own temp git repo (via a local
`makeTempGitRepo()` helper, or a shared one if the pre-implementation search
finds it already exists elsewhere in `tests/`) so tests don't share state.

1. `test_branchCreatedAtRecordedOidEvenWhenCheckoutIsElsewhere`
   - Repo has commit A, then commit B; repo is currently checked out on
     `main` at B.
   - `occurrence = { path: repo, recordedOid: A, baseBranch: "main" }`.
   - Call `setUpOperationBranches([occurrence], "run1")`.
   - Assert: `git rev-parse <branchName>` in the repo equals A, not B.
   - Assert: the repo's current branch is `<branchName>` (checked out).
   - Assert: the returned occurrence's `operationBranch` equals `<branchName>`.

2. `test_reRunningIsANoOp`
   - Same setup as test 1; call `setUpOperationBranches` once.
   - Record the branch's OID and the full list of branches in the repo.
   - Call `setUpOperationBranches` again with the same occurrence and run ID.
   - Assert: no error thrown.
   - Assert: the branch still resolves to A and the branch list is
     unchanged (no duplicate branch was created).

3. `test_existingBranchAtDifferentOidErrors`
   - Repo has commits A and B.
   - Before calling the module, manually create a branch named exactly
     `operationBranchName("run1", occurrence)` pointing at B.
   - `occurrence.recordedOid = A`.
   - Call `setUpOperationBranches([occurrence], "run1")`.
   - Assert: it throws `OperationBranchConflictError` and the message
     contains `occurrence.path`, the branch name, and both OIDs.
   - Assert: the branch still points at B afterward (not silently reset).
   - Assert: no worker-worktree directory was created (see helper below).

4. `test_detachedHeadOccurrenceAbortsSetupAndNamesIt`
   - Repo checked out on a raw commit (`git checkout <oid>`, detached HEAD).
   - `occurrence.baseBranch = "main"` (resolved — only HEAD is the problem).
   - Call `setUpOperationBranches([occurrence], "run1")`.
   - Assert: it throws `OperationBranchSetupError` whose message contains
     `occurrence.path`.
   - Assert: no branch named `operationBranchName(...)` exists in the repo
     afterward (setup aborted before step 2 ran at all).
   - Assert: no worker-worktree directory was created.

5. `test_occurrenceWithNoResolvedBaseBranchAbortsSetup`
   - Repo checked out normally on `main` (not detached).
   - `occurrence.baseBranch = undefined`.
   - Call `setUpOperationBranches([occurrence], "run1")`.
   - Assert: it throws `OperationBranchSetupError` whose message contains
     `occurrence.path`.
   - Assert: no branch was created.
   - Assert: no worker-worktree directory was created.

### "No worker worktree directory created" helper

This module never creates worktrees — that happens in a later phase not
built here. The assertion is a regression guard against that boundary
leaking: pick a path a future worktree step would plausibly use (e.g.
`path.join(tmpWorkspaceRoot, "worktrees", occurrenceSlug)`) and assert
`fs.existsSync(thatPath) === false` both before and after the aborting
call. It's expected to be trivially true today; it exists so that if
someone later folds worktree creation into this same call path, one of
these three tests catches it.

## Explicitly out of scope for this task

- Wiring `setUpOperationBranches` into any workflow/orchestrator file.
- Actual worker-worktree creation.
- Multi-occurrence-failure message formatting gets exercised implicitly by
  the single-occurrence tests above (the collection logic is the same code
  path); no separate test for "two occurrences fail at once" is needed
  unless a bug surfaces there later — don't add one speculatively.
