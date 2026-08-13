# tackle-tasks v1.5 — implementation plan

Revised against `plans/tackle-tasks-v1_5-plan-audit.md`, fourth pass. Final
pre-implementation findings are cited inline as `[a4 N]`; earlier passes use `[a1 N]`,
`[a2 N]`, and `[a3 N]`. A citation marks where a finding was answered; it is not a claim
that the audit is finished.

The spec is `plans/diagram/pipeline.mmd`. Read it before starting any phase. It is the
authority. If this plan and the diagram disagree, the diagram wins and this plan is wrong.

**This is v1.5, not v2.** `plans/tackle-tasks-v2.md` is a separate, larger design for
rebuilding taskTools as a `scripts/library/<topic>/` behavior library. v1.5 does not adopt
that layout; it rebuilds the pipeline against the diagram.

Green box = a script. Yellow box = a subagent prompt. Boxes are named by their full diagram
label, never by node id.

Read first:

- `plans/diagram/pipeline.mmd` — the spec, including its twelve global rules.
- `plans/plan-format.md` — the plan and codex-review JSON formats.
- `/Users/matkatmusicllc/Programming/taskTools/scripts/workflow-only-context-injection.md`
  — governs Phases 9, 10 and 11.

---

## Where the boxes are not 1:1 with files

One green box, one script, with these exceptions and no others `[a1 22]`:

| Exception | Boxes | File |
|---|---|---|
| both commit boxes share one script | `commit if needed` ×2 | `commitTaskWork.ts` |
| a script and the diamond reading its result share one script | rebase + `did the rebase report conflicts?`; advance + `is the rebase finished?`; merge + `did the merge land?` | the acting script returns the diamond's boolean |
| exit chain and success chain share three scripts | both `write exit type…`, both `record modified files`, both `mark task inactive` | `writeTaskExitNotes.ts`, `recordTaskModifiedFiles.ts`, `markTaskInactive.ts` |
| archive and unblock are one call | `move task to completedTasks.json and update tasks blocked by it` | `closeTaskRun.ts` — `closeTasks` calls `unblockDependents` internally |
| `stop` | `stop` | no file; it is the end of the workflow function |
| four libraries have no CLI | — | `taskRunState.ts`, `occurrences.ts`, `sourceRepoLock.ts`, `writeTaskBrief.ts` `[a3 10]` |
| three scripts serve no box | — | `greenBoxPolicy.ts`, `reconcileStep.ts`, `recoverSourceRepoLock.ts` — retry/loss policy plus the explicit operator recovery command for rule 9 |

---

## Global rules for every phase

1. **Location.** `scripts/tackle-tasks/<name>.ts`, tests at
   `tests/tackle-tasks/<name>.test.ts`. Nothing new at `scripts/` root.
2. **TDD, red then green.** `~/.claude/guides/tdd.md`.
3. **Test naming.** `test_<behaviorBeingTested>`, one behavior per test, plain-English step
   comments.
4. **Running the suite.** Never `bun test`. Use the loop from `~/.claude/CLAUDE.md`:

   ```
   INITIAL_PASS:   npm test 2>&1 | rg -e '^✖' || echo "all passing"
   FOLLOWUP_PASS:  npm test 2>&1 | tail -50
   ```

   ```
   while true:
       result = INITIAL_PASS
       if result == "all passing": break
       result = FOLLOWUP_PASS
       fix the codebase based on result
   ```

5. **Naming.** `~/.claude/guides/coding-standards.md`. Verb-first, no abbreviations.
6. **Every `tasks.json` write goes through `withTaskStateLock` + `writeJsonAtomically`.**
7. **Two parts per script**: exported functions the tests import, and a CLI guarded by
   `if (process.argv[1]?.endsWith("<filename>.ts"))`.
8. **Input on stdin, output as one line of JSON** `[a1 18]`. One JSON object in, one line of
   JSON out. No positional arguments, no shell quoting, no dependence on the agent's working
   directory. `projectRoot` is always explicit and absolute.
9. **Git fixtures are real.** Every test that touches git builds a temp repository with a
   real submodule and a real `git worktree add`. Never a standalone repo standing in for a
   linked worktree `[a3 5]`, never a mock.
10. Nothing is deleted in Phases 0–12. Phase 0 copies, Phase 13 retires.

---

## Which existing files each phase edits

| Phase | Existing files it edits |
|---|---|
| 0 | creates copies only |
| 1 | `scripts/prepareTasks.ts` — exports and the worktree-path change (§1e); `scripts/mergeTaskWorktrees.ts` — the second consumer of the worktree convention directory (§1e); `.gitignore` at the repo root (§1f) |
| 2–8 | **none** |
| 9 | reads `scripts/tackle-tasks_AgentPromptEmitter.ts`, never writes it |
| 10 | `skills/tackle-tasks/tackle-tasks.workflow.js` — rewritten |
| 11 | `skills/tackle-tasks/SKILL.md` — rewritten |

Phase 1 owns every edit to a shared file, which is what makes Phases 2–8 genuinely parallel
`[a1 23]`. **Never touch `skills/tackle-tasks-v1_1/` or `scripts/tackle-tasks-v1_1_*.ts`
after Phase 0** — that is the rollback path.

---

## The run-state field

```ts
export type TaskExitType =
    | "completed" | "invalid-number" | "not-open" | "already-active" | "blocked"
    | "plan-scrapped" | "tests-red" | "tests-flagged" | "suite-red"
    | "rebase-stuck" | "merge-failed" | "fence-violation" | "run-failed";

export type TaskCommit = { occurrenceId: string; hash: string; kind: "work" | "repair" | "merge" };

export type TaskTestResult = {
    stepId: string;             // identity of this logical test-box invocation
    testFiles: string[];        // occurrence-prefixed
    createdTestFiles: string[];
    missingTests: boolean;
    passed: boolean;
    output: string;             // last 8000 characters
    checkedAt: string;
};

export type FullSuiteResult = {
    stepId: string;             // identity of this logical suite-box invocation
    layers: { occurrenceId: string; passed: boolean }[];
    passed: boolean;
    output: string;             // last 8000 characters
    checkedAt: string;
};

export type TaskRunRecord = {
    runId: string;
    startedAt: string;              // ISO 8601, local, seconds precision
    endedAt: string | null;
    exitType: TaskExitType | null;
    exitNote: string | null;
    modifiedFiles: string[];        // occurrence-prefixed
    commits: TaskCommit[];          // chronological: work and repair, then merge
    implementationNotesFile: string | null;
    taskTests: TaskTestResult | null;   // written by run task tests   [a3 6]
    fullSuite: FullSuiteResult | null;  // written by run the full suite [a3 6]
};

export type TaskRunState = {
    active: boolean;
    worktree: string | null;
    leaseRunId: string | null;      // which run owns the worktree lease  [a3 17]
    history: TaskRunRecord[];       // oldest first, newest last
};
```

`runId` is a run's identity `[a1 20]`. `startedAt` is for humans; nothing keys on it.

`taskTests` and `fullSuite` exist because `build the closure note` runs **after** the
worktree is deleted and cannot re-derive them `[a3 6]`. The test boxes record their entire
decision before printing stdout. `stepId` lets reconciliation return the exact stored result
after an agent loses that stdout `[a4 2]`.

`commits` is **chronological, not grouped** `[a3 27]`. `closeTaskRun` passes the whole
ordered list to `closeTasks` as `commitHashes`, merge entries last, because that is the
order they were made. The closure note labels each with its `kind`, so a reader can still
pick out the published merge commits.

Retry counters are not stored here — they live in the workflow for one run.

### Where run bookkeeping happens `[a1 1, a1 2]`

The claim is at the front of the diagram, so **the atomic claim is the already-active
check** and there is no read-then-write race. Three exits still write nothing: `invalid-number`
(no record anywhere), `not-open` (record is in `completedTasks.json`), and `already-active`
(the record belongs to another invocation).

The success path spells out its bookkeeping in a runnable order: record merge commits →
write exit type completed → record modified files → mark task inactive → clean up → build
the closure note → archive. Recording after clean-up would read a deleted worktree;
recording after archive would write to a task no longer in `tasks.json`.

### The closing state `[a3 2]`

`mark task inactive` runs before clean-up and archive, so for a window of seconds the task
is open and inactive while the first run is still deleting its worktree. A second invocation
could claim it, adopt the same worktree, and race the deletion.

`claimTask` therefore refuses a task that is **closing**: still in `tasks.json`, not active,
and whose newest ended run exited `completed`. That is diagram rule 12. The refusal reports
`status:"closing"`, distinct from `refused`, so the caller can say why.
`test_claimTask_refusesATaskWhoseNewestRunCompletedButIsStillOpen` and
`test_pipeline_refusesASecondClaimBetweenInactivationAndArchive` cover it.

---

## Phase 0 — archive the current implementation as v1_1

Depends on: nothing. Blocks: everything. One agent. No new tests.

Copy, do not move. The copy must still run.

| From | To |
|---|---|
| `skills/tackle-tasks/SKILL.md` | `skills/tackle-tasks-v1_1/SKILL.md` |
| `skills/tackle-tasks/tackle-tasks.workflow.js` | `skills/tackle-tasks-v1_1/tackle-tasks.workflow.js` |
| `skills/tackle-tasks/bootstrap.workflow.js` | `skills/tackle-tasks-v1_1/bootstrap.workflow.js` |
| `skills/tackle-tasks/blockers.workflow.js` | `skills/tackle-tasks-v1_1/blockers.workflow.js` |
| `skills/tackle-tasks/workflow-globals.d.ts` | `skills/tackle-tasks-v1_1/workflow-globals.d.ts` |
| `scripts/tackle-tasks_SkillBodyEmitter.ts` | `scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts` |
| `scripts/tackle-tasks_AgentPromptEmitter.ts` | `scripts/tackle-tasks-v1_1_AgentPromptEmitter.ts` |
| `scripts/tackle-tasks_BootstrapAgentPromptEmitter.ts` | `scripts/tackle-tasks-v1_1_BootstrapAgentPromptEmitter.ts` |
| `tests/tackle-tasks_SkillBodyEmitter.test.ts` | `tests/tackle-tasks-v1_1_SkillBodyEmitter.test.ts` |

**`skills/tackle-tasks-v1_1/SKILL.md`** — `name:` → `tackle-tasks-v1_1`; `description:` →
`frozen v1.1 pipeline, kept runnable while tackle-tasks is rebuilt from plans/diagram/pipeline.mmd`;
emitter path in the `!` block → `tackle-tasks-v1_1_SkillBodyEmitter.ts`.

**`scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts`** — repoint four of its six path constants:
`AGENT_PROMPT_EMITTER_PATH` → `./tackle-tasks-v1_1_AgentPromptEmitter.ts`;
`bootstrapWorkflowPath` → `../skills/tackle-tasks-v1_1/bootstrap.workflow.js`;
`bootstrapAgentPromptEmitterPath` → `./tackle-tasks-v1_1_BootstrapAgentPromptEmitter.ts`;
`skillDir` → `../skills/tackle-tasks-v1_1/`. Leave `blockerVerdictsPath` and
`runMergePhaseUrl` **unchanged** — those are shared library scripts, not pipeline files.

**All three copied scripts** — repoint the CLI guard to the new filename. A renamed file with
the old `endsWith` guard silently prints nothing.

**The copied workflow files** — no edits; they take every path through `args`.

**The copied test** — repoint the import, the `SKILL.md` path it asserts, and every literal
`tackle-tasks_`.

