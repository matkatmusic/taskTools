# Adversarial review: `cut-task-worktrees-from-staging.md`

## Verdict

**AMEND before implementation.** The intended invariant is correct: a reusable task worktree must be judged against, and reset to, the local `staging` branch rather than the branch checked out in the launching checkout. The plan is not yet safe or testable as written, however.

The required change is small, but the current plan has six failure-prevention gaps:

1. Its Step 2 “RED” test is already green on the current implementation.
2. Its Step 1 test initially fails in the retained-work guard, so it does not isolate the reset behavior it claims to test.
3. Changing `worktreeHoldsRetainedWork` affects `recoverStaleTaskWorktreeLease` too, but the plan initializes `staging` only in `createWorktreeForGroup` and adds no recovery-path test.
4. The force reset checks the checked-out `HEAD` but not the `task-N` ref that `checkout -B` is about to overwrite. That can discard a retained task commit.
5. Both proposed test commands can report a false green or hide a crashed test runner because they pipe the authoritative run through `rg` without preserving the runner's exit status.
6. The same unchecked `-B` reset exists when the worktree folder is absent and in every populated submodule; the plan audits neither case.

Do not execute the original steps unchanged.

## Verified baseline

This review checked the current source at:

- `scripts/prepareTasks.ts:175-187`, `worktreeHoldsRetainedWork`
- `scripts/prepareTasks.ts:278-288`, `recoverStaleTaskWorktreeLease`
- `scripts/prepareTasks.ts:298-347`, `createWorktreeForGroup`
- `scripts/prepareTasks.ts:388-440`, `buildWorkflowArguments`
- `scripts/prepareTasks.ts:460-505`, `runAsCli`
- `tests/prepareTasks.test.ts:102-289`

The targeted baseline is green: 47/47 tests in `tests/prepareTasks.test.ts` pass.

The full baseline also matches the plan's inventory exactly: 2,532 tests, 2,527 passing and five failing. The five failures are the three `tests/runMergePhase.test.ts` cases, the one `tests/taskWorkflowMergeStage.test.ts` case, and the one `tests/checkBlockers.test.ts` case named in the plan. This baseline was established with unfiltered `npm test`, not inferred from `rg` output.

## Blocking amendment 1: replace the RED tests with independent fixtures

### Why the proposed Step 2 test is not RED

The proposed fixture starts the old worktree at the common base, then advances both `staging` and the launching branch on divergent children. The current implementation compares the old worktree tip to the launching branch and asks whether the former is an ancestor of the latter. It is. Therefore the current code returns “no retained work,” `createWorktreeForGroup` does not throw, and the proposed `assert.doesNotThrow` passes before any production edit.

That means the expected “exactly two failures” after Step 2 is false; there will still be only one new failure.

### Why the proposed Step 1 test conflates two behaviors

In Step 1, the old worktree is at the `staging` commit while the launching branch later diverges. Current code rejects that worktree as retained before it reaches the checkout/reset line. The test eventually covers the reset after Step 4 changes the guard, but its initial red result does not prove that the reset source is wrong.

### Required replacement matrix

Add three tests before changing production code. Give each one a fixture that makes only its named defect observable.

#### A. Missing `staging` is created on reuse

1. Create a repo and call `createWorktreeForGroup` once.
2. Release the lease.
3. Delete `refs/heads/staging` while the root checkout remains on its original branch.
4. Reuse the existing worktree.
5. Assert that `refs/heads/staging` now exists at the original `HEAD` and that the reused worktree is at that exact OID.

This is RED today because the existing-folder path never creates `staging`.

Suggested name: `test_createWorktreeForGroupCreatesMissingStagingBeforeReusingAWorktree`.

#### B. The retained-work decision uses `staging`, not the launching branch

1. Create divergent commits `S` on `staging` and `O` on the original branch.
2. Create the first task worktree **after `S` exists**, so its old `HEAD` is `S`.
3. Release the lease and leave the launching checkout at `O`.
4. Assert that a second call does not throw.

This is RED today because `S` is not an ancestor of `O`; it becomes green as soon as the retained-work comparison uses the `staging` tip. Do not use the final `HEAD` assertion as the sole assertion in this test; reset-source behavior belongs to test C.

Suggested name: `test_createWorktreeForGroupDoesNotCallTheStagingTipRetainedWhenTheLauncherDiverged`.

#### C. A reusable worktree is reset to `staging`, not the launching branch

1. Create the first task worktree at the common base `B` and release its lease.
2. Advance `staging` to `S` and the original branch to divergent commit `O`.
3. Reuse the task worktree.
4. Assert that its `HEAD` equals `S`, includes the staging-only file, and excludes the original-only file.

This is RED today for the reset line specifically: `B` is an ancestor of `O`, so the old guard permits reuse, then the old checkout resets to `O`.

Suggested name: `test_createWorktreeForGroupResetsAReusableWorktreeToTheStagingTip`.

