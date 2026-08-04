# Task 32 Plan: Canonical-only operation branch push with ancestor check and no force

Phase 4 of the recursive repository-discovery redesign. Creates
`scripts/operationPush.ts` (+ `tests/operationPush.test.ts`). Neither file
exists yet.

## What this script does (from brief-32.md)
After the whole-run approval gate (task 31) passes:
- For each **repeated** logical repository (same logical repo discovered at
  multiple filesystem occurrences), push only the **canonical** occurrence's
  run-level operation branch to its remote. Never pass `--force`.
- If the remote already has a tip for that branch, it must be an ancestor of
  the OID being pushed. If it is not, abort **before** doing the push (no
  push attempt, no side effect) and before any base-branch publication step
  a caller might run afterward.
- After a successful push, `fetch` the canonical branch into every other
  occurrence of that same logical repository and verify each occurrence is
  already at the same OID and the same tree (verification only — never
  merge/reset/write into the other occurrences).
- **Unique** logical repositories (one occurrence) are never pushed.
- **No base branch is ever pushed** by this script, under any code path.

## This planning agent's constraints
I was instructed to read only `plans/brief-32.md` plus the standard
guide files (`planning.md`, `tdd.md`, `coding-standards.md`, all under
`~/.claude/guides/`). I have **not** read any file in `scripts/` or
`tests/`, including the earlier phases of this redesign or the task 31
approval gate. Everything below about the shapes of existing types/helpers
is therefore a **named assumption**, not a confirmed fact. Step 0 exists
specifically to replace those assumptions with real answers before any code
is written — do not skip it.

## Step 0 — Locate and reuse existing modules (do this first, before RED)
Grep `scripts/` and `tests/` for the following and read what you find. Do
not re-derive or re-implement any of these — reuse the real exported
symbols and adjust the plan's sketched signatures below to match them.

1. **Approval gate (task 31)** — likely `scripts/runAuthorization.ts`
   paired with `tests/runAuthorization.test.ts` (both appear in the
   current git status/log for task 31: "add whole-run approval gate with
   state digest and drift invalidation"). Find whatever function/type
   answers "is this run approved right now" (it may also re-validate a
   state digest / detect drift). This is what task 32's "after approval"
   and "before approval fails" requirements hook into.
2. **Recursive repository discovery (phases 1-3)** — grep for
   `logicalRepositor`, `occurrence`, `canonical`, `operationBranch` across
   `scripts/*.ts`. Find the type that represents a discovered run: it
   should already distinguish unique vs. repeated logical repositories,
   list each one's occurrences (filesystem path + remote), and mark which
   occurrence is canonical. Task 32 must consume this type, not invent a
   parallel one.
3. **Existing git-shell helpers** — grep for `execFileSync`, `execFile`,
   or a `git(...)` wrapper already used by other `scripts/*.ts` files. If
   one exists, reuse it for running git subprocess commands. If none
   exists, write the minimal local wrapper described below (rung 3 of the
   ladder: stdlib `node:child_process`, no new dependency).
4. **Test harness conventions** — open `tests/runAuthorization.test.ts` (or
   any other `tests/*.test.ts`) to see the test runner in use (bun test /
   vitest / other) and how other tests spin up a real tmp git repo. Match
   that convention exactly instead of introducing a second style.

If step 0 turns up materially different shapes than assumed below, adjust
the rest of this plan's naming to match reality — the behavior and test
list are the contract, the exact type names are not.

## Design (ponytail ladder applied)
- No mocking library, no dependency injection framework: git operations
  run against real tmp repos in tests (matches the TDD guide's own
  example style — real `git` subprocess calls, not stubs).
- One small pure function builds the push argv (`["push", remote, refspec]`
  — never includes `-f`/`--force`). Testing that pure function directly is
  what proves "no push uses force under any path," instead of spying on
  child_process across every code path.
- Sequential loop over logical repositories — no speculative concurrency.
- Verification step is read-only: fetch + compare OID/tree. It must never
  write to the non-canonical occurrences.

## Module: `scripts/operationPush.ts`

Entry point (adjust name/param types to match Step 0's real discovery
type):

```ts
export async function pushOperationBranches(runState: RunState): Promise<PushResult[]>
```

Error types (thrown, not returned, so a caller sequencing base-branch
publication after this call never reaches it on failure):
- `RunNotApprovedError` — runState fails the task-31 approval check.
- `NonAncestorRemoteTipError` — remote tip exists and is not an ancestor of
  the local OID being pushed.
- `OccurrenceVerificationMismatchError` — after push, some other occurrence's
  fetched OID or tree does not match the canonical one.

Control flow:
1. Call the task-31 approval check against `runState` first, before
   touching any repository. If not approved, throw `RunNotApprovedError`
   immediately — no git commands run.
2. For each logical repository in `runState`:
   - If it has exactly one occurrence (unique) → skip, record a
     `skipped-unique` result, do nothing else.
   - Otherwise (repeated):
     a. Resolve the canonical occurrence and its local operation-branch OID
        (`git rev-parse <operationBranch>` in the canonical occurrence's
        path).
     b. Resolve the remote tip for that branch name, if any
        (`git ls-remote <remote> <operationBranch>`).
     c. If a remote tip exists, run
        `git merge-base --is-ancestor <remoteTip> <localOid>` in the
        canonical occurrence. Non-zero exit → throw
        `NonAncestorRemoteTipError` before step (d) — nothing is pushed.
     d. Push: `git push <remote> <localOid>:refs/heads/<operationBranch>`
        (no `-f`/`--force`, ever — built via the shared pure argv builder).
     e. For every other occurrence of this same logical repository:
        `git fetch <remote> <operationBranch>` in that occurrence's path,
        then read the fetched OID and its tree
        (`git rev-parse FETCH_HEAD` / `git rev-parse FETCH_HEAD^{tree}`),
        and compare both against the canonical OID/tree. Mismatch → throw
        `OccurrenceVerificationMismatchError`. This step never runs `git
        merge`, `git reset`, or any ref update in the other occurrence.
     f. Record a `pushed` result with the OID.
3. This module never constructs or runs a push command for any base
   branch — there is no code path that accepts a base-branch ref as input,
   so this is a structural guarantee rather than something to unit-test
   per call site.

## `tests/operationPush.test.ts` — TDD plan

Write all six as failing tests first (RED), matching the runner/style
found in Step 0, using the naming convention `test_<behavior>`. Each test
builds real tmp git repos (a bare repo standing in for "remote", plus one
working-copy repo per occurrence) rather than mocking git.

1. `test_uniqueRepositoryOperationBranchIsNotPushed`
   Setup: one occurrence, no repeated occurrences, approved run. Assert
   the bare remote has no ref for the operation branch after the call, and
   the result marks it `skipped-unique`.

2. `test_repeatedRepositoryPushesOnlyCanonicalBranch`
   Setup: two occurrences of the same logical repository sharing one bare
   remote, both already holding the same operation-branch commit locally
   (as earlier phases would have produced), no remote tip yet. Approved
   run. Assert the bare remote now has the operation branch ref at the
   canonical OID, and that no push attempt was made from the non-canonical
   occurrence path (e.g. point it at a remote name/URL that would error if
   git tried to push there, or assert the bare remote's ref count changed
   by exactly one push).

3. `test_nonAncestorRemoteTipAbortsBeforePublication`
   Setup: bare remote's operation-branch ref pre-set to a commit that
   diverges from (is not an ancestor of) the canonical occurrence's local
   OID. Approved run. Assert the call throws `NonAncestorRemoteTipError`,
   and assert the bare remote's ref is unchanged afterward (proves no push
   was attempted).