Verify: `node scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts <<< '[1]'` prints a brief with
zero hits for `skills/tackle-tasks/` or `scripts/tackle-tasks_`. Suite green.

---

## Phase 1 — foundations

Depends on: Phase 0. Blocks: Phases 2–8. One agent. Four libraries `[a3 10]`, one explicit
source-lock recovery CLI `[a4 1]`, plus every shared-file edit later phases need.

### 1a. `scripts/tackle-tasks/taskRunState.ts`

The only module that reads or writes `task.run`. No CLI.

```ts
export type ClaimOutcome =
    | { status: "claimed"; state: TaskRunState }
    | { status: "refused"; heldByRunId: string | null }
    | { status: "closing" }
    | { status: "not-found" };

export function getLocalIsoTimestamp(): string
export function readTaskRunState(taskNumber: number, projectRoot: string): TaskRunState
export function getCurrentTaskRun(taskNumber: number, projectRoot: string): TaskRunRecord | null
export function getPreviousTaskRuns(taskNumber: number, projectRoot: string): TaskRunRecord[]
export function claimTask(taskNumber: number, runId: string, projectRoot: string): ClaimOutcome
export function adoptWorktreeLease(taskNumber: number, runId: string, projectRoot: string): { adopted: boolean }
export function updateCurrentTaskRun(taskNumber: number, changes: Partial<TaskRunRecord> & { worktree?: string | null }, projectRoot: string): TaskRunState
export function appendTaskCommits(taskNumber: number, commits: TaskCommit[], projectRoot: string): TaskRunState
export function endTaskRun(taskNumber: number, projectRoot: string): TaskRunState
export function replaceEndedRunOutcome(taskNumber: number, exitType: TaskExitType, exitNote: string, projectRoot: string): TaskRunState
```

`claimTask` decides claim, refusal, closing and not-found **inside one lock window**:

```ts
export function claimTask(taskNumber: number, runId: string, projectRoot: string): ClaimOutcome {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath);
        const task = tasks.find((candidate) => candidate.taskNumber === taskNumber);
        if (task === undefined) return { status: "not-found" };
        const current = getRunState(task);
        if (current.active) {
            const held = current.history[current.history.length - 1] ?? null;
            return { status: "refused", heldByRunId: held?.runId ?? null };
        }
        // Rule 12: inactive is not the same as claimable. A run that exited
        // completed leaves the task closing until its archive lands.
        const newest = current.history[current.history.length - 1];
        if (newest !== undefined && newest.endedAt !== null && newest.exitType === "completed") {
            return { status: "closing" };
        }
        const record: TaskRunRecord = {
            runId, startedAt: getLocalIsoTimestamp(), endedAt: null, exitType: null,
            exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
            taskTests: null, fullSuite: null,
        };
        const state: TaskRunState = { ...current, active: true, history: [...current.history, record] };
        task.run = state;
        writeJsonAtomically(tasksPath, tasks);
        return { status: "claimed", state };
    });
}
```

**`replaceEndedRunOutcome` owns the reopen transition** `[a3 12]`. Rule 10's fourth case —
a failure after `mark task inactive` on the success tail — needs the ended run's outcome
overwritten. Bundling that into `writeTaskExitNotes` would put a lifecycle transition inside
a box defined as writing notes, and would contradict this module being the only owner of
`task.run`. `replaceEndedRunOutcome` does the whole thing under **one** lock: overwrite
`exitType` and `exitNote` on the newest record and re-stamp `endedAt`. It never exposes an
intermediate active state.

**`adoptWorktreeLease` transfers a stale lease to this run** `[a3 17]`. Worktree paths are
stable per task, so a resumed run finds a worktree whose lease belongs to the previous
`runId` — and clean-up would then fail to release it. Adoption is legal only when this run
holds the claim and the lease's owning run has ended, and it rewrites `leaseRunId` plus the
sibling lease file together. **Do not use `recoverStaleTaskWorktreeLease`** — that helper
refuses when the worktree contains the retained work being resumed, which is exactly the
case here. The resumed path calls this immediately after `is the previous run's work
resumable? -- yes`.

Tests: `test_readTaskRunState_returnsEmptyHistoryWhenTaskHasNoRunKey`,
`test_claimTask_appendsARecordWithAStartTimestampAndNoEndTimestamp`,
`test_claimTask_returnsRefusedRatherThanThrowingWhenTheTaskIsActive`,
`test_claimTask_refusesATaskWhoseNewestRunCompletedButIsStillOpen`,
`test_claimTask_isAtomicUnderConcurrentCallers`,
`test_claimTask_keepsEveryEarlierRunInHistory`,
`test_updateCurrentTaskRun_mergesOnlyTheGivenFields`,
`test_updateCurrentTaskRun_throwsWhenNoRunIsActive`,
`test_appendTaskCommits_neverOverwritesEarlierCommits`,
`test_endTaskRun_stampsEndedAtAndClearsActive`,
`test_replaceEndedRunOutcome_overwritesCompletedWithRunFailedInOneWrite`,
`test_replaceEndedRunOutcome_neverLeavesTheRunActive`,
`test_adoptWorktreeLease_transfersAnEndedRunsLease`,
`test_adoptWorktreeLease_refusesWhileTheOwningRunIsStillActive`,
`test_updateCurrentTaskRun_leavesOtherTasksByteIdentical`,
`test_updateCurrentTaskRun_holdsTheTaskStateLockWhileWriting`.

### 1b. `scripts/tackle-tasks/occurrences.ts`

```ts
export type Occurrence = {
    occurrenceId: string;      // "" for root, "sub/a" for a submodule
    checkoutPath: string;      // absolute, inside the worktree
    depth: number;
    baseRef: string;           // THIS layer's own source ref
};

export function getOccurrencesDeepestFirst(worktreePath: string, projectRoot: string, rootSourceBranch: string): Occurrence[]
export function buildOccurrencePath(occurrenceId: string, relativePath: string): string
export function parseOccurrencePath(occurrencePath: string): { occurrenceId: string; relativePath: string }
export function buildOwnedOccurrencePaths(taskFiles: string[], occurrences: Occurrence[]): string[]
export function buildDiscoveryManifest(worktreePath: string, projectRoot: string): DiscoveryManifest
```

**`baseRef` is per layer** `[a2 5]`. Test discovery, the fence and the modified-file record
all diff `<base>...HEAD` inside each checkout, and a submodule's base branch routinely has a
different name from the root's. Resolve each layer's base from the repository manifest,
falling back to that submodule's recorded upstream. All three consumers read
`occurrence.baseRef`, never the root branch name.

**`buildOwnedOccurrencePaths` is the only place the two namespaces meet** `[a2 5]`.
`task.files` holds plain paths; changed paths are `sub/a::tests/foo.test.ts`. Comparing them
directly rejects every legitimate submodule edit. Walk the occurrences
longest-`occurrenceId`-first, strip the matching prefix, re-tag the remainder.

**`buildDiscoveryManifest` is the fix for the manifest type error** `[a1 5]`.
`loadRepositoryManifest` returns a `RepositoryManifest`; `rebaseSubmoduleLayersDeepestFirst`
and `mergeTaskDeepestFirst` both want a `DiscoveryManifest`, which wraps a
`RepositoryManifest` **and** a `ResolutionManifest`. Passing the former is a type error and
leaves `manifest.repositoryManifest` undefined at runtime. Assemble the real thing with
`createEmptyResolutionManifest` from `scripts/resolutionRequests.ts`.

Tests: `test_getOccurrencesDeepestFirst_putsTheRootLast`,
`test_getOccurrencesDeepestFirst_givesEachLayerItsOwnBaseRef`,
`test_buildOccurrencePath_roundTripsThroughParseOccurrencePath`,
`test_buildOwnedOccurrencePaths_convertsANestedOwnedPathIntoOccurrenceNotation`,
`test_buildOwnedOccurrencePaths_prefersTheLongestMatchingOccurrenceId`,
`test_buildDiscoveryManifest_populatesBothSubManifests`.

### 1c. `scripts/tackle-tasks/sourceRepoLock.ts`

The source lock cannot be `withTaskStateLock` `[a2 2]`: that API releases in a `finally` when
its callback returns, so it cannot span later boxes and agent calls, and it locks a derived
path rather than the one it is handed.

```ts
export type LockOwner = string;   // `${runId}:${taskNumber}`
export type LockFile = { owner: LockOwner; acquiredAt: string; heartbeatAt: string };

export type AcquireOutcome =
    | { status: "acquired" }
    | { status: "already-held-by-me" }
    | { status: "held"; owner: LockOwner; heartbeatAt: string }
    | { status: "recoverable"; owner: LockOwner; heartbeatAt: string };

export function buildLockOwner(runId: string, taskNumber: number): LockOwner
export function acquireSourceRepoLock(projectRoot: string, owner: LockOwner): AcquireOutcome
export function refreshSourceRepoLock(projectRoot: string, owner: LockOwner): { refreshed: boolean }
export function recoverSourceRepoLock(projectRoot: string, expectedStaleOwner: LockOwner, confirmation: string): { recovered: boolean; reason: string | null }
export function releaseSourceRepoLock(projectRoot: string, owner: LockOwner): { released: boolean }
export function readSourceRepoLock(projectRoot: string): LockFile | null
```

**The owner token is `runId:taskNumber`, not `runId`** `[a2 2]`. One invocation gives every
task workflow the same `runId`, so a lock keyed on `runId` alone would let task B read task
A's lock as its own and merge concurrently — the exact serialization the lock exists to
provide.

**Liveness is a heartbeat, not a PID** `[a3 1]`. Acquisition and release happen in different
short-lived agent processes, so the acquiring process exits while the workflow legitimately
still holds the lock; its PID proves nothing. Instead, **every green box in the tail calls
`refreshSourceRepoLock` before doing its work.** A lock whose `heartbeatAt` is older than
`STALE_HEARTBEAT_MS` (default 15 minutes — comfortably longer than the slowest single box,
far shorter than a whole tail) is reported `recoverable`.

**`recoverable` is a report, never an automatic action** `[a3 1, a3 19, a4 1]`.
`acquireSourceRepoLock` never takes over. The workflow stops its wait, exits `run-failed`
through the normal chain, and reports the exact owner token plus the maintenance command
below. Recovery re-reads both owner and heartbeat under the same exclusive recovery guard;
it refuses a warm lock or a changed owner and removes only the exact cold lock. A later run
then acquires normally. Elapsed time reports eligibility, but the separate exact operator
confirmation is what authorizes recovery.

`acquireSourceRepoLock` writes with `wx` so creation is atomic. `releaseSourceRepoLock`
deletes only when the recorded owner matches.

Tests: `test_acquireSourceRepoLock_blocksASecondTaskInTheSameRunId`,
`test_acquireSourceRepoLock_isANoOpForTheSameOwner`,
`test_releaseSourceRepoLock_refusesToReleaseAnotherOwnersLock`,
`test_acquireSourceRepoLock_reportsRecoverableRatherThanStealingAColdLock`,
`test_acquireSourceRepoLock_reportsHeldWhileTheHeartbeatStaysWarm` — simulate a slow box by
refreshing across the stale threshold; this is the test that proves a live run is never
taken over,
`test_recoverSourceRepoLock_refusesWhenTheOwnerChangedSinceTheReport`,
`test_sourceRepoLock_survivesAcquireAndReleaseInSeparateProcesses` — spawn two `node`
processes; this is the property `withTaskStateLock` cannot provide.

#### `scripts/tackle-tasks/recoverSourceRepoLock.ts` — maintenance CLI, no diagram box

This is the executable recovery path; the workflow **never calls it**. JSON stdin:

