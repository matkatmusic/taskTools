# Phases 2–7 remediation feedback — iteration 2

Reviewed only the unresolved items in `phase2-7-audit.md` and `feedback-phase7-1.md` against the staged snapshot whose SHA-256 is `601a00805adeba53f01b6ba4455826b6cbca0e782b077f801aca10803427b52f`.

F3, F11, F12, M1/F2, and M4 are resolved. The 89 focused tests pass, `npx tsc --noEmit` passes, and `git diff --cached --check` is clean. One F7 acceptance criterion remains unresolved.

## F7 — retained lease-intent reconciliation can overwrite a different physical owner

`taskRunState.ts:reconcileRetainedAdoptionIntent` decides `shouldFinish` solely from `tasks.json`. When true, it unconditionally writes the new run's lease over `worktreePath.lease`. It never reads and classifies the physical lease that exists when reconciliation begins.

After a process dies with a transition intent present, its stale lease guard must be explicitly recovered before retry. During that recovery window, another owner can legitimately acquire or be assigned the physical lease. The retry then takes the guard and overwrites that different owner's lease with `intent.newOwnerRunId`. This violates iteration 1's explicit requirement to “never overwrite a different owner” and can let two runs mutate the retained worktree.

The new kill/retry tests cover only an absent lease or a lease already naming the intent's new owner, so they do not exercise this refusal boundary.

### Required fix

Under the task-state lock and lease guard, read the current physical lease before changing either authority and classify it against the intent:

1. The physical state is compatible only when it is the exact recorded prior state (`previousLeaseBytes`, including absence) or already names `newOwnerRunId` as the partially completed transition.
2. If it names any other run, do not change the lease, `tasks.json`, or intent. Throw/refuse with the current owner and intended owner so recovery is explicit.
3. On the finish path, change only a compatible prior physical state to `newOwnerRunId`, then fence and update the still-current active run's `leaseRunId`, then remove the intent.
4. On the rollback path, restore the prior physical state only if the current lease still names `newOwnerRunId` or already equals the recorded prior state. Never restore over a third owner. Retain the intent and report the mismatch when safe reconciliation cannot decide.
5. Keep the existing lock order and the successful intent-only, lease-written, state-written, ordinary-write-failure, and different-owner-without-intent behavior.

### Proving tests

- Kill after the physical lease write, clear only the deliberately stale guards as the existing test does, replace the physical lease with byte-distinct ownership for `run-other`, then retry. Assert the call refuses, the other owner's lease bytes are unchanged, `tasks.json` is unchanged, and the intent remains.
- Repeat from an intent-only survivor with a different physical owner appearing before retry; assert the same no-mutation result.
- Exercise the rollback (`shouldFinish === false`) case with a third physical owner and prove it is not overwritten by `previousLeaseBytes`.
- Preserve the three existing successful crash-reconciliation tests and the injected state-write rollback test.
