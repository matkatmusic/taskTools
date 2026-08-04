# Task 20 Plan: scripts/syncVerification.ts

Phase 2 of the recursive repository-discovery redesign. New module only — no
production call sites. Follows TDD: write the failing tests below first,
then implement until green.

## Before writing code

Read these three existing modules to confirm exact exported names/types
(this plan was written brief-only and does not pin their signatures):

- `scripts/occurrenceBranchNames.ts` (task 14, commit `7665d32`) — deterministic
  per-occurrence branch naming. Use it to compute the *expected* branch name
  for an occurrence; compare against the occurrence's actual recorded branch
  to detect drift.
- The per-occurrence test-policy module from task 18 (commit `b07157f`,
  "related-test/complete-suite commands"). Use it to resolve, per occurrence,
  which related tests to run, and per parent, which complete-suite command
  to run. If no policy resolves for an occurrence, that is the
  "missing test policy" failure case.
- `scripts/relatedTests.ts` — already in the repo, exercises the same
  related-test concept task 18's policy module resolves against. Confirm
  whether the task-18 policy module already wraps this, or whether
  `syncVerification.ts` should call it directly.

Do not reimplement branch-naming, test-policy resolution, or related-test
lookup — import from these three.

## Data shapes (`scripts/syncVerification.ts`)

Pure, no I/O in the types themselves:

```ts
interface TreeEntry {
  path: string;
  mode: string;
  byteHash: string;
  symlinkTarget?: string;
  deleted?: boolean;
}

interface Occurrence {
  path: string;            // occurrence's repo path
  branch: string;          // occurrence's actual current branch
  tree: TreeEntry[];       // occurrence's content snapshot
  parentChain: string[];   // immediate parent -> ... -> root, repo paths
}

interface SyncReceipt {
  logicalRepoId: string;
  convergedDigest: string;
  occurrences: Occurrence[];
  lastWriterOccurrence: string; // occurrence.path that authored the change
}

interface GreenReceipt {
  logicalRepoId: string;
  convergedDigest: string;
  occurrences: string[];      // occurrence paths verified
  verifiedParents: string[];  // distinct parent paths whose complete suite ran
  lastWriterOccurrence: string;
  verifiedAt: string;         // ISO timestamp
}

type VerificationFailureKind =
  | "mismatched-tree"
  | "branch-drift"
  | "missing-test-policy"
  | "test-failure";

class VerificationError extends Error {
  constructor(public kind: VerificationFailureKind, message: string) {
    super(message);
  }
}
```

One error class with a `kind` discriminant, not four subclasses — callers
switch on `.kind`, tests assert `.kind`.

## Runner injection (why: keeps tests pure, no real git/test-runner I/O)

```ts
interface SyncVerificationRunners {
  resolveExpectedBranch(occurrence: Occurrence, receipt: SyncReceipt): string;
  resolveTestPolicy(occurrence: Occurrence): TestPolicy | undefined;
  runRelatedTests(occurrence: Occurrence): boolean | Promise<boolean>;
  runCompleteSuite(parentPath: string): boolean | Promise<boolean>;
}
```

`resolveExpectedBranch` and `resolveTestPolicy` are thin adapters over the
task-14 and task-18 modules respectively — in production code they call
those modules directly; in tests they're stubbed. `TestPolicy` is whatever
type task 18's module exports; import it rather than redefining it.

## `verifySync(receipt, runners): Promise<GreenReceipt>`

Order of checks, in this order because each is cheaper than the next and
should fail fast before paying for test execution:

1. **Tree equivalence**: for every pair of occurrences, deep-compare `tree`
   arrays (path, mode, byteHash, symlinkTarget, deleted). Any divergence ->
   throw `VerificationError("mismatched-tree", ...)`.
2. **Branch check**: for every occurrence, `runners.resolveExpectedBranch(...)`
   must equal `occurrence.branch`. Mismatch -> `VerificationError("branch-drift", ...)`.
3. **Test policy + related tests**: for every occurrence, call
   `runners.resolveTestPolicy(occurrence)`. `undefined` ->
   `VerificationError("missing-test-policy", ...)`. Otherwise call
   `runners.runRelatedTests(occurrence)`; falsy result ->
   `VerificationError("test-failure", ...)`.
4. **Complete suite per distinct parent**: walk every occurrence's
   `parentChain` to the root. Maintain a `Set<string>` keyed by
   `` `${parentPath}:${receipt.convergedDigest}` ``. Skip a parent if its key
   is already in the set (dedup); otherwise run
   `runners.runCompleteSuite(parentPath)`, add the key regardless of
   outcome, and on falsy result throw
   `VerificationError("test-failure", ...)`.
   - This key is parent-path-scoped, not logical-child-scoped: two distinct
     parents that both contain the same logical child produce two distinct
     keys and each runs its complete suite. Do not key by logical repo id.