```json
{"projectRoot":"/abs/repo","expectedStaleOwner":"run-id:169","confirmation":"abandon run-id:169"}
```

It requires `confirmation` to equal `abandon ${expectedStaleOwner}` byte-for-byte, then calls
`recoverSourceRepoLock`, which independently validates the same confirmation so importing the
library cannot bypass the operator gate. It prints
`{"status":"recovered"|"refused","owner":"…","reason":str|null}`. A warm heartbeat, owner
change, malformed owner token, or wrong confirmation is `refused` and changes nothing. It
does not acquire the lock for a replacement owner; that keeps manual recovery separate from
normal workflow acquisition.

Tests: `test_recoverSourceRepoLockCli_requiresTheExactConfirmation`,
`test_recoverSourceRepoLockCli_refusesAWarmLock`,
`test_recoverSourceRepoLockCli_refusesWhenTheOwnerChanged`, and
`test_recoverSourceRepoLockCli_allowsTheNextRunToAcquireAfterConfirmedRecovery`.

### 1d. `scripts/tackle-tasks/writeTaskBrief.ts`

```ts
export function renderTaskBrief(taskNumber: number, projectRoot: string): string
export function writeTaskBrief(taskNumber: number, worktreePath: string, projectRoot: string): string
export function configureGeneratedArtifactIsolation(taskNumber: number, worktreePath: string): string[]
```

`renderTaskBrief` is pure and returns the expected bytes by calling the extracted
`renderTaskBriefContent` from `scripts/prepareTasks.ts`. `writeTaskBrief` writes those bytes
and remains the idempotent wrapper around `writeTaskBriefFile`. The pure renderer is what
lets `reconcileStep` compare a brief without rewriting it.

**The brief carries at most the three most recent previous runs** `[a3 30]`. The full
history stays in `tasks.json`; a heavily retried task would otherwise grow a prompt without
bound. When runs are omitted the brief says so: `(4 earlier runs omitted)`.

`configureGeneratedArtifactIsolation` handles the tracked-file half of generated-artifact
isolation `[a4 4]`. In the **linked worktree's own index**, find tracked paths matching the
generated-document patterns and mark them `skip-worktree` before any generated file is
written. It returns the paths it marked. `createTaskWorktree`, `resetTaskWorktree`,
`generateTaskDocs`, and `updateTaskDocs` call it; the last two call it defensively so a
resumed worktree created by an older pipeline is covered. The index is per worktree and is
discarded when that worktree is removed, so the canonical checkout's index is untouched.

### 1e. Edits to `scripts/prepareTasks.ts`

Add `export` to `initializeSubmodulesInWorktree` and to the private helpers Phases 3 and 6
need. Extract and export pure `renderTaskBriefContent(task, repoRoot)` from
`writeTaskBriefFile`; the existing writer calls it, so output stays byte-identical. **Change
no existing behavior** — the v1_1 archive calls this file. Confirm every existing
`prepareTasks` test still passes.

The worktree convention directory has a second consumer, `scripts/mergeTaskWorktrees.ts`,
which derived it independently. Both now call one exported helper; leaving the merge helper on
the old basename-only directory would hide every worktree from recovery and listing.

One behavioral change is required, and it is additive `[a3 18]`: worktree paths are derived
as `/tmp/taskTools-wt/<basename>/task-N`, which collides between two different repositories
that share a basename, and between two clones of one repository. This repository already has
several `taskTools` worktrees. Add a stable eight-character hash of the absolute project
root: `/tmp/taskTools-wt/<basename>-<hash>/task-N`. The branch name stays `task-N` — it is
scoped by its repository already. Guard with
`test_createWorktreeForGroup_doesNotCollideBetweenTwoReposWithTheSameBasename`.

### 1f. The repository `.gitignore`

Add the generated-doc patterns `[a2 7, a3 5, a3 16]`:

```
plans/brief-*.md
plans/plan.json
plans/codex-review.json
plans/test-review.json
plans/implementation-notes-*.md
```

**Generated docs are never committed.** v1 committed them and then `git rm`-ed them during
cleanup, leaving the canonical source checkout staged and dirty at the moment the source lock
was released.

A committed `.gitignore` is the mechanism, **not** `.git/info/exclude`. In a linked worktree
`.git` is a *file*, not a directory, so writing `.git/info/exclude` fails outright — and
`git rev-parse --git-path info/exclude` resolves to the **common repository's** exclude file,
shared by every linked worktree, edited outside every lock, and never cleaned up. A tracked
`.gitignore` rule is one file, written once, correct in every worktree, with no concurrency
and no accumulation.

`.gitignore` covers **new/untracked** generated paths. It does not affect an already tracked
path; this repository currently has tracked `plans/brief-*.md` files. Those are covered by
`configureGeneratedArtifactIsolation`'s per-worktree `skip-worktree` flags `[a4 4]`. Together,
the two mechanisms keep generated docs out of `git status`, `git add -A`, commits, and every
`<base>...HEAD` diff without changing the source checkout's index.

Test with a real linked worktree containing an already tracked `plans/brief-<N>.md`: rewrite
the brief, run the same `git add -A` used by `commitTaskWork`, and prove the path is absent
from status, the staged diff, and the resulting commit. Also prove a newly created
`plans/plan.json` is ignored.

---

## Phase 2 — preflight and run resolution

Depends on: Phase 1. Parallel-safe with Phases 3–8. One agent.

| Diagram box | File | stdout JSON |
|---|---|---|
| — (replaces bootstrap prepare) | `resolveTaskRun.ts` | `{"taskNumbers":[n],"projectRoot":"…","sourceBranch":"…","runId":"…"}` |
| is task number valid? | `isTaskNumberValid.ts` | `{"valid":bool,"location":"open"\|"completed"\|"both"\|null}` |
| is task open? | `isTaskOpen.ts` | `{"open":bool,"closeInProgress":bool}` |
| claim the task | `claimTaskRun.ts` | `{"status":"claimed"\|"refused"\|"closing"\|"not-found","heldByRunId":str\|null}` |
| is task blocked? | `isTaskBlocked.ts` | `{"blocked":bool,"blockers":[{"taskNum":n,"reason":"…"}]}` |

### resolveTaskRun.ts `[a1 3]`

A new file importing what it wants from `scripts/prepareTasks.ts`. It **mutates nothing**.

Bootstrap's `prepare` mode already rejects non-open and blocked tasks, creates and resets
worktrees, takes leases, initialises submodules and writes briefs — five diagram boxes before
preflight, making the `invalid-number`, `not-open` and `blocked` exits unreachable and
leaving `task.run.worktree` unset so `does a worktree exist?` answers false and
`create a worktree` then collides with the lease `prepare` already took.

**Input normalization** `[a3 25]`, all of it before any workflow launches:

- parse integers out of the argument string; **reject** non-integer, zero and negative
  values with a non-zero exit naming the offending token,
- dedupe while preserving first-seen order,
- **reject empty input** — a run with no task numbers is a mistake, not a no-op.

Tests: `test_resolveTaskRun_createsNoWorktree`,
`test_resolveTaskRun_writesNothingToTasksJson`,
`test_resolveTaskRun_returnsEveryRequestedTaskNumberIncludingBlockedOnes`,
`test_resolveTaskRun_dedupesWhilePreservingOrder`,
`test_resolveTaskRun_rejectsEmptyAndMalformedInput`.

### The rest

- `is task number valid?` and `is task open?` use `readTaskLists(projectRoot)`.
- **Presence in both files is `closeInProgress`, not ordinary open** `[a3 28]`. `closeTasks`
  writes `completedTasks.json` before `tasks.json`, so a crash between the two leaves the
  task in both. Treating that as open lets a second invocation claim an already-archived
  task. `is task open?` reports `open:false, closeInProgress:true`, and the workflow exits
  `not-open` with a note naming the partial close so a human can finish it.
- `is task blocked?` uses `blockerReport([taskNumber], projectRoot)`. Do not hand-roll a
  second blocker query — `blockedBy` keys on `taskNum`, and a query looking for `taskNumber`
  silently returns an empty chain.
- `claim the task` passes all four outcomes through `[a2 3]`: `claimed` continues, `refused`
  exits `already-active`, `closing` exits `already-active` with a note saying the task is
  being archived, `not-found` exits `run-failed` — the task was valid and open a moment ago,
  so its disappearance means something else deleted it.

Plus `test_isTaskBlocked_reportsBlockedWhenBlockedByNamesAnOpenTask` and
`test_isTaskOpen_reportsCloseInProgressWhenTheTaskIsInBothFiles`.

---

## Phase 3 — the worktree scripts

Depends on: Phase 1. Parallel-safe with Phases 2, 4–8. One agent.

| Diagram box | File | stdout JSON |
|---|---|---|
| does a worktree exist? | `doesTaskWorktreeExist.ts` | `{"exists":bool,"worktree":str\|null}` |
| create a worktree | `createTaskWorktree.ts` | `{"worktree":str,"branch":str}` |
| is the worktree safe to use? | `checkTaskWorktreeSafe.ts` | `{"safe":bool,"problems":[str]}` |
| is the previous run's work resumable? | `isTaskRunResumable.ts` | `{"resumable":bool,"implementationNotesFile":str\|null,"leaseAdopted":bool}` |
| reset the worktree | `resetTaskWorktree.ts` | `{"worktree":str,"branch":str}` |
| auto generate docs | `generateTaskDocs.ts` | `{"briefFile":str}` |
| update auto generated docs | `updateTaskDocs.ts` | `{"briefFile":str}` |
| amend last exit notes | `amendExitNotesIntoBrief.ts` | `{"briefFile":str,"runsAmended":n}` |
| init submodules recursively | `initTaskSubmodules.ts` | `{"initialized":bool}` |
| record implementation notes file | `recordImplementationNotes.ts` | `{"implementationNotesFile":str}` |

- **does a worktree exist?** reads `readTaskRunState(taskNumber).worktree` and checks the path
  is on disk. A recorded path that has been removed means `exists:false`.
- **create a worktree** wraps `createWorktreeForGroup`, records the path with
  `updateCurrentTaskRun`, records `leaseRunId`, and calls
  `configureGeneratedArtifactIsolation` before the first generated document can be written
  `[a4 4]`.

  **It also runs submodule init, and that is documented, not hidden** `[a3 15]`.
  `createWorktreeForGroup` already calls `initializeSubmodulesInWorktree`, because
  `git worktree add` leaves submodule directories empty and everything downstream needs them
  populated. The diagram's `init submodules recursively` box runs again afterwards; the
  operation is idempotent, so the second run is a no-op returning `initialized:false`. The
  box is not the sole implementation of its action, and a submodule failure surfaces under
  `create a worktree` rather than under `init submodules recursively`.
  `test_initTaskSubmodules_isANoOpAfterCreateTaskWorktree` pins this.
- **is the worktree safe to use?** is structural only: the path opens as a git worktree; HEAD
  is on the task's branch; every submodule in `.gitmodules` is populated. It does **not** look
  at uncommitted changes — under rule 6 the tree is committed at every box that matters, and
  dirty is never by itself unsafe.
- **is the previous run's work resumable?** — the newest ended run has a non-null
  `implementationNotesFile` and that file exists in the worktree. When resumable it
  **immediately calls `adoptWorktreeLease`** and reports `leaseAdopted` `[a3 17]`. Without
  adoption, clean-up later tries to release a lease owned by the previous `runId` and fails.
