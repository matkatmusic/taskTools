# Task 25 plan — lock mutation-guard recovery (LOCK-2)

No `TaskGet` tool was available in this session to fetch task 25's stored description by
id. This plan instead uses the audit text the orchestrator pointed at as the spec, verified
against the live pipeline:

- `plans/pipeline-audit-codex-20260905-113523.md`, section "Missing high-priority task: lock
  mutation-guard recovery": "The audit identifies a process death while holding
  `.git/taskTools-source.lock.mutation-guard` as a repository-wide permanent blocker...
  Required task: add ownership data and a safe stale-recovery protocol for the mutation
  guard. Exercise kill points around guard acquisition, lock publication, refresh, and
  release. Recovery must never remove a guard owned by a live process."
- `plans/audit-2026-09-05/audit-exits.md` row **LOCK-2** (line 200):
  `shared/sourceRepoLock.ts:83-89 (via LOCK_SOURCE_REPO.ts:18) | LOCK_SOURCE_REPO | mutation-
  guard file stranded by a process that crashed mid-guard; every later attempt blocks 10s
  then throws | ... error text itself says "inspect the PID by hand"; nothing auto-clears the
  guard, so every future run against this repo fails the same way until an operator deletes
  it manually`.

## Scope confirmation

- `scripts/tackle-tasks/shared/sourceRepoLock.ts` (219 lines, read in full). This is the only
  file that defines or touches the mutation guard.
  - `MUTATION_GUARD_TIMEOUT_MS = 10_000` (line 21) and `sourceRepoLockMutationGuardPath`
    (lines 41-43, private) name `<gitdir>/taskTools-source.lock.mutation-guard`.
  - `withSourceRepoLockMutationGuard<T>(projectRoot, action, { timeoutMs })` (lines 66-100) is
    the guard itself: a `while` loop doing `openSync(guardPath, "wx", 0o600)` (line 78, the
    atomic exclusion point), writing `{ pid: process.pid, createdAt }` (line 79), `fsyncSync`
    (line 80); on `EEXIST` it waits (line 90) until `Date.now() >= deadline` (line 83), at
    which point it unconditionally throws (lines 85-88) — the exact "inspect the PID by hand"
    text the audit quotes. There is **no** liveness check anywhere in this function today,
    and **no** function anywhere in this file that ever removes a stranded guard.
  - Four call sites, all in this file, all with a `LockOwner`-typed value already in scope
    that is not currently threaded into the guard: `acquireSourceRepoLock` (line 143, `owner`
    in scope from its own parameter), `refreshSourceRepoLock` (line 166, `owner`),
    `releaseSourceRepoLock` (line 187, `owner`), `recoverSourceRepoLock` (line 207,
    `expectedStaleOwner`). Confirmed via `rg -n
    "withSourceRepoLockMutationGuard"` across `scripts/` and `tests/` that these four are the
    **only** callers anywhere in the repo — changing this function's signature has no other
    call site to update.
  - `readSourceRepoLock` (lines 45-49) is the existing precedent for how this codebase
    exposes a lock file's parsed contents to callers/tests: a plain exported reader, not a
    path-getter. `sourceRepoLockPath` and `sourceRepoLockMutationGuardPath` are both private
    today; the existing test file never imports either — it hardcodes the well-known relative
    filename directly (confirmed: `test_acquireSourceRepoLock_resolvesWorktreeGitFile` in
    `sourceRepoLock.test.ts` uses `join(gitDir, "taskTools-source.lock")` as a literal). This
    plan follows that same convention for the guard file rather than exporting a new path
    getter.
  - `recoverSourceRepoLock` (lines 197-219) is the existing "safe stale-recovery protocol" the
    audit's phrasing echoes, but for the **outer durable lock**, not the guard: it requires an
    exact `` `abandon ${owner}` `` confirmation string and a stale heartbeat, because for that
    lock PID liveness is meaningless (a run can span a rebase tail across many short-lived
    processes and even, per its own comment, be a genuinely different machine's process id).
    The mutation guard's own comment at lines 65-66 draws the opposite conclusion for itself:
    "Held by one short-lived process, so PID liveness is a meaningful diagnostic here even
    though it is meaningless for the durable source lock." This plan takes that comment at
    its word: recovery here is PID-liveness-gated and can safely be automatic, not a second
    manual confirmation-string CLI.
- `scripts/tackle-tasks/shared/sourceRepoLock.test.ts` (425 lines, read in full). Existing
  test hooks `pauseBeforePublishUntilExists` (used inside `acquireSourceRepoLock`'s guarded
  action, via `writeSourceRepoLockAtomically`) and `pauseAfterValidateUntilExists` (used
  inside `refreshSourceRepoLock`'s and `releaseSourceRepoLock`'s guarded actions) already let
  a test pause a real child process **while it holds the guard**, confirmed at lines 296-425
  (`test_acquireSourceRepoLock_concurrentReaderNeverSeesAPartialLockDuringPublication`,
  `test_recoverSourceRepoLock_waitsForAPausedRefreshThenRefusesTheNowWarmHeartbeat`,
  `test_releaseSourceRepoLock_pausedReleaseBlocksAReplacementAcquisitionAndNeverRemovesIt`).
  None of the 20 existing tests ever kills the child instead of releasing its pause (grep for
  `SIGKILL`/`kill(` in this file: no matches) — the mutation guard's own crash recovery has
  zero existing coverage, confirming the audit's "no auto-clears" claim.
  `spawnLockCall` (lines 27-53) is the existing helper for racing multiple real child
  processes against one lock; this plan's new tests spawn a single child directly with
  `node:child_process`'s `spawn` (not `spawnLockCall`, which returns only the resolved value
  and gives no handle to `.kill()` the process mid-flight) — matching the pattern already
  used in `scripts/tackle-tasks/shared/taskRunState.test.ts` lines 500-519
  (`runAdoptionInChildAndKillAfter`: `spawn(process.execPath, ["--input-type=module",
  "--eval", childSource], { stdio: "inherit", env })`, `await once(child, "exit")`,
  `assert.equal(signal, "SIGKILL")`).
