# Task 30 Plan: readyForApproval gating and reviewer exercise-method handoff

## Note on how this plan was produced

This plan was written from `plans/brief-30.md` only, per the orchestrator's
instruction not to read other files during planning. Consequences for
whoever implements this:

1. This module aggregates results that (per the brief) already come from
   other places in this codebase: `scripts/syncVerification.ts` (test
   receipts), an ownership check, a typecheck run, and occurrence-convergence
   detection. **Before writing any code**, read `scripts/syncVerification.ts`
   in full to get its real receipt type/shape, and grep the codebase for
   whatever already represents "selected tasks", "task groups", "ownership
   check result", "typecheck result", and "occurrence convergence" (candidate
   files to check first, by name only — not read during this planning pass:
   `scripts/canonicalTaskGroups.ts`, `scripts/taskGroups.ts`,
   `scripts/ownershipSnapshots.ts`, `scripts/ownershipKeys.ts`,
   `scripts/occurrenceSync.ts`, `scripts/occurrenceTreeDelta.ts`,
   `scripts/testPolicy.ts`, `scripts/runFinalizer.ts`). Reuse existing types
   instead of inventing parallel ones (ponytail rung 2). The type names below
   (`SelectedTaskStatus`, `OwnershipCheckOutcome`, etc.) are placeholders for
   "whatever the real equivalents are called" — if a matching type already
   exists, import it instead of redeclaring it in `approvalReadiness.ts`.
2. Also read one recent test file (e.g. `tests/relatedTests.test.ts` or
   `tests/syncVerification.test.ts`) before writing
   `tests/approvalReadiness.test.ts`, to match this repo's actual
   test-runner import style and assertion style. This plan assumes
   `bun:test`.
3. If step 1 shows the real receipt/ownership/typecheck/occurrence types
   carry more fields than assumed here, adapt the field names in this plan's
   input type to match them — the *shape of the logic* (one independent
   check per failure category, folded into a `blockedBy` list) is what this
   plan is committing to, not the exact field names.

## Behavior, in plain English

At the end of a tackle-tasks run, before the run can be marked
`readyForApproval`, every one of these must hold:

1. Every selected task's state is `"done"` (not partial, not blocked, not
   needing clarification).
2. The ownership check passed.
3. The typecheck passed.
4. Every occurrence that had to converge (repeated/parallel work on the same
   logical change) has converged.
5. Every test receipt produced by `scripts/syncVerification.ts` for this run
   is green — and there is at least one receipt (no receipts is not
   vacuously green).
6. Every task group has a reviewer result, and that result contains at least
   one *actionable* exercise method — either a live server URL, or an exact
   command plus the working directory to run it from. Prose-only notes
   ("looks good", "tested manually") do not count.

If any single one of these fails, the run is **not** ready for approval, but
it stays "recoverable" (nothing about this check mutates or destroys run
state — it only reports). The reviewer step in particular is explicitly
**report-only**: it must never write to disk, never touch git, never mutate
the run it is reviewing. It only reads facts already recorded elsewhere and
reports what it finds.

## Public API to implement (`scripts/approvalReadiness.ts`)

Keep this file under 250 lines. If the real imported types make this file
grow past that, split the exercise-method validation
(`isActionableExerciseMethod`, `reviewGroupExerciseMethod`) into
`scripts/exerciseMethodReview.ts` before it happens, not after.

```ts
export type TaskCompletionState = "done" | "partial" | "blocked" | "needs-clarification";

export interface SelectedTaskStatus {
    taskId: string | number;
    state: TaskCompletionState;
}

export interface OwnershipCheckOutcome {
    passed: boolean;
}

export interface TypecheckOutcome {
    passed: boolean;
}

export interface OccurrenceConvergenceOutcome {
    converged: boolean;
}

export interface TestReceipt {
    groupId: string;
    status: "green" | "red";
}

export type ExerciseMethod =
    | { kind: "url"; url: string }
    | { kind: "command"; command: string; workingDirectory: string }
    | { kind: "note"; text: string };

export interface GroupReviewResult {
    groupId: string;
    methods: ExerciseMethod[];
}

export interface ApprovalReadinessInput {
    groupIds: string[];
    selectedTasks: SelectedTaskStatus[];
    ownership: OwnershipCheckOutcome;
    typecheck: TypecheckOutcome;
    occurrenceConvergence: OccurrenceConvergenceOutcome;
    testReceipts: TestReceipt[];
    groupReviews: GroupReviewResult[];
}

export type ApprovalBlockReason =
    | "partial"
    | "blocked"
    | "clarification"
    | "ownership"
    | "typecheck"
    | "sync"
    | "test"
    | "missing-review"
    | "non-actionable-review";

export interface ApprovalReadinessResult {
    readyForApproval: boolean;
    blockedBy: ApprovalBlockReason[];
}

export function isActionableExerciseMethod(method: ExerciseMethod): boolean
export function assessApprovalReadiness(input: ApprovalReadinessInput): ApprovalReadinessResult
```