- **reset the worktree** `[a1 6]` — adopt or release the old lease first, then
  `deleteTaskMergePersistence`, then `removeWorktreeAndBranch`, then `createTaskWorktree`'s
  exported function. Each step idempotent, so a half-finished reset re-runs safely.
- **auto generate docs** and **update auto generated docs** are two files, each two lines
  around `configureGeneratedArtifactIsolation` followed by `writeTaskBrief`, so each diagram
  box has a file, tracked generated paths stay out of the linked-worktree index, and neither
  path can drift.
  `test_generateTaskDocs_andUpdateTaskDocs_produceTheSameBrief`.
- **amend last exit notes** appends one section per previous ended run with an `exitType`,
  newest first, capped at three `[a3 30]`:

  ```
  ## Previous run — 2026-08-12T20:15:03-07:00 (runId abc123)

  Exit type: tests-red
  Exit note: task tests failed after 2 codebase fixes
  Modified files: scripts/foo.ts, sub/a::tests/bar.test.ts
  Implementation notes: plans/implementation-notes-169.md
  ```

  `(none recorded)` where empty; `runsAmended:0` and no write when there is no such run.
  Fresh-worktree path only.
- **init submodules recursively** — `git -C <worktree> submodule update --init --recursive`
  via the newly-exported helper; `{"initialized":false}` when there is no `.gitmodules`.
- **record implementation notes file** `[a1 10]` calls `updateCurrentTaskRun`. It rejects a
  path that does not exist inside the worktree — a recorded path that is not there makes
  `is the previous run's work resumable?` lie.

Tests: `test_checkTaskWorktreeSafe_reportsUnsafeWhenHeadIsOnTheWrongBranch`,
`test_checkTaskWorktreeSafe_reportsSafeWhenTheWorktreeHasUncommittedChanges`,
`test_isTaskRunResumable_returnsFalseWhenTheNotesFileIsRecordedButMissingOnDisk`,
`test_isTaskRunResumable_adoptsThePreviousRunsLease`,
`test_resetTaskWorktree_succeedsWhenRunTwice`,
`test_amendExitNotesIntoBrief_writesOneSectionPerPreviousRunNewestFirst`,
`test_amendExitNotesIntoBrief_capsTheBriefAtThreePreviousRunsAndSaysHowManyWereOmitted`,
`test_generateTaskDocs_hidesAnAlreadyTrackedBriefFromGitAddAll`,
`test_recordImplementationNotes_rejectsAPathThatIsNotInTheWorktree`.

---

## Phase 4 — the plan artifact scripts

Depends on: Phase 1. Parallel-safe with Phases 2, 3, 5–8. One agent.
`plans/plan-format.md` is the complete specification. Read it first.

| Diagram box | File | stdout JSON |
|---|---|---|
| validate the plan file | `validatePlanFile.ts` | `{"valid":bool,"problem":str\|null,"sectionIds":[str]}` |
| validate the codex review and read its verdict | `validateCodexReview.ts` | `{"valid":bool,"problem":str\|null,"verdict":"amend"\|"scrap"\|null,"scrapNotes":str\|null}` |
| script applies codex amendments to the plan | `applyPlanAmendments.ts` | `{"status":"applied"\|"rejected","revision":n,"problem":str\|null}` |

The two validation boxes exist because validation nothing calls is unreachable code
`[a2 6]`. `validate the plan file` runs between `plan the task` and `codex reviews the plan`,
so an unusable plan never costs a codex call and its `invalid` edge feeds the scrap counter.
`validate the codex review and read its verdict` runs before `amend or scrap?`, so **the
branch is driven by the file on disk, not by what the agent said it wrote.**

**`scrapNotes` is how the diagram's `replan with codex notes` edge actually carries notes**
`[a3 13]`. The edge says the second planner gets codex's notes, but nothing was passing them.
`validateCodexReview` returns the validated `notes` string on a `scrap` verdict, and the
workflow puts it in the `plan` role's payload as `preamble`. Without it the replan is
indistinguishable from the first attempt and the scrap loop is theatre.
`test_validateCodexReview_returnsTheScrapNotesForAScrapVerdict`.

### planArtifacts.ts — validate the files, do not trust the claims `[a1 14]`

```ts
export function readAndValidatePlan(planFilePath: string, expectedTaskNumber: number): Plan | PlanProblem
export function readAndValidateReview(reviewFilePath: string): CodexReview | PlanProblem
```

`readAndValidatePlan`: parses; `task` equals the expected number; `revision` is a positive
integer; `sections` is a non-empty array; every `id` unique and matching
`/^[a-z0-9]+(-[a-z0-9]+)*$/`; every section has a string `title` and `body`.
`readAndValidateReview`: `verdict` is `amend` or `scrap`, and an `amend` carries a non-empty
`amendments` array.

### The amendment validation rule, stated once `[a1 13]`

**Simulate the id set in amendment order.** Inserts add their id, removes delete theirs. An
amendment referring to an id not in the set *at that point* rejects the whole batch. An
earlier draft validated against the frozen starting plan and so accepted
remove-then-insert-after, which then inserted at position 0.

```ts
function findAmendmentProblem(plan: Plan, amendments: PlanAmendment[]): string | null {
    if (amendments.length === 0) return "an amend verdict carries no amendments";
    const liveIds = new Set(plan.sections.map((section) => section.id));
    for (const amendment of amendments) {
        if (amendment.op === "insert") {
            if (!liveIds.has(amendment.after)) return `insert names unknown section "${amendment.after}"`;
            if (liveIds.has(amendment.id)) return `insert reuses existing id "${amendment.id}"`;
            liveIds.add(amendment.id);
            continue;
        }
        if (!liveIds.has(amendment.id)) return `${amendment.op} names unknown section "${amendment.id}"`;
        if (amendment.op === "remove") liveIds.delete(amendment.id);
    }
    return null;
}

function applyOneAmendment(sections: PlanSection[], amendment: PlanAmendment): PlanSection[] {
    if (amendment.op === "remove") return sections.filter((section) => section.id !== amendment.id);
    if (amendment.op === "replace") {
        return sections.map((section) => section.id !== amendment.id
            ? section
            : { id: section.id, title: amendment.title ?? section.title, body: amendment.body });
    }
    const insertAt = sections.findIndex((section) => section.id === amendment.after) + 1;
    return [...sections.slice(0, insertAt),
            { id: amendment.id, title: amendment.title, body: amendment.body },
            ...sections.slice(insertAt)];
}

export function applyPlanAmendments(plan: Plan, amendments: PlanAmendment[]): AmendmentResult {
    const problem = findAmendmentProblem(plan, amendments);
    if (problem !== null) return { status: "rejected", problem };
    return { status: "applied", plan: { ...plan, revision: plan.revision + 1,
             sections: amendments.reduce(applyOneAmendment, plan.sections) } };
}
```

Because validation guarantees every `after` is live when its insert runs, `findIndex(...) + 1`
can never silently mean position 0.

`applyPlanAmendments.ts`'s CLI validates both files, **checks `review.verdict === "amend"`**,
applies, and writes the plan back only on `applied`.

Tests: `test_applyPlanAmendments_replaceSwapsTitleAndBodyAndKeepsPosition`,
`test_applyPlanAmendments_insertPlacesTheNewSectionAfterTheNamedSection`,
`test_applyPlanAmendments_removeDropsTheNamedSection`,
`test_applyPlanAmendments_incrementsRevisionExactlyOncePerBatch`,
`test_applyPlanAmendments_rejectsTheWholeBatchWhenAnyIdIsNotInThePlan`,
`test_applyPlanAmendments_rejectsTheWholeBatchWhenAnInsertReusesAnExistingId`,
`test_applyPlanAmendments_rejectsAnEmptyAmendmentList`,
`test_applyPlanAmendments_rejectsInsertingAfterASectionRemovedEarlierInTheBatch`,
`test_applyPlanAmendments_rejectsReplacingASectionRemovedEarlierInTheBatch`,
`test_applyPlanAmendments_allowsReplacingASectionInsertedEarlierInTheBatch`,
`test_applyPlanAmendments_appliesAmendmentsInTheOrderGiven`.

---

## Phase 5 — the test-running scripts

Depends on: Phase 1. Parallel-safe with Phases 2–4, 6–8. One agent.

| Diagram box | File | stdout JSON |
|---|---|---|
| run task tests | `runTaskTests.ts` | `{"stepId":str,"passed":bool,"testFiles":[str],"createdTestFiles":[str],"missingTests":bool,"output":str}` |
| run the full suite | `runFullSuite.ts` | `{"stepId":str,"passed":bool,"layers":[{"occurrenceId":str,"passed":bool}],"output":str}` |

### Which tests are the task's tests

The commit box runs first, so the tree is clean and `git status --porcelain` reports nothing.
Discovery is against the branch, in **every layer** `[a1 9]`:

```
for each occurrence from getOccurrencesDeepestFirst(worktree, projectRoot, sourceBranch):
    git -C <occurrence.checkoutPath> diff --name-status <occurrence.baseRef>...HEAD
```

`--name-status`, not `--name-only` `[a3 21]`. The status letter is the difference between a
test this branch **created** (`A`) and a pre-existing test it **modified** (`M`), and that
distinction controls whether `amend the tests` may touch it. `testFiles` is everything;
`createdTestFiles` is the `A` subset. The `amend-tests` prompt receives both and applies the
diagram's rule-3 exception deliberately, rather than treating every changed test as its own.

`occurrence.baseRef`, never the root `sourceBranch` `[a2 5]`.

Keep the paths matching `tests/**/*.test.ts`, tag each with `buildOccurrencePath`, and run
`node --test` **inside each occurrence's own checkout** over that occurrence's files.

Reading the branch rather than the working tree is what makes the gate work: by the time this
runs, the commit box has swept the tree, so a script reading uncommitted changes would find
nothing and report `passed:true` on a broken task.

### An empty set is not automatically a pass `[a1 21]`

- `task.tests` absent or `"skip"` → empty set is `passed:true, missingTests:false`.
- `task.tests` set to anything else → `passed:false, missingTests:true`, with `output` reading
  `the task declares tests but the branch added none`. The workflow treats that as a red test
  run. A suite that was already green stays green when a task adds nothing, so the full suite
  cannot catch this.

### run the full suite is occurrence-aware too `[a3 4]`

Diagram rule 8 covers every box that touches the working tree, and an earlier draft had this
one running `npm test` in the root only. That is a real hole: a `fix the codebase` repair
during the suite loop can edit a submodule, after which the box tests only the root and the
red submodule surfaces later under merge-failure semantics instead of returning to the fix
loop where it belongs.

Walk the same occurrences, deepest first, run each layer's complete-suite policy from
`discoverTestPolicy`, aggregate the output, and fail if **any** layer is red. `layers` reports
per-layer results so the exit note can name the guilty one.

**A layer with no discoverable suite uses the same rule the rebase box uses** `[a3 20]`:
`discoverTestPolicy` returning `needsResolution` is an operational failure, exit non-zero →
`run-failed`. One rule across both boxes; guessing a command for an unknown layer is how a
green run gets reported on an untested repository.

`output` is combined stdout and stderr, truncated to the **last** 8000 characters. Never
`bun test`.

Both scripts require a workflow-derived `stepId` on stdin and record their **entire stdout
decision** plus `checkedAt` with `updateCurrentTaskRun` before printing it — `taskTests` and
`fullSuite` respectively `[a3 6, a4 2]`. The workflow creates a new `stepId` for each logical
visit to TT or FULL and preserves it while reconciling that visit. These scripts are
mutating, not read-only: a lost result is recovered by reading the matching stored `stepId`
and returning its stored decision, never by running the tests again.