- `scripts/tackle-tasks/lockSourceRepo/LOCK_SOURCE_REPO.ts` (39 lines, read in full) calls
  `acquireSourceRepoLock` (line 18) — a caller, not touched, since `acquireSourceRepoLock`'s
  own exported signature (`projectRoot, owner, options`) does not change; only its internal
  call to `withSourceRepoLockMutationGuard` gains the `owner` argument it already has in
  scope.
- `scripts/tackle-tasks/resetTask.ts` line 63: `for (const f of
  [".git/taskTools-source.lock", ".git/taskTools-source.lock.mutation-guard"]) { ... rmSync
  ... }` — checked, confirmed this is a developer-only manual reset CLI (invoked by hand for
  local testing, per the repo's own commit history, e.g. "reset 113 for testing") that
  unconditionally deletes both files with no liveness or ownership check at all. This is a
  human explicitly accepting destructive semantics for local dev, a different trust boundary
  than the pipeline's own crash-recovery path this task is scoped to. Not touched.
- `scripts/tackle-tasks/shared/greenBoxPolicy.ts` (checked): no new file is created by this
  task (only edits within `sourceRepoLock.ts`), so no new entry is needed in
  `GREEN_BOX_POLICY`.

Files this task edits: `scripts/tackle-tasks/shared/sourceRepoLock.ts` and
`scripts/tackle-tasks/shared/sourceRepoLock.test.ts`. No other file changes.

## Steps

### Step 1 — add ownership data to the guard file

**Test: `test_acquireSourceRepoLock_stampsTheMutationGuardWithTheCallersOwnerToken`**
(new, in `sourceRepoLock.test.ts`)

Plain-English steps:
1. Acquire the lock for `owner = buildLockOwner("run-500", 500)`, but pause it inside the
   guard before it publishes (reuse `testHooks.pauseBeforePublishUntilExists`), in a spawned
   child so the guard file can be inspected from the test process while still held.
2. Read the guard file directly at `join(root, ".git",
   "taskTools-source.lock.mutation-guard")`.
3. Assert its parsed JSON has `owner === "run-500:500"`, in addition to the `pid` and
   `createdAt` it already carries.
4. Release the pause, let the child finish normally, assert it exits 0.

Failing assertion before the change: step 3's `owner` field does not exist on the object
`withSourceRepoLockMutationGuard` currently writes (line 79 only writes `{ pid, createdAt
}`).

Minimum production change (`sourceRepoLock.ts`):

```ts
export function withSourceRepoLockMutationGuard<T>(
    projectRoot: string,
    owner: LockOwner,
    action: () => T,
    { timeoutMs = MUTATION_GUARD_TIMEOUT_MS }: { timeoutMs?: number } = {},
): T {
    const guardPath = sourceRepoLockMutationGuardPath(projectRoot);
    mkdirSync(dirname(guardPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let fd: number | null = null;

    while (fd === null) {
        try {
            fd = openSync(guardPath, "wx", 0o600); // atomic exclusion point
            writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, createdAt: new Date().toISOString() }));
            fsyncSync(fd);
        } catch (error) {
```

(Only the parameter list and the one `writeFileSync` line change; the rest of the function
body is untouched in this step.)

Update all four call sites to pass the `LockOwner` value each already has:

- line 143: `return withSourceRepoLockMutationGuard(projectRoot, owner, (): AcquireOutcome => {`
- line 166: `return withSourceRepoLockMutationGuard(projectRoot, owner, () => {`
- line 187: `return withSourceRepoLockMutationGuard(projectRoot, owner, () => {`
- line 207: `return withSourceRepoLockMutationGuard(projectRoot, expectedStaleOwner, () => {`

### Step 2 — a safe, liveness-gated reclaim function, refusing on ambiguity

**Test: `test_reclaimDeadMutationGuard_throwsOnAGuardWithNoParseablePid`**

This test drives the reclaim behavior through the public surface, since the reclaim
function itself is not exported (matches this file's existing convention of testing guard
behavior only through `acquireSourceRepoLock`/etc., never a private helper directly):

1. `mkdirSync(join(root, ".git"), { recursive: true })`; hand-write
   `join(root, ".git", "taskTools-source.lock.mutation-guard")` with the literal string
   `"not json"`.
2. Call `acquireSourceRepoLock(root, buildLockOwner("run-501", 501), { timeoutMs: 200 })`.
3. Assert it throws, and the thrown message names the guard path and contains the guard's
   raw bytes (`"not json"`) — a guard with unreadable ownership data is corrupt, not proof of
   anything, so it must surface to a human rather than being silently treated as
   "not reclaimable" and folded into the generic timeout message.
4. Assert the guard file is still on disk afterward, byte-for-byte unchanged — the throw
   happens before any removal is attempted.

Failing assertion before the change: none — a corrupt guard already causes a throw today
(the pre-existing timeout throw), so this test passes once written; it changes shape rather
than outcome once Step 2's production change lands (asserting the new message, not the old
generic one), and stays green through Step 3 since a corrupt guard never reaches the
liveness check either.