`isActionableExerciseMethod`: `true` only for `{kind:"url", url}` with a
non-empty `url`, or `{kind:"command", command, workingDirectory}` with both
non-empty. `{kind:"note", ...}` is always `false` — this is the "prose only"
case the brief calls out.

`assessApprovalReadiness`: build `blockedBy` by checking each of the six
behaviors above independently (no short-circuiting — a run can be missing
ownership AND have a red receipt, and both should show up), in this order:

```
selectedTasks.some(partial)              -> push "partial"
selectedTasks.some(blocked)              -> push "blocked"
selectedTasks.some(needs-clarification)  -> push "clarification"
!ownership.passed                        -> push "ownership"
!typecheck.passed                        -> push "typecheck"
!occurrenceConvergence.converged         -> push "sync"
testReceipts.length === 0
  || testReceipts.some(status === "red") -> push "test"
for each groupId in groupIds:
    review = groupReviews.find matching groupId
    no review found                      -> push "missing-review"
    review found, no actionable method   -> push "non-actionable-review"
readyForApproval = blockedBy.length === 0
```

Why `blockedBy` is a list, not a single reason: the brief requires each
failing input to *independently* prevent readiness, which a list satisfies
trivially (single failure -> one-element list) without forcing a priority
order that the brief never specified.

Why "missing-review" and "non-actionable-review" are two separate reasons
(rather than collapsing both into one "missing-review" bucket): the Tests
paragraph in the brief lists "missing review" and "non-actionable review" as
two separate failing-input scenarios, and coding-standards.md favors precise
names over overloaded ones — a caller trying to fix the run needs to know
whether to add a review or to fix the review's content.

## Reviewer contract (`reviewGroupExerciseMethod`)