Tests: `test_runTaskTests_selectsTestFilesTheBranchAddedSinceTheSourceBranch`,
`test_runTaskTests_ignoresATestFileThatIsOnTheSourceBranch`,
`test_runTaskTests_stillSelectsTheTestsWhenTheWorktreeIsClean`,
`test_runTaskTests_separatesCreatedTestsFromModifiedExistingTests`,
`test_runTaskTests_findsATestFileInsideASubmodule`,
`test_runTaskTests_runsASubmodulesTestsInsideThatSubmodule`,
`test_runTaskTests_reportsMissingTestsWhenTheTaskDeclaresTestsAndTheBranchAddedNone`,
`test_runTaskTests_recordsItsWholeDecisionBeforePrinting`,
`test_runFullSuite_failsWhenASubmoduleSuiteIsRedAndTheRootIsGreen`,
`test_runFullSuite_reportsRunFailedWhenALayerHasNoDiscoverableSuite`,
`test_runFullSuite_recordsItsWholeDecisionBeforePrinting`.

---

## Phase 6 — commit, rebase, advance, fence, merge, record, clean

Depends on: Phase 1. Parallel-safe with Phases 2–5, 7, 8. One agent, and the most careful one.

Every function named below already exists in `scripts/mergeTaskWorktrees.ts`. This phase
writes wrappers so the workflow can call them as scripts, per diagram rule 1.

| Diagram box | File | stdout JSON |
|---|---|---|
| commit if needed ×2 | `commitTaskWork.ts` | `{"commits":[{"occurrenceId":str,"hash":str,"kind":str}]}` |
| lock the source repo, then rebase + did the rebase report conflicts? | `rebaseTaskWorktree.ts` | `{"lock":"acquired"\|"held"\|"recoverable","conflicted":bool,"stoppedAt":{"occurrenceId":str,"checkoutPath":str}\|null,"conflictedFilePaths":[str],"failureReason":str\|null}` |
| advance the rebase + is the rebase finished? | `advanceTaskRebase.ts` | `{"finished":bool,"conflicted":bool,"stoppedAt":{…}\|null,"conflictedFilePaths":[str],"failureReason":str\|null}` |
| did every change stay inside the task's owned files? | `checkTaskFileFence.ts` | `{"inside":bool,"violations":[str]}` |
| merge worktrees and submodules, no fast-forward + did the merge land? | `mergeTaskWorktree.ts` | `{"merged":bool,"commits":[…],"failureReason":str\|null}` |
| record merge commit hashes to tasks.json | `recordMergeCommits.ts` | `{"commits":[…]}` |
| clean up worktrees, leases, persistence refs and source lock | `cleanupTaskWorktree.ts` | `{"removed":bool,"retainedArtifacts":[str]}` |

**Every script in this phase calls `refreshSourceRepoLock` before doing its work**, from the
rebase box onward. That heartbeat is what makes rule 9's recovery safe `[a3 1]`.

### commitTaskWork.ts, occurrence-aware `[a1 9]`

First calls `configureGeneratedArtifactIsolation` defensively `[a4 4]`, then walks
`getOccurrencesDeepestFirst`. For each dirty layer: stage everything, commit, then stage the
resulting gitlink in the parent so the parent's own commit picks it up. The root commits last,
capturing every gitlink bump beneath it. v1's `implementCommitSteps` in the v1_1 emitter is
the working reference for the gitlink walk.

Two rules:

1. **Clean layer, no commit.** All layers clean returns `{"commits":[]}` and the pipeline
   continues. That is what makes the box "if needed" — optionality lives in the script, not
   in a diamond.
2. **The message is derived, never passed in.** No commits on the run record yet → this is the
   work: `task <N>: <task title>`, `kind:"work"`. Otherwise → `task <N>: fixed code making
   tests fail`, `kind:"repair"`. Then `appendTaskCommits`.

Deriving rather than accepting the message keeps the history honest — the workflow cannot
mislabel a repair as work, because it never gets to choose.

Both boxes, three entry edges each:

| Box | Entered from |
|---|---|
| before `run task tests` | `record implementation notes file`, `fix the codebase` (task-test loop), `amend the tests` |
| before `advance the rebase` | `did the rebase report conflicts? -- no`, `fix conflicts`, `fix the codebase` (suite loop) |

### rebaseTaskWorktree.ts and the source lock

Acquire with `buildLockOwner(runId, taskNumber)`, then **re-read the source tip**. Several
task workflows run at once; without this they rebase against a moving tip and merge into the
same checkout concurrently. Per-task `active` flags do not serialize different tasks.

**Acquisition is re-entrant for the same owner** — `did the merge land? -- no, 1st time`
routes back into this box while the lock is held, so `already-held-by-me` returns
immediately. Without that, the merge retry deadlocks against itself.

**Waiting is bounded and reported, not open-ended** `[a3 24, a4 1]`. An earlier draft said the
script waits, with no interval, timeout, or status — and a workflow tool call can time out
before the owner releases. Instead: poll every 10 seconds for at most 2 minutes, then
**return** `lock:"held"` or `lock:"recoverable"` rather than failing. The workflow logs which
owner holds it. A warm `held` result re-enters the box; re-entry is cheap and read-only until
the lock is free. A cold `recoverable` result does **not** loop forever: it exits `run-failed`
through the normal chain and prints the exact confirmed-recovery command from §1c. The
workflow never performs that recovery automatically.

Then rebase every layer with `rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true,
null)` and `rebaseParentOntoSourceAndTest(...)`, with `manifest` from
`buildDiscoveryManifest`, **not** `loadRepositoryManifest` `[a1 5]`. `leaveConflictLive =
true` so the conflict agent gets live markers.

**These helpers do more than the diagram's box, and that is accepted, not hidden** `[a1 5]`.
`typecheckCommand = null` disables only the optional typecheck; both still discover and run
each layer's complete-suite policy. Map every status:

| Helper status | Returns |
|---|---|
| `rebased-and-tested`, `no-op` | `conflicted:false` |
| `conflicted` | `conflicted:true`, `stoppedAt` = that layer's `{occurrenceId, checkoutPath}`, `conflictedFilePaths` relative to **that layer** |
| `tests-failed` | `conflicted:false`, `failureReason` = failed check and output. The workflow treats it as a red full suite and goes round the suite fix loop. |
| `cleanup-failed`, `source-sync-failed`, `untested` | operational failure, exit non-zero → `run-failed` |

### advanceTaskRebase.ts `[a2 4]`

The copied `mergeConflictBrief` stages resolutions and explicitly tells the agent **not** to
run `git rebase --continue`, leaving that to its caller — and no box called it. A staged
resolution is not a finished rebase, and continuing can surface the next conflict; without
this box the full suite could run with rebase metadata still live.

Runs `git rebase --continue` in the stopped layer, repeatedly, until the rebase finishes or
stops again. `finished:true` means no rebase is in progress in **any** layer — verify with
`rebaseInProgress(checkoutPath)` per layer, not by trusting an exit code. A new conflict
returns `finished:false, conflicted:true` with its own `stoppedAt`, routed back to
`did the rebase report conflicts?`, so the same 2-attempt cap governs it.

**`stoppedAt` is why both schemas carry the layer** `[a2 4]`. Without it the conflict agent
does not know which repository owns its paths and this script does not know where to
continue. Two layers can hold the same relative path.
`test_advanceTaskRebase_distinguishesTheRootAndASubmoduleWithTheSameConflictPath`.

Reuse `continueRebaseChecked` and `abortRebaseChecked` from the v1_1 emitter.

### checkTaskFileFence.ts `[a1 15]`

Computed, never claimed. `changedPaths` from a fix agent is self-reported and an omitted path
walks straight through. Diff every layer against `occurrence.baseRef...HEAD`, tag with
`buildOccurrencePath`, compare against `buildOwnedOccurrencePaths(task.files, occurrences)`.
**Both sides go through the conversion** `[a2 5]` — comparing the two namespaces directly
rejects every legitimate submodule edit.

**A violation always exits; there is no in-run widening** `[a3 22]`. An earlier draft
referred to "the same widening path v1 used", which v1.5 does not have. It stays that way
deliberately: widening `task.files` mid-run would let an agent enlarge its own fence, and no
box or user gate in this diagram can approve it. The run exits `fence-violation` with the
offending paths in the note, a human updates `task.files`, and the next run proceeds. That is
slower and it is the only version that cannot be gamed.

### mergeTaskWorktree.ts

`mergeTaskDeepestFirst(worktreePath, manifest)`. As with the rebase, this helper rebases and
tests each layer before merging it — documented, not a thin merge `[a1 5]`.

**Immediately before merging, re-verify the source checkout** `[a3 29]`. The lock serializes
v1.5 tasks against each other, but ordinary user git operations and other skills do not honor
it, so a source checkout can move or go dirty while the lock is held. Confirm the source
branch is where the rebase left it and its checkout is clean; if not, exit non-zero →
`run-failed` naming what moved. **Never merge over unrelated dirty changes.**

| Status | Returns |
|---|---|
| `merged` | `merged:true`, `commits` = every non-null `mergedCommitOid` with its `occurrenceId`, `kind:"merge"` |
| `submodule-conflicted`, `parent-conflicted`, `merge-record-missing` | `merged:false` with `failureReason` |
| `root-merged-but-not-closed` | `merged:true` with `failureReason` set — the merge landed, so do not retry it. **Include its `mergedCommitHash` as the root merge commit**, deduped against `completedLayers`, which for this status can omit the root `[a3 14]`. |

**Never fast-forward.** Confirm `mergeGroupBranchIntoRepo` passes `--no-ff` before relying on
it. `test_mergeTaskWorktree_createsAMergeCommitWithTwoParents`.

### recordMergeCommits.ts `[a3 7]`

The diagram's `record merge commit hashes to tasks.json` box had no script — the plan said
`appendTaskCommits` exists and the merge returns commits, but nothing connected them, and an
import-free workflow cannot call a library. Without it the archived run loses every merge
commit and `closeTaskRun` has nothing to pass.

Takes the merge result's `commits` on stdin and calls `appendTaskCommits`.
**Appends, never overwrites** — the record already holds this run's work and repair commits.
`test_recordMergeCommits_keepsTheWorkAndRepairCommitsThatCameBefore`.

### cleanupTaskWorktree.ts `[a1 6, a2 7, a3 23]`

Order matters, and this order is the fix for a stranding bug: **release ownership last.**

1. Delete generated docs from disk. No `git rm`, no commit — they were never committed
   (§1f).
2. `deleteTaskMergePersistence` **for every source occurrence, not just the root** `[a2 7]`.
   `mergeTaskDeepestFirst` writes merge-intent and merged-commit refs in every merged source
   submodule; leaving them corrupts retained-artifact reporting and misleads the next run.
3. `removeTaskWorktreeAndBranches(...)`, reporting leftovers with
   `collectRetainedTaskArtifacts(...)`.
4. `releaseTaskWorktreeLease({worktreePath, runId})`.
5. `releaseSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber))`.

An earlier draft released the lease at step 2. If removal then failed, the task retained work
with **no ownership marker at all**, and another process could take it. Holding ownership
until the destructive work has actually succeeded is the point `[a3 23]`.

Needs `runId` and `taskNumber` on stdin — a cleanup without them cannot prove it owns the
lease or the lock.