**Test: `test_acquireSourceRepoLock_neverReclaimsAGuardHeldByALiveProcess`**

1. Spawn a child that acquires the guard and blocks inside it indefinitely: call
   `acquireSourceRepoLock(root, buildLockOwner("run-502", 502), { testHooks: {
   pauseBeforePublishUntilExists: <a path this test never creates> } })` in the child, so it
   pauses forever (until the test kills it at the end).
2. Wait until the guard file exists (poll `existsSync`) — the child is now genuinely alive
   and holding it.
3. From the test process, call `acquireSourceRepoLock(root, buildLockOwner("run-503", 503),
   { timeoutMs: 200 })`.
4. Assert it throws, message contains "inspect the PID by hand".
5. Assert the guard file still exists and its `pid` still equals the live child's `pid`
   (`child.pid`).
6. Cleanup: `child.kill("SIGKILL")` so the test does not leak a hung process.

Failing assertion before the change: none yet either (today everything times out and
throws) — this test is the permanent regression guard for "Recovery must never remove a
guard owned by a live process," written before the reclaim logic exists so it is exercised
against both the before and after code paths.

Live check on the shape below: `renameSync` and `randomBytes` are both already imported in
this file (`node:fs`'s `renameSync`, `node:crypto`'s `randomBytes`) and already used
together for exactly this "unique temp path, atomic move onto the real one" idiom in
`writeSourceRepoLockAtomically` (lines 103-131) — this step reuses that established pattern
rather than inventing a new one.