Run each new test by name while establishing RED. Do not rely on a total failure count to infer which behavior failed.

## Blocking amendment 2: use one exact local-branch ref and one resolved OID

The plan uses the ambiguous revision string `staging` in verification, ancestry checks, `worktree add`, and `checkout -B`. Git permits a branch and tag with the same short name. If `refs/tags/staging` exists, short-name resolution can select or warn about the wrong object. A file/path named `staging` can make diagnostics still less clear.

Use the fully qualified local branch ref everywhere:

```ts
const STAGING_REF = "refs/heads/staging";
```

Verify/resolve `refs/heads/staging^{commit}`, not bare `staging`. After ensuring the branch exists, resolve its OID once and pass that OID to both:

- the retained-work ancestry decision; and
- the `worktree add` or `checkout --force -B` command.

This prevents a ref move between the safety decision and the destructive reset from making those two operations reason about different commits. Resolve it after acquiring the worktree lease, as close to the safety decision/reset as practical.

Add a regression test with `refs/heads/staging` and `refs/tags/staging` at different commits. Both fresh creation and reuse must select the branch commit.

## Blocking amendment 3: inspect every ref that any `-B` operation can discard

The current and proposed safety check examines:

- dirty state in the existing worktree; and
- the commit at the worktree's checked-out `HEAD`.

It does **not** examine `refs/heads/task-N`, even though this command force-resets that exact ref:

```sh
git -C <worktree> checkout --force -B task-N <staging-tip>
```

A real failure shape is:

1. `task-N` contains an unmerged retained commit.
2. The old worktree was switched to another clean branch or detached at a safe commit.
3. Its current `HEAD` is an ancestor of `staging`, so the proposed guard says “no retained work.”
4. `checkout -B task-N ...` rewrites `task-N` and removes the only ordinary ref to the retained commit.

Revise the retained-work helper to receive `branchName` and the resolved staging OID. If `refs/heads/<branchName>` exists and is not an ancestor of the staging OID, report retained work even when the worktree's current `HEAD` is safe. Continue checking the current `HEAD` as well when it differs from that branch tip.

Add a regression test that creates a retained commit on `task-1`, switches the worktree away from `task-1` to a clean safe commit, releases the lease, and then calls `createWorktreeForGroup`. The call must throw, and the test must assert that both the `task-1` ref OID and retained file/commit remain reachable unchanged.

Do not limit this preflight to an existing worktree folder. The fresh path also runs `git worktree add -B task-N ...`. A removed worktree can leave `refs/heads/task-N` behind, so “folder absent” does not mean “task branch contains no retained work.” Add a test that removes the old linked worktree while deliberately keeping its unmerged `task-N` branch, then calls the fresh path. It must refuse without changing the branch OID.

Finally, `createBranchInEveryRepository` runs `checkout -B task-N` in every populated submodule. A root-level check cannot see a retained submodule `task-N` ref when that ref is not currently checked out. Preflight the exact branch ref in every repository that will be reset, comparing it with that repository's desired base OID. Add a local-submodule regression test in which the submodule's hidden `task-N` branch has an unmerged commit while its checkout is clean at the recorded gitlink. Creation/reuse must refuse and preserve the submodule branch OID.

The safety rule is therefore general: **before any `-B` operation, prove that the exact branch ref being rewritten is absent, equal to the desired base, or an ancestor of the desired base.** A non-ancestor is retained work. Do not reset one repository and only later discover that another repository's task branch is unsafe if the preflight can be performed without mutation.

Also make the dirty-tree query explicit rather than configuration-dependent:

```sh
git status --porcelain=v1 --untracked-files=all --ignore-submodules=none
```

Add at least one uncommitted/untracked retained-work test. The existing test covers only a committed task-branch change.

## Blocking amendment 4: update the recovery caller deliberately

`worktreeHoldsRetainedWork` has two callers, not one:

- `createWorktreeForGroup`
- `recoverStaleTaskWorktreeLease`

After the helper changes from “launching branch” to “staging,” recovery also needs an exact staging OID and the expected task branch name. The original plan does not initialize/resolve `staging` in recovery and does not state what should happen if `staging` is missing.

Choose and test an explicit contract:

- Preferred fail-safe behavior: recovery refuses with a clear “local staging branch is missing” error and leaves the lease and worktree untouched.
- If bootstrap-on-recovery is intentionally desired, use the same centralized branch initializer and test the resulting OID.

Also add the recovery analogue of test B: an old worktree at `S`, a launching branch diverged to `O`, and a stale lease. Recovery must judge retained work against `S`/`staging`, not `O`/the launching checkout.

## Blocking amendment 5: centralize `staging` initialization; do not preserve dead copies

Delete the instruction to “comment out” the old four lines and the instruction to repeat the block three times. Commented-out production code is not a rollback mechanism, and three copies of a branch invariant are exactly how this class of partial migration recurs.