Tests: one per script on real temp repositories with a real submodule, plus
`test_commitTaskWork_commitsDeepestFirstAndBumpsTheParentGitlink`,
`test_commitTaskWork_returnsNoCommitsWhenEveryLayerIsClean`,
`test_commitTaskWork_usesTheWorkKindForTheFirstCommitAndRepairForEveryLater`,
`test_rebaseTaskWorktree_reacquiringItsOwnSourceLockIsANoOp`,
`test_rebaseTaskWorktree_returnsHeldRatherThanBlockingForeverOnAnotherOwner`,
`test_advanceTaskRebase_reportsFinishedOnlyWhenNoLayerHasARebaseInProgress`,
`test_checkTaskFileFence_acceptsAnOwnedPathInsideASubmodule`,
`test_checkTaskFileFence_reportsAViolationForAPathTheAgentDidNotDeclare`,
`test_mergeTaskWorktree_refusesWhenTheSourceCheckoutWentDirty`,
`test_cleanupTaskWorktree_keepsTheLeaseWhenWorktreeRemovalFails`,
`test_cleanupTaskWorktree_leavesEverySourceCheckoutClean`,
`test_cleanupTaskWorktree_deletesPersistenceRefsInEverySourceOccurrence`,
`test_cleanupTaskWorktree_succeedsWhenRunTwice`.

---

## Phase 7 — the exit chain and the close chain

Depends on: Phase 1. Parallel-safe with Phases 2–6, 8. One agent.

| Diagram box | File | stdout JSON |
|---|---|---|
| write exit type and exit notes / write exit type completed | `writeTaskExitNotes.ts` | `{"exitType":str,"exitNote":str}` |
| record modified files ×2 | `recordTaskModifiedFiles.ts` | `{"modifiedFiles":[str]}` |
| mark task inactive ×2 | `markTaskInactive.ts` | `{"active":false,"endedAt":str}` |
| release the worktree lease and the source lock if held | `releaseTaskRunHolds.ts` | `{"leaseReleased":bool,"lockReleased":bool}` |
| build the closure note from the recorded run | `buildClosureNote.ts` | `{"closureNote":str}` |
| move task to completedTasks.json and update tasks blocked by it | `closeTaskRun.ts` | `{"closed":[n],"skipped":[n],"unblocked":[n]}` |

- **write exit type and exit notes** validates against the thirteen-member union and exits
  non-zero on anything else. An unlisted exit type is a workflow bug and failing loudly is how
  it gets found. Normally it calls `updateCurrentTaskRun`; with `reopen:true` it calls
  `replaceEndedRunOutcome` instead, which owns the whole transition under one lock `[a3 12]`.
- **record modified files** walks every occurrence and diffs `occurrence.baseRef...HEAD`,
  storing occurrence-prefixed paths. It runs **before** clean-up on both chains. It does
  **not** call `addTaskFiles` — `task.files` is the ownership fence and must not grow because
  a run touched something.

  **No worktree is a valid input, and an empty result never overwrites a real one**
  `[a2 3, a3 26]`. The `blocked` exit fires before any worktree exists, and the recovery chain
  can run after clean-up already deleted one. A missing worktree returns
  `{"modifiedFiles":[]}` and exits zero — **and leaves any existing non-empty record
  untouched.** Overwriting would erase the successful path's evidence at exactly the moment a
  human needs it. A throw here would strand the task `active:true`, which is what the exit
  chain exists to prevent.
- **mark task inactive** calls `endTaskRun`.
- **release the worktree lease and the source lock if held** releases only what
  `runId`/`taskNumber` owns and reports what it found. Clean-up already does this on the
  success path, which is why the success chain has no such box.
- **build the closure note** is deterministic — no agent, nothing re-verified. It reads the
  finished run record:

  ```
  Task 169 completed.

  Commits:
    a1b2c3d  sub/a   work
    e4f5g6h  (root)  work
    9i8j7k6  (root)  merge
  Modified files: scripts/foo.ts, sub/a::tests/bar.test.ts
  Task tests: 4 files, green
  Full suite: green
  ```

  Every value comes from a field some earlier box wrote — `commits`, `modifiedFiles`,
  `taskTests`, `fullSuite` `[a3 6]`. Nothing is re-derived, which is what lets this run after
  the worktree is deleted. A null `taskTests` or `fullSuite` renders `(not recorded)` rather
  than failing.

  This replaces `closeTasksBrief.ts` `[a2 8]`, whose prompt re-runs verification, investigates
  git history, fixes files and stages work — none of which can happen in a green box after
  clean-up.
- **move task to completedTasks.json and update tasks blocked by it** wraps
  `closeTasks(taskNumbers, closureNote, projectRoot, commitHashes)` **once** and returns its
  `{closed, skipped, unblocked}`. `closeTasks` calls `unblockDependents` internally, which is
  why the diagram's two boxes are one `[a2 8]`. This wrapper is what gives `closeTasks`'s
  positional CLI the stdin/JSON contract every other green box has.

  A retry after the archive-first partial state is intentional `[a4 3]`: if the task is in
  both files, pass the closure note and hashes already stored in `completedTasks.json` back to
  `closeTasks`. Its upsert is idempotent and the second write finishes removal from
  `tasks.json`. A close is successful only when the archived record matches and the open
  record is absent.

Tests: `test_writeTaskExitNotes_exitsNonZeroOnAnUnknownExitType`,
`test_writeTaskExitNotes_reopensAnAlreadyEndedRunWhenReopenIsSet`,
`test_recordTaskModifiedFiles_doesNotChangeTheTasksOwnedFilesList`,
`test_recordTaskModifiedFiles_includesPathsChangedInsideASubmodule`,
`test_recordTaskModifiedFiles_leavesAnExistingRecordAloneWhenTheWorktreeIsGone`,
`test_markTaskInactive_leavesTheExitNotesAndModifiedFilesInPlace`,
`test_releaseTaskRunHolds_leavesALeaseHeldByAnotherOwnerAlone`,
`test_buildClosureNote_namesEveryCommitIncludingSubmoduleOnes`,
`test_buildClosureNote_rendersNotRecordedWhenATestResultIsMissing`,
`test_buildClosureNote_runsWithoutAWorktree`,
`test_closeTaskRun_archivesAndUnblocksInOneCall`.

---

## Phase 8 — the transition table, the retry policy, and reconciliation

Depends on: Phases 4–7. Blocks: Phase 10. One agent. Two scripts and their tests.

### Non-happy transitions `[a1 12]`

Throwing strands the task `active:true`; picking a nearby exit type changes the spec.

| Result | Transition | Exit type |
|---|---|---|
| plan file fails validation | counts as a scrap | `plan-scrapped` on the second |
| review file fails validation | counts as a scrap | `plan-scrapped` on the second |
| amendments rejected | counts as a scrap | `plan-scrapped` on the second |
| `implemented:false`, or `remaining` non-empty | continue to the tests; they decide | — |
| task tests red, `fixed:false` | stop looping immediately | `tests-red` |
| `amended:false` | stop looping immediately | `tests-flagged` |
| suite red, `fixed:false` | stop looping immediately | `suite-red` |
| rebase helper returns `tests-failed` | treat as a red full suite | `suite-red` on the cap |
| `resolved:false` from fix-conflicts | advance anyway; the advance box reports whether it worked | `rebase-stuck` on the cap |
| fence violation | exit at once, no retry | `fence-violation` |
| `closing` or `refused` from claim | exit at once | `already-active` |
| `not-found` from claim | exit at once | `run-failed` |
| any script exits non-zero | exit at once — see the four cases | `run-failed` |

`fixed:false` and `amended:false` short-circuit rather than burning the remaining attempt: an
agent that reports it changed nothing will report the same thing next time.

### Retry counters, in pseudocode `[a1 19]`

Every counter counts repair attempts made, checked before spending one, so the diagram's
"after 2 attempts" means the same thing everywhere.

```
planScraps = 0
on scrap:            planScraps += 1; if planScraps >= 2 -> exit plan-scrapped; else replan with scrapNotes
testFixes = 0
on red task tests:   if testFixes >= 2 -> exit tests-red; else testFixes += 1; fix
testAmendments = 0
on flagged tests:    if testAmendments >= 2 -> exit tests-flagged; else testAmendments += 1; amend
conflictFixes = 0
on rebase conflict:  if conflictFixes >= 2 -> exit rebase-stuck; else conflictFixes += 1; fix
suiteFixes = 0
on red full suite:   if suiteFixes >= 2 -> exit suite-red; else suiteFixes += 1; fix
mergeAttempts = 0
on failed merge:     mergeAttempts += 1; if mergeAttempts >= 2 -> exit merge-failed; else rebase and retry
```

The tests-flagged loop permits two amendments and exits on the third flag; plan-scrap and
merge exit on the second event, matching their exit-note wording.

### `greenBoxPolicy.ts` — which boxes may be retried `[a1 7]`

A null agent result proves the harness returned nothing, not that the command never ran.

- **Read-only** — `is task number valid?`, `is task open?`, `is task blocked?`,
  `does a worktree exist?`, `is the worktree safe to use?`, the fence check, both validators,
  `build the closure note`, and the resolver. Retried up to three times.
- **Mutating** — everything else dispatched by the workflow, **including both test boxes
  because they write their durable decisions to `task.run`** `[a4 2]`. Never blindly retried.
- **Maintenance-mutating** — `recoverSourceRepoLock.ts`. It is run directly by an operator,
  never by an agent or the workflow, so agent-result reconciliation does not apply.

A map from script name to `"read-only" | "mutating" | "maintenance-mutating"`, with
`test_greenBoxPolicy_namesEveryScriptInTheScriptsDirectory` asserting the map and the
directory agree. A second test asserts every `"mutating"` workflow entry has a
`reconcileStep` handler and that the maintenance entry is absent from workflow source. A new
script with no entry fails the suite.

### `reconcileStep.ts` — what a lost mutating result actually means `[a3 3, a3 8]`

"Do not retry" prevents double mutation but leaves the outcome unknown, and an earlier draft
went straight to `run-failed`. That is wrong in both directions: a lost `closeTaskRun` result
whose archive succeeded cannot be reopened, because the task is no longer in `tasks.json`; a
lost `applyPlanAmendments` result may have amended the plan the run then abandons.

So diagram rule 11: **before a lost mutating result becomes `run-failed`, the workflow runs a
read-only reconciliation that reads the world and decides whether the step already happened.**
The workflow supplies the original input and its logical `stepId`. `reconcileStep.ts` returns
`{"status":"completed"|"not-completed"|"ambiguous","result":object|null}`. A completed
check reconstructs the box's stdout in `result`, so the workflow can take the correct edge
without rerunning the mutation `[a4 2]`.

One handler covers every mutating workflow script:

