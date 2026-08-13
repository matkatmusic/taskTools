# Phase 8–9 audit

Review target: staged tree `e88bc3103b943f88c6a95bb715a2723e33a3184d`, compared with
Phases 8 and 9 of `plans/tackle-tasks-v1_5-plan.md`. The implementation context and declared
deviations in `plans/implementation-notes-phase8.md` were also read.

## Findings

### 1. Retained worktree-creation journals are neither reconciled nor safely retryable

The Phase 7 receipt contract and Phase 8 `createTaskWorktree` row require recovery of
`<worktreePath>.create-journal.json`: a late-completed creation must have its stale journal
removed, while an incomplete creation must be rolled back using the journal's exact `runId`
ownership before retrying. `reconcileCreateTaskWorktree()`
(`scripts/tackle-tasks/reconcileStep.ts:114`) never reads the journal. It reports `completed`
from task state/worktree/lease alone, leaving a late-completion journal permanently behind, or
reports `not-completed` when task state was not written. In the latter case the proposed safe
rerun does not exist: `createTaskWorktree()` overwrites the retained journal before attempting
another create, then collides with the retained worktree/branch. Its rollback lifecycle only
handles the journal created by that current call; it does not reconcile a journal found at call
entry. Thus the implementation-notes decision that reconciliation merely classifies is
compatible with the read-only rule, but the claimed repair path is missing.

Fix this by adding ownership-checked retained-journal recovery at the beginning of the mutating
creation path (or an equivalently durable mutating recovery step), and make the read-only handler
classify journal states so it returns `not-completed` only when that rerun is proved safe. Under
the lease guard, validate the journal's task/path/branch/run, refuse a different physical owner,
return the already-created worktree after deleting a stale journal when both authority records
match, and otherwise remove the journal-owned worktree/branch first, release its lease last, and
delete the journal before creating afresh. Never infer ownership from the conventional path.

Add fault-injection tests for death after task state is written but before journal deletion, death
with a retained worktree/lease before task state is written, and a third owner replacing the
lease. Prove recovery leaves exactly one valid worktree/branch/lease, no journal, and never touches
the third owner's artifacts.

### 2. A commit that lands before its run-record append cannot be recovered

Phase 8 explicitly requires the partial state “derived commit is at HEAD but its hash is absent
from the run record” to be repaired by rerunning `commitTaskWork` without creating another
commit. `reconcileCommitTaskWork()` (`reconcileStep.ts:244`) only examines commits already in
`record.commits`; it cannot identify the unrecorded HEAD. It returns `not-completed`, but the real
`commitTaskWork()` skips clean layers, so a rerun never appends that hash. If an earlier commit is
already recorded, the handler sees that old hash is no longer HEAD and remains
`not-completed` forever. It also returns all prior non-merge commits for a later logical visit,
rather than the commits produced by the lost visit.

Make commit publication recoverable and visit-specific. Carry the logical `stepId` into the
commit script and durable evidence, recognize each commit created by that step at the applicable
layer's HEAD, and have the safe rerun append an already-landed unrecorded hash instead of making or
silently skipping a commit. Reconciliation must reconstruct only that step's stdout and must not
accept commits from an earlier visit.

Add a kill-point test between `git commit` and `appendTaskCommits`, then rerun and prove the HEAD
is unchanged, the original hash is recorded once, and reconciliation completes. Add a second test
with two logical commit visits (including a no-op visit) to prove an older receipt cannot complete
the newer step.

### 3. Any old rebase receipt completes every later rebase or advance step

The rebase/advance row requires checking every layer's rebase state and HEAD for the lost logical
step. `reconcileRebase()` (`reconcileStep.ts:295`) only checks that no rebase directory is live and
that `record.sourceTipsAtRebase` is non-empty. The receipt is not tied to `input.stepId`, is not
checked for complete current-occurrence coverage, and no worktree HEAD is inspected. After one
successful rebase, a later `rebaseTaskWorktree` or `advanceTaskRebase` result can be lost before
that call changes or tests anything; the stale receipt makes the handler return `completed` and
the workflow skips the new rebase/test work.