4. `test_noPushUsesForceUnderAnyPath`
   Unit-test the pure push-argv-builder function directly (not the full
   flow): assert its output array never contains `-f` or `--force` for
   representative inputs. This is the single call site that ever invokes
   `git push`, so this covers every path per the Design note above.

5. `test_afterPushEveryOtherOccurrenceVerifiesSameOidAndTree`
   Setup: same as test 2. After the call succeeds, assert the fetched OID
   and tree hash in the non-canonical occurrence equal the canonical
   occurrence's OID and tree hash (read via `git rev-parse` in that
   occurrence's path after the function has run).

6. `test_pushAttemptedBeforeApprovalFails`
   Setup: runState whose task-31 approval check reports not-approved (or
   drift-invalidated, per whatever Step 0 finds that API to be). Assert
   the call throws `RunNotApprovedError`, and assert zero git subprocess
   calls happened (bare remote completely untouched — easiest to check by
   asserting its ref list is empty/unchanged from setup).

Then implement the minimum code in `scripts/operationPush.ts` to turn each
RED test GREEN, one at a time, in the order listed (6 → gate first, since
every other test depends on the approval check passing; then 1 → 2 → 4 →
3 → 5 is a reasonable build order since it grows the flow incrementally:
skip path, then happy push path, then the argv unit test, then the
ancestor-abort path, then the post-push verification path).

## Open items for the implementing agent to resolve during Step 0
- Exact type/field names for logical repository, occurrence, canonical
  marker, and operation-branch name — currently placeholders in this plan.
- Exact shape/name of the task-31 approval check and what "not approved"
  looks like (boolean, thrown error, discriminated union) — mirror it
  rather than wrapping it in a new abstraction.
- Test runner in use (bun test vs. vitest vs. other) and its tmp-repo
  setup helpers, if any already exist in `tests/` — reuse instead of
  duplicating a bare-repo/occurrence-repo builder if one is already
  factored out.