| Lost step | Reconciliation reads | Completed if |
|---|---|---|
| `claimTaskRun` | `task.run` | active with this `runId` |
| `createTaskWorktree` | `task.run`, worktree, branch and lease | the recorded worktree is structurally valid and both lease records name this run |
| `isTaskRunResumable` | prior notes plus both lease records | the resumable verdict can be recomputed and, when true, both leases name this run |
| `resetTaskWorktree` | worktree, branch, lease and persistence refs | a fresh safe task branch exists for this run and old persistence is gone |
| `generateTaskDocs` / `updateTaskDocs` | brief bytes and generated-path index flags | the expected brief exists and every tracked generated path is isolated |
| `amendExitNotesIntoBrief` | prior-run headings in the brief | every intended `runId` heading occurs exactly once; a partial or duplicate set is `ambiguous` |
| `initTaskSubmodules` | `.gitmodules` and every submodule checkout | every declared submodule is populated recursively |
| `recordImplementationNotes` | `task.run` | the field is set to the intended existing path |
| `applyPlanAmendments` | `plan.json` | `revision` already incremented past the value read before the call |
| `commitTaskWork` | each layer's `git log` and the run record | every derived commit is at HEAD and its hash is on the record |
| `runTaskTests` / `runFullSuite` | the corresponding run field | its `stepId` matches; return the stored decision as `result` |
| `rebaseTaskWorktree` / `advanceTaskRebase` | `rebaseInProgress` per layer, and each HEAD | no rebase in progress and HEAD moved |
| `mergeTaskWorktree` | `findRecordedMergedCommit(repoRoot, operationBranch)` per occurrence | a merged commit is recorded |
| `recordMergeCommits` | `task.run.commits` | merge-kind entries present |
| `recordTaskModifiedFiles` | `task.run.modifiedFiles` and the worktree when present | the stored occurrence paths equal the recomputed paths, or the retained non-empty record is authoritative after cleanup |
| `cleanupTaskWorktree` | the worktree path, the lease, the refs, the lock | all gone |
| `writeTaskExitNotes` / `markTaskInactive` | `task.run` | the field already has the intended value |
| `releaseTaskRunHolds` | worktree lease and source lock | neither hold is owned by this run |
| `closeTaskRun` | **both task files** | the task is in `completedTasks.json` with this run's commits **and absent from `tasks.json`** `[a4 3]` |

Every check is read-only, so it is itself retryable. `completed` continues down the normal
edge using the reconstructed `result`. `not-completed` reruns the step only where the handler
has proved that rerun is idempotent from the observed state. **`ambiguous` is the only path
to `run-failed`**, and its note names what could not be determined.

Two partial states have explicit repair behavior. If a derived git commit is at HEAD but its
hash is absent from the run record, rerunning `commitTaskWork` appends that existing hash and
does not create another commit. If close is present in **both** task files, it is
`not-completed`; rerunning idempotent `closeTasks` upserts the archive and finishes removal
from `tasks.json` `[a4 3]`.

The `closeTaskRun` row is the one that matters most `[a3 3]`: without it a successful archive
followed by a lost result reports `run-failed` and then tries to reopen a task that is no
longer there.

Fault-injection tests, one per row, dropping the result after the mutation has landed:
`test_reconcileStep_recognizesACompletedArchiveAfterALostResult`,
`test_reconcileStep_recognizesAnAlreadyAppliedAmendment`,
`test_reconcileStep_returnsAStoredTaskTestDecisionWithoutRunningTestsAgain`,
`test_reconcileStep_recognizesACreatedWorktreeAndAdoptedLease`,
`test_reconcileStep_recognizesALandedMergeFromItsPersistenceRef`,
`test_reconcileStep_recognizesACompletedCleanup`,
`test_reconcileStep_reportsNotCompletedForAnArchivePresentInBothTaskFiles`,
`test_greenBoxPolicy_hasAReconciliationHandlerForEveryMutatingWorkflowScript`,
`test_reconcileStep_reportsAmbiguousRatherThanGuessing`.

### Finalizing a `run-failed`, in four cases `[a2 3]`

| Where it failed | What runs |
|---|---|
| before the claim | **nothing.** Report and stop; there is no run record. |
| claimed, no worktree yet | the full chain; `record modified files` returns `[]`. |
| claimed, worktree present | the full chain, unchanged. |
| after `mark task inactive` on the success tail | `writeTaskExitNotes({reopen:true})` → `replaceEndedRunOutcome`, which overwrites `completed` with `run-failed` and re-ends the run in one write. |

Wherever a chain runs at all, it ends with `release the worktree lease and the source lock if
held`. A `run-failed` that leaks the lock blocks every later task.

---

## Phase 9 — `scripts/tackle-tasks/AgentPromptEmitter.ts`

Depends on: Phases 4, 5. Blocks: Phase 10. One agent.

Governed by `workflow-only-context-injection.md` §2 and §6: the emitter is the only place
that imports data scripts, and every prompt interpolates its data last.

`node AgentPromptEmitter.ts <taskNumber> <role>`, JSON payload on stdin with at minimum
`{worktree, projectRoot, sourceBranch, runId}`. Unknown role exits 1.

Eight roles, one per yellow box.

### Copy the v1_1 prompts; where copying is impossible, the diagram wins `[a2 16]`

Copy the text — the current prompts are barely tested and rewriting discards what testing they
have had. Four of them contradict the new contracts, so the prompt is edited to match:

| Role | Copy from | Change |
|---|---|---|
| `plan` | `plannerBrief` | write `plan.json` per `plans/plan-format.md`; accept an optional `preamble` carrying codex's scrap notes |
| `review-plan` | `codexPrompt` + `verifierBrief` | return `codex-review.json` instead of APPROVED/REJECTED prose |
| `implement` | `workerBrief` | **drop its commit steps** — the commit box owns committing, and rule 1 says git goes through a script |
| `fix-conflicts` | `mergeConflictBrief` | **drop its `git add` lines**; return `{resolved, unresolvedPaths}`; keep "do not run `git rebase --continue`", now correct because `advance the rebase` does it |
| `fix-suite` | `rebaseFixBrief` | **remove its permission to edit the failing test** and **its self-commit** |
| `fix-tests` | `rebaseFixBrief` | same two removals, retargeted at the task's own tests |
| `review-tests` | `verifierBrief`'s command scaffolding | new review question, existing fallback chain |
| `amend-tests` | `applyFeedbackBrief` | retarget at test files |

Extract the **codex command and its fallback chain** — v1_1 lines 160-200 — into one shared
helper so the two review roles cannot drift. Verbatim: `codex exec -s read-only <prompt>`,
then `claude -p <prompt> --tools "Read" --model fable --effort medium`, then
`claude -p <prompt> --tools "Read" --model claude-opus-4-8 --effort high`, with the "a
non-zero exit is unavailability, not a verdict" paragraph and the rule that a fallback is
never reported as codex.

Carry `loadPreparedTask()` across with paths updated: brief `<worktree>/plans/brief-<N>.md`,
plan `<worktree>/plans/plan.json`, review `<worktree>/plans/codex-review.json`, test review
`<worktree>/plans/test-review.json`.

### New prompt text, and only this much

- **`plan`** — `plan.json` per the format: ids stable, lowercase, kebab-case, unique. Codex
  addresses sections by id and a renamed id orphans its feedback. When a `preamble` is
  present it is codex's reason for scrapping the previous plan; address it `[a3 13]`.
- **`review-plan`** — return `codex-review.json`; `verdict` is `amend` or `scrap`; an `amend`
  names at least one existing section id. Never edit the plan.
- **`review-tests`** — review the tests against the brief and the plan, nothing else.
  `flagged:true` only when a test is wrong about what the task asked for. **Never run the
  tests.**
- **`fix-suite` / `fix-tests`** — edit source, never tests; the fix lands inside `ownedFiles`;
  do not commit.
- **`amend-tests`** — the only role that may edit tests. It receives `createdTestFiles` and
  `testFiles` separately `[a3 21]`: files it created are freely editable; a **modified
  pre-existing** test may be changed only when it is broken or asserts nothing, which is the
  diagram's rule-3 exception applied deliberately rather than assumed. Do not commit.

### What each role returns, and why

Every field picks a diagram edge or feeds a rule check. Agent-claimed file lists are
**advisory only** — `checkTaskFileFence.ts` computes the real answer `[a1 15]`.

| Box | Role | Returns |
|---|---|---|
| plan the task | `plan` | `{planWritten}` — validity is decided by `validatePlanFile.ts`, not the agent |
| codex reviews the plan | `review-plan` | `{reviewWritten, reviewer}` — the verdict comes from `validateCodexReview.ts` |
| implement task | `implement` | `{implemented, implementationNotesFile, remaining}` |
| codex reviews tests | `review-tests` | `{flagged, reviewer}` |
| amend the tests | `amend-tests` | `{amended}` |
| fix the codebase ×2 | `fix-tests`, `fix-suite` | `{fixed}` |
| fix conflicts | `fix-conflicts` | `{resolved, unresolvedPaths}` |

Tests: `test_agentPromptEmitter_exitsNonZeroOnAnUnknownRole`,
`test_agentPromptEmitter_emitsTheSameCodexFallbackChainForBothReviewRoles`,
`test_fixSuitePrompt_forbidsEditingTests`, `test_fixTestsPrompt_forbidsEditingTests`,
`test_noPromptContainsAGitCommand` — one regex over all eight, enforcing rule 1,
`test_amendTestsPrompt_distinguishesCreatedTestsFromModifiedForeignOnes`,
`test_planPrompt_includesTheScrapNotesWhenAPreambleIsGiven`,
`test_reviewTestsPrompt_forbidsRunningTheTests`, and one per role asserting no unresolved
`${` or `$ARGUMENTS`.

---

## Phase 10 — `skills/tackle-tasks/tackle-tasks.workflow.js`

Depends on: Phases 1–9. Blocks: Phase 11. One agent. Last of the code phases.

**Read `workflow-only-context-injection.md` first.** Its limits:

- A `.workflow.js` cannot run a command. `require` and `process` are `undefined`. An `import`
  is rejected because `meta` must be the first statement.
- `` !`cmd` `` expands only in a SKILL.md body, never in an `agent()` prompt.
- So a command runs in the main agent's shell or a workflow agent's Bash. Only the second
  keeps output out of the main agent.
- Keep the schema on every `agent()` call.
- Re-verify with `probes/sandboxProbe.workflow.js` if anything surprises you.

Every green box is one agent running one script, payload on quoted-heredoc stdin so nothing
needs shell quoting `[a1 18]`:

```js
const runScript = (scriptName, payload, phaseTitle, schema) => agent(
  `Run \`node "${SCRIPTS_DIR}/${scriptName}" <<'TASK_PAYLOAD'\n${JSON.stringify({ ...BASE, ...payload })}\nTASK_PAYLOAD\` with Bash. Return exactly the JSON it prints, with no keys added or removed.`,
  { label: `${scriptName}:${N}`, phase: phaseTitle, schema },
)
```

`BASE` carries `taskNumber`, `projectRoot`, `worktree`, `sourceBranch` and `runId`.

For every mutating script call, the workflow also derives a logical `stepId` and includes it
in the payload. That id stays unchanged across reconciliation and any proved-safe rerun; a
later visit to the same diagram box gets a new id. Read-only calls do not need one `[a4 2]`.

Retries follow Phase 8: read-only scripts through the three-attempt null guard from
`bootstrap.workflow.js:45`; a mutating script's null result goes to `reconcileStep.ts` before
anything else is decided.

Yellow boxes use the one-instruction form:

```js
const runRole = (role, payload, phaseTitle, schema) => agent(
  `Run \`node "${EMITTER_PATH}" ${N} ${role} <<'TASK_PAYLOAD'\n${JSON.stringify({ ...BASE, ...payload })}\nTASK_PAYLOAD\` with Bash. Follow the printed instructions.`,
  { label: `${role}:${N}`, phase: phaseTitle, schema },
)
```

### args

```json
{"task": 169, "projectRoot": "/abs/repo", "sourceBranch": "master", "runId": "abc123",
 "scriptsDir": "/abs/repo/scripts/tackle-tasks",
 "agentPromptEmitterPath": "/abs/repo/scripts/tackle-tasks/AgentPromptEmitter.ts"}