Persist visit-specific durable evidence for rebase and advance (at minimum the `stepId`, exact
occurrence set, post-step HEADs/source tips, and reconstructable result), and accept `completed`
only when that evidence matches the requested step and the live per-layer state. A receipt from a
prior visit must be `not-completed` or `ambiguous` according to whether rerun is proved safe.

Add fault-injection tests with two rebase visits in one run, proving the second cannot consume the
first receipt, plus root and nested-occurrence tests proving missing/mismatched HEAD evidence is
not accepted for either `rebaseTaskWorktree` or `advanceTaskRebase`.

### 4. Archive reconciliation accepts an archive from the wrong run

The `closeTaskRun` row requires the task to be absent from `tasks.json` and present in
`completedTasks.json` with this run's commits. `reconcileCloseTaskRun()`
(`reconcileStep.ts:429`) looks up the archived task, but once close has succeeded
`readStateOrNull()` necessarily returns `null` because it reads only `tasks.json`. Consequently
`expected` is `null`, the commit comparison is skipped, and any archive with the same task number
is reported `completed`. The handler also ignores the original `closureNote`. Its both-files path
returns `not-completed` without proving that the immutable archived record belongs to this run.

Read the archived record's retained `run.history`, find the ended `completed` entry for the exact
`runId`, and require exact chronological hashes and closure note, matching the established
`closeTaskRunReconciled` contract. Return `ambiguous` for wrong-run, wrong-note, malformed, or
wrong-hash evidence. Return `not-completed` for the both-files repair case only after proving that
the archive is the same run's durable record. Prefer extracting and sharing the existing pure
archive-validation logic so close and reconciliation cannot drift.

Extend the archive fault-injection test with wrong-run, wrong-note, and wrong-hash completed-only
records and with both-files records for the same and a different run.

### 5. Notes-path reconciliation does not recompute the mutation's containment contract

The resumability row says the verdict must be recomputed, and the implementation scripts require
the notes path to resolve to a regular file inside the real worktree. In contrast,
`reconcileIsTaskRunResumable()` (`reconcileStep.ts:133`) only calls
`existsSync(join(worktreePath, notesFile))`, and
`reconcileRecordImplementationNotes()` (`reconcileStep.ts:215`) only compares the stored string.
They can report `completed`/`resumable:true` for `../` escapes, absolute outside paths, symlink
escapes, directories, or a recorded path deleted after the mutation—states the real
`recordImplementationNotes` and `isTaskRunResumable` contracts reject.

Extract one read-only realpath/regular-file containment predicate and use it in both production
scripts and both reconciliation handlers. Reconciliation must require the original worktree path
and intended notes path and return a non-completed/ambiguous verdict rather than reconstructing
success when containment or existence cannot be proved.

Add reconciliation tests for a valid relative file and for `../`, absolute-outside, symlink-out,
directory, and deleted-file cases. Assert the real mutator/resumability function and the handler
classify every fixture consistently.

### 6. `AgentPromptEmitter` is classified read-only but rewrites the brief

The Phase 8 policy defines read-only as mutating nothing. The owner decision recorded in the
implementation notes also says this emitter “only reads and prints.” However,
`loadPreparedTask()` (`scripts/tackle-tasks/AgentPromptEmitter.ts:69`) calls
`writeTaskBrief()` at line 73, so every applicable emitter invocation can write the worktree.
`greenBoxPolicy.ts:15` then permits blind retry as `read-only`. This makes the policy factually
wrong and gives a lost yellow-box invocation an undeclared repeated mutation.

Keep the owner-selected read-only policy by making task loading read-only: derive/validate the
expected brief path without writing it and let the existing generate/update-docs boxes own brief
writes. If an emitter can run before the brief exists, fail explicitly or arrange the workflow so
the documented mutating docs box runs first; do not create it from the emitter.

Add a test that snapshots the worktree, invokes every CLI role, and proves no file bytes or paths
change. Include an existing sentinel brief to prove it is not rewritten and a missing-brief case
to prove the emitter does not silently create one.

### 7. Several yellow-role return instructions do not match the Phase 9 contracts