Minimum production change (`sourceRepoLock.ts`), added above
`withSourceRepoLockMutationGuard`:

```ts
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

// A guard whose ownership data cannot be read (bad JSON, or JSON with no numeric pid) is
// corrupt, not evidence of anything — it throws, naming the guard path and its raw bytes,
// rather than being silently folded into "not reclaimable".
function parseMutationGuardPid(guardPath: string, raw: string): number {
    let parsed: { pid?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`source-lock mutation guard at "${guardPath}" is not valid JSON: ${raw}`, { cause: error });
    }
    if (typeof parsed.pid !== "number") {
        throw new Error(`source-lock mutation guard at "${guardPath}" has no numeric pid: ${raw}`);
    }
    return parsed.pid;
}

// Recovers a guard stranded by a process that died holding it. Binds authorization to the
// exact guard object, not just its pathname: renaming a path off to a private, unique name
// is atomic, so at most one concurrent reclaimer's rename against the same guardPath can
// ever succeed — a second reclaimer's rename throws ENOENT because the first already moved
// it. Only the rename's winner ever inspects, verifies, or deletes the guard it claimed.
function reclaimDeadMutationGuard(guardPath: string, testHooks?: SourceRepoLockTestHooks): boolean {
    let raw: string;
    try {
        raw = readFileSync(guardPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
    if (isPidAlive(parseMutationGuardPid(guardPath, raw))) return false;

    waitForTestSignal(testHooks?.pauseAfterDeadGuardCheckUntilExists);

    const claimedPath = `${guardPath}.${process.pid}.${randomBytes(8).toString("hex")}.reclaimed`;
    try {
        renameSync(guardPath, claimedPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }

    // This process now exclusively owns claimedPath: the atomic rename means no other
    // reclaimer could have raced this exact object away. Re-verify anyway — a live guard can
    // only appear here if a fresh acquirer created one at guardPath in the instant between
    // this call's dead-pid check and its rename, an already-vanishingly-narrow window this
    // refuses loudly rather than silently repairing (repairing would itself reopen a window).
    if (isPidAlive(parseMutationGuardPid(claimedPath, readFileSync(claimedPath, "utf8")))) {
        throw new Error(`source-lock mutation guard reclaim at "${guardPath}" raced a live acquirer; retry`);
    }
    unlinkSync(claimedPath);
    return true;
}
```

Add one field to the existing `SourceRepoLockTestHooks` type (lines 59-63): `
pauseAfterDeadGuardCheckUntilExists?: string;` alongside `pauseBeforePublishUntilExists` and
`pauseAfterValidateUntilExists` — same `waitForTestSignal` mechanism already used for those
two, reused here rather than inventing a second synchronization primitive.

The `openSync(guardPath, "wx", ...)` `EEXIST` catch one level up (Step 3) still rethrows
every other error code unchanged, and `isPidAlive`'s `process.kill(pid, 0)` probe is
untouched — both are already the only stdlib way to ask their respective questions; this
step only changes what happens once those two answers are in hand. The corrupt-guard test
above now exercises the `JSON.parse` throw branch inside `parseMutationGuardPid`; the "no
numeric pid" branch throws via the identical pattern one line down and needs no separate
test to pin the same contract. The live-process test in this step passes against this code
unmodified (the pid it names is genuinely alive, so `reclaimDeadMutationGuard` returns
`false` before the rename is ever attempted) — it exists to lock the "never remove a live
guard" contract in place before Step 3 wires `reclaimDeadMutationGuard` into the timeout
path itself, and before Step 4 proves the concurrent-reclaimer case this replaces a weaker
compare-then-unlink design to survive.

### Step 3 — wire the reclaim into the guard's timeout path, bounded to one attempt