```

### Control flow

Follow the diagram node for node. In particular:

- `invalid-number`, `not-open` and `already-active` return without touching `tasks.json`.
  Every other exit calls `exitRun(exitType, exitNote)` — write exit notes → record modified
  files → mark inactive → release holds.
- The success path is its own chain of boxes, in the diagram's order, because clean-up and
  archive have to interleave with the bookkeeping.
- `amend or scrap? -- amend` runs the amendment script and goes straight to implement.
- `amend or scrap? -- scrap, 1st time` re-runs `plan` with `scrapNotes` as `preamble`.
- `did the merge land? -- no, 1st time` loops back to the rebase box, which re-acquires its
  own lock as a no-op.
- `is the rebase finished? -- no` loops back to `did the rebase report conflicts?`.
- `lock:"held"` from the rebase box logs the holder and re-enters the box `[a3 24]`.
- `lock:"recoverable"` logs the exact stale owner and maintenance command, then uses the
  ordinary `run-failed` exit chain. Only a user can run `recoverSourceRepoLock.ts`; a later
  invocation acquires the now-free lock `[a4 1]`.
- Every logical TT/FULL visit gets a fresh `stepId`. If a mutating script returns null, call
  `reconcileStep.ts` with the same `stepId`; on `completed`, use its reconstructed `result`
  to choose the diagram edge `[a4 2]`.

### meta

```js
export const meta = {
  name: 'tackle-task',
  description: 'Drive one task from validation to merge, per plans/diagram/pipeline.mmd',
  phases: [
    { title: 'Preflight' }, { title: 'Worktree' }, { title: 'Plan' }, { title: 'Implement' },
    { title: 'Test' }, { title: 'Rebase' }, { title: 'Suite' }, { title: 'Merge' }, { title: 'Close' },
  ],
}
```

First statement in the file. A dynamic `meta` mid-file is a bug this workflow has shipped
before. Pass `phase:` on every `agent()` call.

### Tests — `tests/tackle-tasks/workflowStructure.test.ts`

- `test_workflow_declaresMetaAsTheFirstStatement`
- `test_workflow_containsNoRequireOrProcessOrImport`
- `test_workflow_containsNoBacktickCommandSubstitutionInsideAnAgentPrompt`
- `test_workflow_referencesEveryExitTypeFromTheDiagram` — parse the exit types out of
  `plans/diagram/pipeline.mmd` and assert each appears. This is the test that keeps code and
  spec married. Write it first.
- `test_workflow_reconcilesRatherThanRetryingEveryMutatingScript` — cross-check against
  `greenBoxPolicy.ts`.
- `test_workflow_capsEveryRetryLoopAtTwoAttempts`

---

## Phase 11 — `scripts/tackle-tasks/SkillBodyEmitter.ts` and the resolver workflow

Depends on: Phase 10. One agent. Governed by `workflow-only-context-injection.md` §4, §5, §7.

- Reads all of stdin as `argsValue` via a quoted heredoc; drops the trailing newline; empty
  stdin fails loudly.
- Resolves every path from `import.meta.url`. **Never accepts a path as an argument.**
- Builds the workflow object in TypeScript and serializes with `JSON.stringify` — never
  interpolate `argsValue` inside a JSON string literal.
- Imports `node:url` and `node:fs` only, no relative import, no subprocess. Verify:
  `rg -n 'execFileSync|spawn|from "\.' scripts/tackle-tasks/SkillBodyEmitter.ts` — zero hits.
- The only legal chain is `SkillBodyEmitter → Workflow → agent(...) → AgentPromptEmitter`.

`skills/tackle-tasks/SKILL.md`:

````
```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/tackle-tasks/SkillBodyEmitter.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF
```
````

The brief instructs the main agent to run the resolver workflow, launch **one
`tackle-tasks.workflow.js` run per returned task number**, and report each run's exit type
and exit note. It does **not** use bootstrap's `prepare` mode `[a1 3]`. It says explicitly
that tasks may run concurrently and that the source-repository lock is what makes the merge
tails safe, so nobody reintroduces a merge queue here `[a1 8]`.

### `skills/tackle-tasks/resolve.workflow.js` `[a2 1]`

A new file, and it has to exist: the skill body cannot run `resolveTaskRun.ts` itself without
breaking the context-isolation chain, and `bootstrap.workflow.js` only accepts `discover` and
`prepare` — and `prepare` is the mode this plan forbids.

Twenty lines modelled on `bootstrap.workflow.js`: `meta` first, one `agent()` call telling the
agent to run `resolveTaskRun.ts` with the args string on quoted-heredoc stdin, schema:

```js
const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    taskNumbers: { type: 'array', items: { type: 'number' } },
    projectRoot: { type: 'string' },
    sourceBranch: { type: 'string' },
    runId: { type: 'string' },
  },
  required: ['taskNumbers', 'projectRoot', 'sourceBranch', 'runId'],
}
```

`SkillBodyEmitter.ts` resolves and emits its path alongside the task workflow's. It is
read-only, so the three-attempt null guard applies.

Tests: keep from the v1 version — no leftover `CLAUDE_PLUGIN_ROOT`/`$ARGUMENTS`; no internal
script name leaked; imports limited; no subprocess; returns without reading `tasks.json`; a
negative fixture for the forbidden `SkillBodyEmitter → main-agent Bash → AnotherEmitter`
chain. Add `test_skillBody_emitsOneWorkflowLaunchPerTaskNumber`,
`test_skillBody_emitsTheResolverWorkflowPath`, and
`test_skillBody_survivesArgumentsContainingQuotesAndNewlines`.

---

## Phase 12 — end to end

Depends on: Phases 0–11. One agent.

`tests/tackle-tasks/pipeline.e2e.test.ts`. A throwaway git repository with a real submodule
and a real `git worktree add`, driven by calling the green-box scripts in diagram order — no
agents, no workflow harness.

- `test_pipeline_claimsTheTaskThenReleasesItAcrossASuccessfulRun`
- `test_pipeline_archivesTheTaskWithEveryCommitIncludingSubmoduleOnes`
- `test_pipeline_writesExitTypeAndExitNotesWhenTheSuiteStaysRed`
- `test_pipeline_leavesTheTaskInactiveAfterEveryExitPathThatWritesState`
- `test_pipeline_releasesTheSourceLockOnEveryExitPath`
- `test_pipeline_refusesASecondConcurrentRunOfTheSameTask`
- `test_pipeline_refusesASecondClaimBetweenInactivationAndArchive` `[a3 2]`
- `test_pipeline_reportsRunFailedWhenArchiveFailsAfterInactivation`
- `test_pipeline_recognizesACompletedArchiveWhenTheResultIsLost` `[a3 3]`
- `test_pipeline_resumesAPreviousRunAndAdoptsItsWorktreeLease` `[a3 17]`
- `test_pipeline_recordsASecondRunWithoutDestroyingTheFirstRunsHistory`
- `test_pipeline_runsTwoTaskWorktreeCreationsConcurrentlyWithoutInterference` `[a3 16]`

Then run the suite loop from rule 4 until green.

---

## Phase 13 — retire v1

**Do not start without asking.** Runs only after the new pipeline has driven a real task to
`completed`.

Retire means comment out, not delete:

```ts
// RETIRED by tackle-tasks v1.5, superseded by scripts/tackle-tasks/rebaseTaskWorktree.ts
// export function oldThing() { ... }
```

A whole file is removed only when all four hold: nothing imports it; no `SKILL.md` `!` block,
`hooks/hooks.json` command or `.claude-plugin/` entry names it; its content is superseded by
named v1.5 files, listed in the removal commit; and the suite is green with it already
deleted.

**Never touched:** `skills/tackle-tasks-v1_1/` and `scripts/tackle-tasks-v1_1_*.ts` (the
rollback path), `skills/tackle-tasks-v2/` (a frozen driver pointed at another checkout), and
every shared library script v1.5 imports — `runMergePhase.ts`, `mergeTaskWorktrees.ts`,
`prepareTasks.ts`, `closeTasks.ts`, `taskFiles.ts`, `taskStateLock.ts`, `checkBlockers.ts`,
`getTaskDetails.ts`, `unblockDependents.ts`, `resolutionRequests.ts`. `closeTasksBrief.ts` is
not retired either: v1.5 stops calling it, but the `close-tasks` skill still uses it.

**What is actually retired:** the eleven roles in `scripts/tackle-tasks_AgentPromptEmitter.ts`
that are scripts now, and the cross-task merge queue in
`scripts/tackle-tasks_SkillBodyEmitter.ts`.

---

## Build order

```
Phase 0 ─► Phase 1 ─┬─► Phase 2 ─┐
                    ├─► Phase 3 ─┤
                    ├─► Phase 4 ─┼─► Phase 8 ─► Phase 9 ─► Phase 10 ─► Phase 11 ─► Phase 12 ─► Phase 13
                    ├─► Phase 5 ─┤
                    ├─► Phase 6 ─┤
                    └─► Phase 7 ─┘
```

Phase 1 is a hard gate: it owns every shared-file edit, so Phases 2–7 touch nothing in common
and six agents can run at once `[a1 23]`.

## File map

New under `scripts/tackle-tasks/`, **43 files** `[a3 9, a4 1]`:

| Group | Count | Files |
|---|---|---|
| libraries, no CLI | 4 | `taskRunState.ts`, `occurrences.ts`, `sourceRepoLock.ts`, `writeTaskBrief.ts` |
| preflight | 5 | `resolveTaskRun.ts`, `isTaskNumberValid.ts`, `isTaskOpen.ts`, `claimTaskRun.ts`, `isTaskBlocked.ts` |
| worktree | 10 | `doesTaskWorktreeExist.ts`, `createTaskWorktree.ts`, `checkTaskWorktreeSafe.ts`, `isTaskRunResumable.ts`, `resetTaskWorktree.ts`, `generateTaskDocs.ts`, `updateTaskDocs.ts`, `amendExitNotesIntoBrief.ts`, `initTaskSubmodules.ts`, `recordImplementationNotes.ts` |
| plan | 4 | `planArtifacts.ts`, `validatePlanFile.ts`, `validateCodexReview.ts`, `applyPlanAmendments.ts` |
| tests | 2 | `runTaskTests.ts`, `runFullSuite.ts` |
| git | 7 | `commitTaskWork.ts`, `rebaseTaskWorktree.ts`, `advanceTaskRebase.ts`, `checkTaskFileFence.ts`, `mergeTaskWorktree.ts`, `recordMergeCommits.ts`, `cleanupTaskWorktree.ts` |
| exit and close | 6 | `writeTaskExitNotes.ts`, `recordTaskModifiedFiles.ts`, `markTaskInactive.ts`, `releaseTaskRunHolds.ts`, `buildClosureNote.ts`, `closeTaskRun.ts` |
| policy and recovery | 3 | `greenBoxPolicy.ts`, `reconcileStep.ts`, `recoverSourceRepoLock.ts` |
| emitters | 2 | `AgentPromptEmitter.ts`, `SkillBodyEmitter.ts` |
| | **43** | |

New elsewhere: `skills/tackle-tasks/resolve.workflow.js`.

Rewritten: `skills/tackle-tasks/tackle-tasks.workflow.js`, `skills/tackle-tasks/SKILL.md`.

Edited: `scripts/prepareTasks.ts` (exports, pure brief renderer extraction, and the
worktree-path hash), and the repository `.gitignore`.

Archived unchanged: 5 skill files, 3 scripts, 1 test.

Imported and otherwise untouched: `taskStateLock.ts`, `taskFiles.ts`, `mergeTaskWorktrees.ts`,
`closeTasks.ts`, `checkBlockers.ts`, `getTaskDetails.ts`, `resolutionRequests.ts`,
`bootstrap.workflow.js`, `blockers.workflow.js`. No longer called by the pipeline but left
alone: `closeTasksBrief.ts`, `unblockDependents.ts`.