5. **Dedup within step 3 too**: key related-test execution by
   `` `${occurrence.path}:${receipt.convergedDigest}` `` in a second `Set`,
   so if the same occurrence path were ever listed twice in
   `receipt.occurrences` its related tests run once.
6. On success, build and return the `GreenReceipt`: `occurrences` = all
   `occurrence.path`s, `verifiedParents` = every distinct parent path that
   ran (from the step-4 set, path portion only), `lastWriterOccurrence` =
   `receipt.lastWriterOccurrence` (pass through, don't recompute),
   `verifiedAt` = `new Date().toISOString()`.

## `persistGreenReceipt(receipt: GreenReceipt, baseDir = "receipts"): void`

Before writing this: grep the repo for an existing receipt-persistence
convention from Phase 1 (search for `Receipt` outside this task's own new
files). If one exists, follow its location/format instead of the default
below.

Default if nothing exists yet: write
`${baseDir}/${receipt.convergedDigest}.json` (create `baseDir` recursively
if missing), JSON-stringified with 2-space indent. `baseDir` is a parameter
specifically so tests can point it at a scratch directory instead of the
real `receipts/` folder.

Call `persistGreenReceipt` from `verifySync` only after all checks pass —
`verifySync` itself does the writing (single call site), rather than
splitting "verify" and "persist" across two calls the (currently
nonexistent) caller would have to remember to chain.

## Tests (`tests/syncVerification.test.ts`) — write these first, red before green

Use in-memory `SyncReceipt` fixtures and stub `SyncVerificationRunners`
(vitest/bun `mock`/plain closures — match whatever `tests/relatedTests.test.ts`
already uses for consistency). Point `persistGreenReceipt`'s `baseDir` at a
temp directory per test (e.g. `fs.mkdtempSync`), clean up after.

1. **Mismatched trees fail verification** — two occurrences with differing
   `tree` entries (different `byteHash` for the same `path`) -> `verifySync`
   rejects with `VerificationError` where `kind === "mismatched-tree"`.
   Cover byte, mode, symlink-target, and deleted-flag divergence as
   sub-cases (four small cases, one assertion each — not one giant fixture).
2. **Drifted branches fail verification** — `resolveExpectedBranch` stub
   returns a name that doesn't match `occurrence.branch` -> rejects with
   `kind === "branch-drift"`.
3. **Missing test policy fails verification** — `resolveTestPolicy` stub
   returns `undefined` for one occurrence -> rejects with
   `kind === "missing-test-policy"`.
4. **Failing tests fail verification** — two sub-cases: `runRelatedTests`
   stub returns `false` -> `kind === "test-failure"`; and (separately)
   `runCompleteSuite` stub returns `false` -> `kind === "test-failure"`.
5. **Identical repo/test/digest runs execute once** — build a receipt where
   two occurrences share a parent path in their `parentChain` (same
   `convergedDigest`). Assert `runCompleteSuite` stub was called exactly
   once for that parent path (spy call count). Do the same for
   `runRelatedTests` with a receipt listing the same occurrence path twice.
6. **Two distinct parents with the same logical child both run** — build a
   receipt where two occurrences have different `parentChain` entries
   (different parent paths) but represent the same logical repo (same
   `logicalRepoId`/`convergedDigest`). Assert `runCompleteSuite` was called
   once per distinct parent path (call count === number of distinct
   parents, not 1).
7. **Green receipt persisted only on full success, keyed to converged
   digest** — happy-path fixture where all stubs return `true`/resolved
   values. Assert: `verifySync` resolves to a `GreenReceipt` with the
   expected `convergedDigest`, `occurrences`, `verifiedParents`, and
   `lastWriterOccurrence`; the file at
   `${baseDir}/${convergedDigest}.json` exists and parses back to the same
   receipt. Then, as a negative check, rerun a failing fixture (e.g. case 1)
   and assert no file was written under `baseDir` for it.

## Order of implementation

1. Read the three existing modules named above; note their real exports.
2. Write `tests/syncVerification.test.ts` in full (all 7 cases) against the
   type/function signatures above — it will fail to compile/run since
   `scripts/syncVerification.ts` doesn't exist yet. That's the red state.
3. Create `scripts/syncVerification.ts` with the types, `VerificationError`,
   `verifySync`, and `persistGreenReceipt` as specified.
4. Run tests, fix until green. Keep the file under 250 lines — if it grows
   past that, split persistence (`persistGreenReceipt` + its file I/O) into
   a second small file rather than trimming the verification logic.
5. No production wiring — this task ends at green tests, per the brief's
   "no production call sites yet."

## Skipped (ponytail)

- No CLI entry point / orchestrator wiring — not requested, no call site yet.
- No retry/backoff around `runCompleteSuite`/`runRelatedTests` — brief asks
  for pass/fail semantics only; add when a real flaky-suite case shows up.
- No four-subclass error hierarchy — one class with a `kind` field is the
  same information, less code.