The brief requires that "the reviewer performs no writes" be independently
testable. The lazy way to guarantee that is to make the reviewer a pure
function with no I/O at all — it does not go discover a live server or probe
the filesystem itself; it only shapes/validates facts that some other,
already-existing part of the run (whatever produces `GroupReviewResult`
today, or the group's own recorded metadata) already knows:

```ts
export interface GroupExerciseFacts {
    groupId: string;
    workingDirectory: string;
    liveServerUrl?: string;
    verificationCommand?: string;
}

export function reviewGroupExerciseMethod(facts: GroupExerciseFacts): GroupReviewResult
```

Logic: if `liveServerUrl` is set, include `{kind:"url", url: liveServerUrl}`.
If `verificationCommand` is set, include
`{kind:"command", command: verificationCommand, workingDirectory: facts.workingDirectory}`.
If neither is set, include a single `{kind:"note", text: "no actionable
exercise method available"}` so the group is still represented (as
"reviewed but non-actionable", not "missing"). No `fs`, `child_process`, or
`git` calls anywhere in this function — that is what makes "no writes"
true by construction rather than by convention.

If step 1's codebase read reveals group facts are only obtainable by
reading already-existing state (e.g. a recorded server-url file written by
an earlier phase), a **read-only** lookup is acceptable (`fs.readFileSync`),
but no write/mutate call may appear anywhere in this function or anything it
calls — verify by grep for `writeFile|appendFile|execSync|spawn.*(commit|push|checkout)` in the finished file before considering the task done.

## Tests (`tests/approvalReadiness.test.ts`)

Read one existing test file first (see note above) to match import/assert
style. Build one shared `baseGreenInput(): ApprovalReadinessInput` fixture
that is fully green (one task, `state: "done"`; `ownership.passed: true`;
`typecheck.passed: true`; `occurrenceConvergence.converged: true`; one green
`testReceipts` entry; one `groupReviews` entry with an actionable
`{kind:"command", command, workingDirectory}` method), so every failing test
clones it and breaks exactly one field (single-condition-branching guide:
each test proves one behavior).

- `test_partialTaskPreventsReadyForApproval` — one task `state: "partial"` ->
  `readyForApproval === false`, `blockedBy` includes `"partial"`.
- `test_blockedTaskPreventsReadyForApproval` — same, `"blocked"`.
- `test_clarificationNeededTaskPreventsReadyForApproval` — same,
  `"needs-clarification"` -> `blockedBy` includes `"clarification"`.
- `test_ownershipViolationPreventsReadyForApproval` — `ownership.passed = false`.
- `test_typecheckFailurePreventsReadyForApproval` — `typecheck.passed = false`.
- `test_unconvergedOccurrencePreventsReadyForApproval` — `occurrenceConvergence.converged = false` -> `blockedBy` includes `"sync"`.
- `test_redTestReceiptPreventsReadyForApproval` — one receipt `status: "red"`.
- `test_missingTestReceiptPreventsReadyForApproval` — `testReceipts: []`.
- `test_missingGroupReviewPreventsReadyForApproval` — `groupReviews: []` while `groupIds` still lists the group -> `blockedBy` includes `"missing-review"`.
- `test_nonActionableGroupReviewPreventsReadyForApproval` — group review present but its only method is `{kind:"note", text: "..."}` -> `blockedBy` includes `"non-actionable-review"`.
- `test_fullyGreenRunWithActionableMethodPerGroupIsReadyForApproval` — `baseGreenInput()` unmodified -> `readyForApproval === true`, `blockedBy` is empty.
- `test_liveServerUrlMethodIsActionable` — `isActionableExerciseMethod({kind:"url", url: "http://localhost:3000"})` -> `true`.
- `test_commandWithWorkingDirectoryIsActionable` — `isActionableExerciseMethod({kind:"command", command: "bun test", workingDirectory: "/repo"})` -> `true`.
- `test_commandWithoutWorkingDirectoryIsNotActionable` — same but `workingDirectory: ""` -> `false`. (Guards against the exact "prose only" failure the brief names: a command with no working directory is not exercisable.)
- `test_proseOnlyNoteIsNotActionable` — `isActionableExerciseMethod({kind:"note", text: "looks fine"})` -> `false`.
- `test_reviewerReturnsUrlWhenLiveServerUrlFactProvided` — `reviewGroupExerciseMethod({groupId, workingDirectory, liveServerUrl: "http://localhost:4000"})` -> methods contains an actionable `{kind:"url", ...}`.
- `test_reviewerReturnsCommandWhenVerificationCommandFactProvided` — same, with `verificationCommand` set instead -> actionable `{kind:"command", ...}` using `facts.workingDirectory`.
- `test_reviewerReturnsNonActionableNoteWhenNoFactsProvided` — neither fact set -> methods is a single non-actionable `{kind:"note", ...}`.
- `test_reviewerPerformsNoWrites` — wrap `fs` (or whatever module the real
  implementation ends up importing, per step 1) in a `Proxy`/mock whose
  write-shaped methods (`writeFile`, `writeFileSync`, `appendFile`, `rm`,
  etc.) throw if called; call `reviewGroupExerciseMethod` with that mock
  injected or globally patched for the test; assert it returns normally
  (no throw) and produces the expected result. If step 1 shows
  `reviewGroupExerciseMethod` ends up needing zero imports at all (the
  planned pure-function design), this test still stands as a regression
  guard: it documents the invariant so a future edit that adds an I/O call
  fails loudly.

Write these RED first (import from a not-yet-existing
`scripts/approvalReadiness.ts`, confirm they fail), then implement the
module function-by-function until each goes GREEN, per
`~/.claude/guides/tdd.md`.

## Order of implementation

1. `isActionableExerciseMethod` + its three tests (pure, no dependencies).
2. `reviewGroupExerciseMethod` + its four tests (pure, depends only on
   `isActionableExerciseMethod` indirectly through the shape it produces,
   not by calling it).
3. `assessApprovalReadiness` + its remaining tests, wiring in whatever real
   types step 1's reading produced.

## Explicitly out of scope (YAGNI)

- Auto-discovering a live server URL or a verification command by probing
  the filesystem/network — `reviewGroupExerciseMethod` only shapes facts
  handed to it; discovering those facts is a different task if it doesn't
  already exist elsewhere.
- Any persistence of the approval-readiness result (writing it to a report
  file, updating run state) — the brief only asks for the computation; wiring
  its result into whatever consumes it (likely `runFinalizer.ts`, per its
  name) is a follow-on integration step, not this task.