**Test: `test_acquireSourceRepoLock_reclaimsAStrandedGuardAfterItsOwningProcessIsKilled`**

Plain-English steps (kill points: "guard acquisition" and "lock publication" together, since
a single `acquireSourceRepoLock` call performs both):

1. Spawn a child running `acquireSourceRepoLock(root, buildLockOwner("run-504", 504), {
   testHooks: { pauseBeforePublishUntilExists: pausePath } })` (`pausePath` a file this test
   never creates for this child).
2. Poll until the guard file exists — the child has acquired the guard and written its full
   contents (pid, owner, createdAt), and is paused just before publishing the outer lock.
3. `child.kill("SIGKILL")`; `await once(child, "exit")`; assert `signal === "SIGKILL"`.
4. Assert the guard file still exists (`finally` never ran) and its parsed `owner` equals
   `"run-504:504"`.
5. Call `acquireSourceRepoLock(root, buildLockOwner("run-505", 505), { timeoutMs: 200 })`.
6. Assert the result is `{ status: "acquired" }` — reclaimed and retried within one call,
   not a throw.
7. Assert the guard file is gone and `readSourceRepoLock(root)?.owner === "run-505:505"`.

Failing assertion before this step's change: step 6 — without wiring, this throws the
"inspect the PID by hand" error instead of returning `{ status: "acquired" }`.

**Test: `test_refreshSourceRepoLock_reclaimsAStrandedGuardAfterItsOwningProcessIsKilled`**

Same shape, but the durable lock must already exist first: `acquireSourceRepoLock(root,
owner)` in the test process (completes normally), then spawn a child running
`refreshSourceRepoLock(root, owner, { testHooks: { pauseAfterValidateUntilExists: pausePath
} })`, kill it once the guard exists, then call `refreshSourceRepoLock(root, owner, {
timeoutMs: 200 })` in the test process and assert `{ refreshed: true }` and the guard is
gone.

**Test: `test_releaseSourceRepoLock_reclaimsAStrandedGuardAfterItsOwningProcessIsKilled`**

Same shape against `releaseSourceRepoLock`, asserting `{ released: true }` on the retry.

Minimum production change (`sourceRepoLock.ts`) — thread `testHooks` through (needed so
`reclaimDeadMutationGuard` can accept the new `pauseAfterDeadGuardCheckUntilExists` hook Step
2 added) and insert the reclaim call into the existing timeout branch:

```ts
export function withSourceRepoLockMutationGuard<T>(
    projectRoot: string,
    owner: LockOwner,
    action: () => T,
    { timeoutMs = MUTATION_GUARD_TIMEOUT_MS, testHooks }: { timeoutMs?: number; testHooks?: SourceRepoLockTestHooks } = {},
): T {
    const guardPath = sourceRepoLockMutationGuardPath(projectRoot);
    mkdirSync(dirname(guardPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let fd: number | null = null;
    let reclaimedOnce = false;

    while (fd === null) {
        try {
            fd = openSync(guardPath, "wx", 0o600); // atomic exclusion point
            writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, createdAt: new Date().toISOString() }));
            fsyncSync(fd);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                if (!reclaimedOnce) {
                    reclaimedOnce = true;
                    if (reclaimDeadMutationGuard(guardPath, testHooks)) continue;
                }
                const stranded = existsSync(guardPath) ? readFileSync(guardPath, "utf8") : "(already gone)";
                throw new Error(
                    `source-lock mutation guard timed out at ${guardPath}, held by ${stranded}. `
                    + "Elapsed time alone never authorizes removing a stranded guard; inspect the PID by hand.",
                );
            }
            Atomics.wait(WAIT, 0, 0, 10);
        }
    }

    try {
        return action();
    } finally {
        closeSync(fd);
        unlinkSync(guardPath);
    }
}
```