Phase 9 requires the exact role results shown in its table. The `plan` prompt still returns the
old v1.1 `{task,status,planFile,question,missingFiles}` shape
(`AgentPromptEmitter.ts:160-174`) and never returns `planWritten`, so the Phase 10 schema cannot
consume it. `review-plan`, `implement`, `review-tests`, and `amend-tests` add the old `task` field
even though their required shapes omit it (`AgentPromptEmitter.ts:197-227`, `235-307`, and
`405-431`). With the workflow's schema and “no keys added or removed” rule, these become null
agent results instead of diagram edges.

Change every role's return instruction to exactly the Phase 9 table:
`{planWritten}`, `{reviewWritten, reviewer}`,
`{implemented, implementationNotesFile, remaining}`, `{flagged, reviewer}`, `{amended}`,
`{fixed}`, and `{resolved, unresolvedPaths}`. Preserve the validators as the only authority for
plan/review validity rather than reviving planner/reviewer verdict fields.

Add one test per role that parses or otherwise structurally asserts the instructed result keys are
exactly the required set, including a direct assertion that `planWritten` exists and the old
planning-status fields do not.

### 8. The fix roles can edit source outside `ownedFiles`

Phase 9 says both `fix-suite` and `fix-tests` must edit source, never tests, and the fix must land
inside `ownedFiles`. `fixCodebasePrompt()` (`AgentPromptEmitter.ts:357`) instead permits editing
any source code under the failing layer's `checkoutPath`, excluding only nested occurrence paths.
Neither function receives nor prints the task's owned files. A repair agent can therefore alter
unowned source and report `{fixed:true}`; the later fence catches the violation only after the
unauthorized edit has already been made.

Pass the occurrence-appropriate owned source paths into both roles and make them the complete edit
allowlist, while retaining the blanket test-file prohibition and nested-layer exclusions. Return
`fixed:false` without editing when the repair requires any path outside that allowlist.

Extend both existing fix-prompt tests with one owned and one unowned source path. Prove the prompt
names the owned path as editable, explicitly forbids the unowned path/scope, and does not grant the
whole checkout as an edit boundary.

### 9. Runtime prompt data is not interpolated last

Phase 9 is governed by `workflow-only-context-injection.md` sections 2 and 6 and explicitly says
every prompt interpolates its data last. The implementation puts scrap `preamble` before all plan
instructions (`AgentPromptEmitter.ts:125`), task/test data throughout the plan and implement
instructions, failure output in the middle of fix prompts (`AgentPromptEmitter.ts:357-386`), and
review notes before the amend-test rules (`AgentPromptEmitter.ts:405-431`). This violates the
specified context boundary and allows long runtime content to split or precede the authoritative
instructions.

Restructure all eight builders so their static instructions and return contract come first and
runtime/bulk content is appended in a final, clearly delimited data section. Refer to labels from
the instructions instead of splicing payload text into the middle. Preserve the shared codex
fallback chain while placing the review question's task data at the end of the nested reviewer
prompt.

Add sentinel-based tests for every role that inject distinctive preamble, notes, test output,
paths, and task-test text and proves all runtime payload blocks occur after the final static
instruction/return contract, while still leaving no unresolved interpolation.

### 10. The required one-per-row fault-injection coverage is missing

Phase 8 requires a fault-injection test for every reconciliation-table row. The staged
`reconcileStep.test.ts` has 12 tests total and does not exercise completed-result recovery for
many handlers, including claim, resumability, reset, generated/updated docs, implementation-note
recording, full-suite decisions, rebase/advance, merge-commit recording, exit-note recording,
inactivation, or hold release. `getReconciliationHandlerNames()` equality proves only that a
function name exists; it does not prove the handler recognizes the mutation's real durable state
or reconstructs its stdout. Findings 1–5 are examples that the current coverage misses.

Add a table-driven coverage assertion tying every mutating policy entry to a named fault-injection
case, plus real post-mutation/lost-result tests for each row. Each test must run or faithfully
inject the real mutation, discard its returned value, call `reconcileStep`, and compare the
reconstructed result and status with that script's actual contract. Include negative partial,
stale-step, wrong-owner, and ambiguous fixtures where the row defines them.

## Verification performed

- `npx tsc --noEmit` — passed.
- Phase 8–9 targeted tests — 34 passed.
- `npm test` — 1,746 passed, 0 failed.

The green suite does not resolve the findings above because the required negative and per-row
fault-injection cases are absent or assert only the current weakened behavior.