Extract one small helper with an explicit contract, for example `resolveOrCreateStagingTip(repoRoot): string`, and call it wherever an exact staging tip is required. At minimum, audit these existing sites:

- `createWorktreeForGroup`
- `buildWorkflowArguments`, before `collectRepositorySources`
- `runAsCli`, before `loadRepositoryManifest`
- `recoverStaleTaskWorktreeLease`, per the contract chosen above

The helper must distinguish “branch is absent” from “Git could not run / repository is invalid.” Do not treat every nonzero or `null` `spawnSync.status` as permission to create a branch.

Because different task workflows may start concurrently, initialization also needs a defined race behavior. Two callers that both observe a missing branch must not make one otherwise-valid task fail merely because the other created it first. Use an atomic ref creation/recheck strategy, and add a child-process test in which two different task groups start together with no `staging` branch; both worktrees must be created from the same resulting staging OID.

The helper should say “create from `HEAD`,” not “create from the current branch.” Git can create the ref from a detached `HEAD`; those are not equivalent concepts.

## Required implementation order

Replace Steps 1-5 with this order:

1. Add tests A, B, and C and confirm each named test is RED for its stated reason.
2. Add the branch/tag collision test, hidden-retained-`task-N` tests (existing folder, absent folder, and submodule), explicit untracked-work test, and recovery-path test. Confirm their current failures and confirm none mutates retained data after refusing.
3. Add the concurrent missing-`staging` test if the initializer keeps bootstrap behavior.
4. Implement the single exact-ref/exact-OID initializer.
5. Change the retained-work logic to accept exact desired base OIDs and expected task refs, and check dirty state, checked-out `HEAD`, and every target branch ref in the root and submodules.
6. In the existing-worktree path, acquire the lease, resolve the base OID, perform the complete safety preflight, and reset using that same OID. On every refusal or command failure, release only the lease acquired by this call and leave all retained Git refs/content unchanged.
7. In the fresh path, resolve the base OID, preflight an already-existing root `task-N` ref before `worktree add -B`, and preflight submodule task refs before `createBranchInEveryRepository` rewrites them.
8. Update the recovery caller according to its explicit missing-`staging` contract.
9. Run the targeted test file, typecheck, and full suite.

Do not alter unrelated fixtures based only on a blanket rule such as “move `staging` whenever the fixture's current branch moves.” Read each failure and first decide whether that fixture models the integration base or intentionally models an unrelated launching checkout. Automatically moving `staging` in the latter case would erase the distinction these regression tests need to protect.

## Replace all filtered authoritative test commands

For the targeted suite, use:

```sh
node --test tests/prepareTasks.test.ts
```

For static checking, add:

```sh
npx tsc --noEmit
```

For the full suite, use:

```sh
npm test
```

If a saved full log is needed under the repository's zsh environment, use:

```sh
set -o pipefail
npm test 2>&1 | tee /tmp/tasktools-npm-test.log
```

Then inspect the saved log separately:

```sh
rg '^✖' /tmp/tasktools-npm-test.log
```

Never append `|| echo "all passing"` to a filtered test pipeline. In the original command, the pipeline's status comes from `rg`, not `npm test`; a loader error or crashed test process with no matching `✖` line reaches the echo and prints a false success.

## Acceptance criteria

Implementation is complete only when all of these are demonstrated:

- Fresh and reused task worktrees start at the exact OID of `refs/heads/staging`, independent of the launching checkout.
- A branch/tag short-name collision cannot select the tag.
- A safe old staging ancestor is reusable even when the launching branch diverged.
- Dirty work, a retained checked-out commit, and a retained hidden `task-N` branch all cause a refusal with no ref/content loss.
- The retained-branch protection applies when the worktree folder exists, when it is absent but the root task branch remains, and in every submodule whose task branch will be reset.
- Missing-`staging` behavior is covered on fresh creation, reuse, recovery, and concurrent creation.
- The reuse safety decision and destructive reset use the same resolved staging OID.
- `recoverStaleTaskWorktreeLease` uses the same base semantics as creation and preserves its fail-safe lease behavior.
- `tests/prepareTasks.test.ts` passes with zero failures.
- `npx tsc --noEmit` passes.
- The full suite introduces no failure beyond the exact five-item verified baseline. The final report must name the complete failure set; a count alone is insufficient.
- No unrelated test is edited merely to make the full-suite count return to five.

## Items correctly left out of scope

The original plan is right to leave these alone unless new evidence appears:

- `scripts/tackle-tasks/shared/resolveTaskRun.ts:58`; its `sourceBranch` field is not part of this creation/reset decision.
- `scripts/mergeTaskWorktrees.ts` discover-mode current-branch lookup; it is a separate CLI contract.
- The five already-red baseline tests; this change must not opportunistically rewrite them.

Nothing should be committed without the user's explicit instruction.