Update all four call sites (Step 1's list) to also forward `testHooks`, e.g.
`acquireSourceRepoLock`'s: `}, { timeoutMs: options.timeoutMs, testHooks: options.testHooks });`
— each of the four already has `options.testHooks` in scope (`SourceRepoLockTestHooks` is
already a field on every one of their own `options` parameters, confirmed in Scope
confirmation).

`reclaimedOnce` bounds recovery to exactly one attempt per call: if reclaiming succeeds, the
loop's `continue` retries `openSync` once more (which now succeeds, since the stranded guard
is gone); if that immediately EEXISTs again for some other reason and the deadline is still
past, `reclaimedOnce` is already `true` so the second pass falls straight through to the
existing throw — it can never loop forever chasing repeated reclaims.

This step's change also makes both Step 2 tests continue to pass unmodified: a live pid
makes `reclaimDeadMutationGuard` return `false` (so `continue` is never reached, falling
through to the existing generic timeout throw), while an unparseable or pid-less guard now
propagates `reclaimDeadMutationGuard`'s own specific throw straight out of the `catch` block
— it never reaches the generic timeout throw at all, and never reaches `continue`.

### Step 4 — prove only one of two concurrent reclaimers ever enters the guarded action

The rename-based claim in Step 2 replaces an earlier, weaker read-compare-then-unlink design
this plan drafted first: with two contenders reading the same dead guard's bytes and each
independently re-reading-and-comparing before unlinking, both compare-and-unlink checks can
pass before either actually unlinks, since re-reading identical bytes does not stop a second
process from acting on its own now-stale "bytes matched" conclusion after the first process
has already unlinked and recreated the guard live. `renameSync` closes this because the
rename itself — not a prior read — is the exclusion point: only one of two `renameSync`
calls against the same source path can ever succeed. This step is the deterministic,
two-contender test proving that guarantee, using the same shared-barrier pattern already
established in `test_acquireSourceRepoLock_exactlyOneWinnerAmongAcquirersReleasedFromABarrier`
(`sourceRepoLock.test.ts` lines 269-292, read in full) and `spawnLockCall` (lines 27-53).

**Test: `test_acquireSourceRepoLock_exactlyOneOfTwoReclaimersEntersTheGuardedActionAfterADeadGuard`**

1. Spawn a child that acquires the guard and pauses inside it forever (`testHooks: {
   pauseBeforePublishUntilExists: <a path never created> }`), then `child.kill("SIGKILL")` —
   a stranded guard naming a real, now-dead pid.
2. Using `spawnLockCall`, launch two contenders concurrently, each calling
   `acquireSourceRepoLock(root, buildLockOwner("run-506", 506) / buildLockOwner("run-507",
   507), { timeoutMs: 200, testHooks: { pauseAfterDeadGuardCheckUntilExists: barrierPath } })`
   — the same `barrierPath` for both, not yet created.
3. `await wait(150)` — both contenders independently time out, confirm the stranded pid is
   dead, and pause at the shared barrier before either attempts its `renameSync`.
4. `writeFileSync(barrierPath, "")` — release both at once; they race their `renameSync`
   calls against the same guard path.
5. `await Promise.allSettled([...])` both contender promises.
6. Assert exactly one resolved with `{ status: "acquired" }` and the other rejected with a
   message containing "inspect the PID by hand" (its `renameSync` lost, so
   `reclaimDeadMutationGuard` returned `false`, `reclaimedOnce` was already `true`, and the
   loser fell straight through to the existing generic throw without ever touching the
   winner's new guard or lock — it never entered `action()`).
7. Assert `readSourceRepoLock(root)?.owner` names exactly the winner's owner.
8. Assert no file matching `*.reclaimed` remains next to the guard path (the winner verified
   and unlinked its own private claim).

Failing assertion before Step 2's rename-based change: this exact interleaving is not
producible against a plain compare-then-unlink design without a second, separate pause point
between the compare and the unlink (which did not exist) — with the rename-based design it
is producible and deterministic via the shared barrier, and step 6 is the assertion that
pins the fix.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npm test -- scripts/tackle-tasks/shared/sourceRepoLock.test.ts
```
Expected: all existing tests plus the seven new ones in this plan pass, 0 failures.

Then the full suite, using the technique from the user's CLAUDE.md:

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```
If not "all passing", follow up with `npm test 2>&1 | tail -50` and fix, repeating until
green. Do not re-run `npm test` again once it reports "all passing".
