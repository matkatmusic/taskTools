# Restructure tackle-tasks: replace prose with per-phase on-disk state

*Incorporates all three rounds of `plans/imperative-meandering-brook-amendment.md`.*

> **This plan is not ready to implement.** Three prerequisites must land first —
> see the gate below. Every architectural choice here is now fixed; there are no
> conditional production paths left for an implementer to decide.

---

## Prerequisite gate

### P1 — Resolve the dynamic-context transport (do this first, it decides the public interface)

The skill's front door has to accept task arguments safely. That question must be
answered by experiment **before any production file is written**, because the
answer changes the skill's public interface.

1. Install a throwaway skill using the documented multiline ` ```! ` block.
2. Invoke it through the **real Claude Code skill loader** with an apostrophe, a
   backtick, spaces, and a line resembling the heredoc delimiter.
3. Assert the helper receives the exact bytes and that no shell fragment executes.
4. Remove the throwaway skill.
5. Record the observed command shape in this plan and keep **only** that path.

Supporting evidence already gathered: the ` ```! ` fenced form is documented under
"Inject dynamic context," and skills and custom commands are now one mechanism —
the `shell` frontmatter field is described as "Shell to use for `` !`command` ``
and ```! blocks in **this skill**." The docs show no worked example of
`$ARGUMENTS` *inside* that fence, and none of the 892 SKILL.md files on this
machine use the fenced form, so there is no local precedent.

If the fenced heredoc cannot preserve arbitrary arguments, **do not** fall back to
textual interpolation with a warning. Narrow the public interface instead to the
already-documented hint — one canonical no-space JSON array plus an optional
literal `valid` token — and use the loader's positional substitutions only after a
real-loader test proves that exact restricted form. Trailing free text becomes
explicitly unsupported.

### P2 — Task 49 must land

Task 49 (open, unblocked, difficulty 4) rewires `mergeTaskWorktrees.ts` to drive
`runFinalizer.ts`, `runConsolidation.ts`, `operationPush.ts`, `basePublication.ts`
and `taskArchival.ts`. Its description records a decision already made by the
user, marked "implement it, do not re-litigate":

> the script keeps its current front door. It accepts the flat
> `WorkflowArguments` JSON as `argv[2]` and writes the same stdout shape it
> writes today … Every existing test in `tests/mergeTaskWorktrees.test.ts` must
> keep passing unchanged, with no rewritten CLI assertions.

**This plan now preserves that contract permanently.** See "Locked decision 1".

### P3 — Task 50 must land

Task 50 (blocked by 49, difficulty 4) splits the pipeline into prepare-for-approval
and finalize stages using `approvalGate.ts`, `approvalReadiness.ts` and
`runAuthorization.ts` (all three exist). Its description states:

> There is exactly one approval in a run — do not introduce a second post-merge
> gate.

**This plan now uses that single authorization.** See "Locked decision 3".

Task 50 may also reorganize the workflow files, so the workflow contracts in
Step 2 must be built from the **resulting** production workflow set, not today's.

### Housekeeping before P3 can be tackled

Task 50's `files` array names `skills/tackle-tasks/tackle-tasks.workflow.js`,
which **does not exist** — the pipeline is five split files (`plan`, `verify`,
`implement`, `test`, `merge`). Run `/taskTools:update-task-files [50]` to correct
it, or its brief will embed a "file not found" placeholder.

### Work already staged in this session that this plan reverts

An earlier session added a `--run <argsFile> <outcomesFile>` mode to
`mergeTaskWorktrees.ts` plus `.taskTools/run-outcomes.json`. Locked decision 1
removes both. Keep `runMergePhase.ts` (rewired below) and the stripped
`merge.workflow.js`.

---

## Locked architectural decisions

**1. `mergeTaskWorktrees.ts` keeps its flat `argv[2]` front door. Permanently.**
No `--run`, no `--run-config`. `runMergePhase.ts` reads `runConfig.json`, derives
the outcomes, assembles the flat CLI input **entirely in memory**, and invokes:

```ts
execFileSync("node", [
    "--no-inspect",
    resolveMergeScriptPath(),
    JSON.stringify({ ...config.pipelineArgs, ...outcomes }),
]);
```

No agent ever handles that JSON, so argv transport reintroduces no model
composition. With the input assembled in memory, `run-outcomes.json` is
unnecessary and is deleted from the design.

**2. Merge attempts are a per-attempt state machine, not a run-scoped receipt.**
A receipt keyed only by `runId` would survive a blocked merge, and the
post-unblock retry would find the stale blocked receipt and replay it forever.
Receipts are keyed by a generated `attemptId` and consumed once.

**3. There is exactly one approval per run — task 50's authorization.**
No `mergeApproval: {runId, approved}` record. No second conversational approval
before `close-tasks`. The rewritten skill removes that later prompt entirely.

**4. Identity is derived from state, never supplied by the agent or stdin.**
Stdin carries only an untrusted payload. Every mutating command re-reads ready
state under a lock and compares a monotonic `revision` before writing.

**5. `planModel` and `workerModel` are deleted from the workflow files.**
Nothing produces either field, so no run can set them. Because the contract test
asserts set equality against literal `ARGS.<key>` reads, leaving the reads in
place would fail that test immediately. Remove `PLAN_MODEL = ARGS.planModel`,
`WORKER_MODEL = ARGS.workerModel` and both conditional `options.model = …`
assignments. `maxRounds` stays explicit at `3`.

---

## The state file

`.taskTools/runConfig.json`, left visible in git status (per decision).

```json
{
  "status": "ready",
  "revision": 7,
  "invocation": { "taskNumbers": [53], "skipVerification": true },
  "blockedStatus": "task 53: unblocked",
  "taskDetails": "task 53 (OPEN):\n{ ... }",
  "pipelineArgs": { "repo": "...", "runId": "...", "groups": [] },
  "authorization": { "...": "task 50's issued authorization artifact" },
  "phase-1": { "plans": [], "planned": [], "needsClarification": [], "notRelevant": [] },
  "phase-2": { "verified": [], "approved": [], "rejected": [], "revisedCount": 0, "reviewHandoffs": [] },
  "phase-3": { "results": [], "done": [], "partial": [], "blocked": [], "requeueCount": 0 },
  "phase-4": { "tests": [], "allPassed": true, "testReceipts": [] },
  "phase-6": { "status": "merged", "result": {}, "failure": null, "attemptId": "..." },
  "decisionAnswers": []
}
```

Typed as a discriminated union, so an incomplete initializing object can never
satisfy the ready interface:

```ts
type InitializingRunConfig = { status: "initializing"; runId: string };

type ReadyRunConfig = {
    status: "ready";
    revision: number;
    invocation: { taskNumbers: number[]; skipVerification: boolean };
    blockedStatus: string;
    taskDetails: string;
    pipelineArgs: PipelineArguments;
    // Stored phase outputs and authorization are optional until they exist.
};

type RunConfig = InitializingRunConfig | ReadyRunConfig;
```

`taskDetails` is a **string**, because `getTaskDetails.ts` emits text, not JSON.
There is no `phase-5`; the approval gate stores task 50's authorization instead.

### Artifacts owned by this state machine

Exactly three, and finalization deletes exactly these:
`runConfig.json`, `run-receipt.json`, `run.lock`.

It must never remove `tasks.json`, `completedTasks.json`, worktrees, or branches.

---

## Work order

Strict red-green: each step writes the failing test first, then the minimum code
to pass it. 4-space indent, verb-led function names, imperative style per
`~/.claude/guides/coding-standards.md`. Every new file stays under the 250-line
cap.

### Step 1 — `scripts/runConfig.ts` + `scripts/runConfigValidation.ts` (new)

Atomic, revision-checked state I/O.

Tests first, `tests/runConfig.test.ts`:
- `test_writeRunConfigReplacesTheFileThroughAUniquelyNamedTemporarySibling`
- `test_writeRunConfigCreatesTheTaskToolsDirectoryWhenItIsMissing`
- `test_readReadyRunConfigRejectsAMissingFileByName`
- `test_readReadyRunConfigRejectsAConfigurationStillMarkedInitializing`
- `test_readReadyRunConfigRejectsJsonThatIsNotAnObject`
- `test_updateReadyRunConfigRejectsAWriteWhoseReadRevisionIsStale`
- `test_updateReadyRunConfigIncrementsTheRevisionOnEverySuccessfulWrite`
- `test_getPhaseOutputThrowsNamingThePhaseWhenItHasNotRunYet`
- `test_getPhaseOutputThrowsNamingTheMissingFieldWhenAPhaseIsMalformed`

Temporary filenames include the process ID and a random suffix — a fixed
`runConfig.json.tmp` is unsafe when processes race. `updateReadyRunConfig` is the
only mutation path: it re-reads state, compares the `revision` it was handed
against the current one, rejects a stale write rather than overwriting newer
state, then renames into place with `revision + 1`.

Validators live in `runConfigValidation.ts` and name both the phase and the
offending field: `phase 3 is missing required field "requeueCount"`.

### Step 2 — `scripts/workflowContracts.ts` (new) — *after P3*

Build the table from the **post-task-50** production workflow set.

```ts
export const WORKFLOW_INPUT_CONTRACTS = {
    1: { file: "plan.workflow.js",      required: ["groups"] },
    2: { file: "verify.workflow.js",    required: ["groups", "planned"] },
    3: { file: "implement.workflow.js", required: ["groups", "approved", "typecheckCommand", "maxRounds"] },
    4: { file: "test.workflow.js",      required: ["groups", "done", "approved", "typecheckCommand", "maxRounds"] },
    6: { file: "merge.workflow.js",     required: ["approvedByUser", "repo", "failedCommand", "conflicts", "error"], optional: ["decisions"] },
};

export const WORKFLOW_OUTPUT_CONTRACTS = {
    1: { keys: ["plans", "planned", "needsClarification", "notRelevant"] },
    2: { keys: ["verified", "approved", "rejected", "revisedCount", "reviewHandoffs"] },
    3: { keys: ["results", "done", "partial", "blocked", "requeueCount"] },
    4: { keys: ["tests", "allPassed", "testReceipts"] },
    6: { keys: ["fixed", "summary", "blockers", "decisions"] },
};
```

Tests first, `tests/workflowContracts.test.ts`:
- `test_everyLiteralArgsKeyReadInAWorkflowAppearsInItsDeclaredInputContract`
- `test_workflowFilesUseNoDynamicArgsBracketAccess` — rejects `ARGS[`, which
  would defeat the scan
- `test_eachWorkflowReturnsExactlyItsDeclaredOutputKeys` — **executes** each
  workflow
- `test_aConditionalAlternateReturnShapeFailsTheOutputContract` — a regression
  fixture proving the harness actually catches divergence

The output test must execute, not compare two declarations that can drift
together. Concrete harness:

1. reject workflow sources containing imports or exports other than the expected
   leading `export const meta`;
2. rewrite only that declaration to `const meta`;
3. wrap the transformed body in `AsyncFunction`;
4. inject deterministic `args`, `agent`, `parallel`, `pipeline`, `log` and `phase`
   globals; and
5. execute representative **non-empty** inputs for phases 1-4, plus **both** the
   unapproved early return and the approved agent path for phase 6.

Assert exact top-level keys on every exercised return path. Runtime phase
validators continue to enforce value kinds.

Delete `planModel`/`workerModel` from `plan.workflow.js` and
`implement.workflow.js` in this step (locked decision 5), or this test fails on
arrival.

### Step 3 — `scripts/prelaunchSetup.ts` (new) — setup, resume, and recovery

Tests first, `tests/prelaunchSetup.test.ts`:
- `test_runPrelaunchSetupStartsANewRunWhenNoStateExists`
- `test_runPrelaunchSetupEntersResumeModeWhenTheCanonicalInvocationMatches`
- `test_resumeModeReportsTheFirstMissingPhaseWithoutRecreatingWorktrees`
- `test_runPrelaunchSetupRefusesADifferentInvocationAndNamesTheAbandonCommand`
- `test_runPrelaunchSetupPreservesTheBytesOfTheRunItRefusedToOverwrite`
- `test_asecondSimultaneousSetupIsRefusedWhileTheLockExists`
- `test_recoverInitializingRestartsSetupOnlyForTheMatchingRunId`
- `test_runPrelaunchSetupWritesReadyOnlyAfterEveryChildCommandSucceeds`
- `test_runPrelaunchSetupStoresTaskDetailsAsAString`
- `test_runPrelaunchSetupPrintsOnlyTheContextEnvelope`

Canonical invocation identity, stored in ready state:

```ts
invocation: { taskNumbers: number[]; skipVerification: boolean }
```

On invocation:
- **No state** → start a new run.
- **Ready state, invocation matches** → resume mode. Print the stored context
  envelope plus `{mode: "resume", nextPhase: <first missing phase>}`. Do **not**
  rerun `prepareTasks.ts` or recreate worktrees.
- **Ready state, invocation differs** → refuse, naming the retained run and
  `finalizeTaskRun.ts --abandon`. Never infer abandonment from a different
  invocation.

Exclusive lease: create `.taskTools/run.lock` atomically with
`openSync(path, "wx")`, recording `runId`, session ID and start time. A second
process refuses while it exists. A crashed setup is recovered **only** through
`prelaunchSetup.ts --recover-initializing <runId>`, which verifies the matching
initializing state before removing the lock and restarting. No elapsed-time guess
may steal a lock.

Setup sequence: acquire lock → write `{status:"initializing", runId}` →
`checkBlockers.ts` → `checkBlockers.ts --unblocked` then `getTaskDetails.ts` →
`prepareTasks.ts` → write the complete ready config → print only the context
envelope. `pipelineArgs` is never printed.

In `prepareTasks.ts`, delete the `.taskTools/run-arguments.json` write and the
`resolveRunArgumentsPath` / `resolveStepOutputsPath` helpers.

Argument transport follows whatever P1 established.

### Step 4 — `scripts/storePhaseResult.ts` (new)

`node storePhaseResult.ts <n>`, JSON on **stdin**. Stdin is required, not an argv
string: `reviewHandoffs` are free-text reviewer verdicts that routinely contain
apostrophes.

Tests first, `tests/storePhaseResult.test.ts`:
- `test_storePhaseResultStoresJsonSuppliedOnStandardInput`
- `test_storePhaseResultStoresOutputContainingAnApostropheAndABacktick`
- `test_storePhaseResultDerivesTheRunIdFromStateAndIgnoresAnySuppliedOnStdin`
- `test_storePhaseResultRejectsAConfigurationThatIsNotReady`
- `test_storePhaseResultRejectsOutputMissingARequiredFieldNamingThatField`
- `test_storePhaseResultRejectsAWriteWhoseRevisionWentStale`
- `test_storeDecisionAnswersStoresTheAnswerArray`

Identity comes from state, never stdin (locked decision 4). Every mutation
acquires the run lock, re-reads ready state, validates the expected phase
transition, and writes through the revision-checked path from Step 1.

`--decision-answers` stores the array at top-level `decisionAnswers`. There is no
`--merge-approval` mode; approval is task 50's authorization.

### Step 5 — `scripts/buildPhaseArgs.ts` (new)

`node buildPhaseArgs.ts <phaseNumber>` prints that phase's `args` JSON and nothing
else. Drives off `WORKFLOW_INPUT_CONTRACTS`.

Tests first, `tests/buildPhaseArgs.test.ts` — each asserts the keys of the
**serialized** JSON (`Object.keys(JSON.parse(stdout))`), never the
pre-serialization object, because `JSON.stringify` silently drops `undefined`:
- `test_buildPhaseArgsForPlanSerializesExactlyItsDeclaredKeys`
- `test_buildPhaseArgsForVerifySuppliesThePlannedListFromPhaseOne`
- `test_buildPhaseArgsForImplementSuppliesTheApprovedListFromPhaseTwo`
- `test_buildPhaseArgsForTestSuppliesBothTheDoneListAndTheApprovedList`
- `test_buildPhaseArgsDefaultsMaxRoundsToThreeWhenItIsNotConfigured`
- `test_buildPhaseArgsThrowsNamingTheEarlierPhaseThatHasNotRun`

### Step 6 — `scripts/executeMergeAttempt.ts` (new)

The wrapper that makes merge attempts recoverable **without touching task 49's
CLI**.

Tests first, `tests/executeMergeAttempt.test.ts`:
- `test_executeMergeAttemptWritesAStartedReceiptBeforeInvokingTheMergeScript`
- `test_executeMergeAttemptReplacesTheReceiptWithTheCapturedScriptRun`
- `test_executeMergeAttemptCapturesTheScriptRunOnANonZeroExit`
- `test_executeMergeAttemptPrintsNothingButTheChildStdout`

It receives a generated `attemptId` and the flat input, then:
1. atomically writes `run-receipt.json = {runId, attemptId, state: "started"}`;
2. invokes the **unchanged** `mergeTaskWorktrees.ts` CLI via `execFileSync`;
3. captures `{exitCode, stdout, stderr}` for both success and failure;
4. atomically replaces the receipt with
   `{runId, attemptId, state: "completed", scriptRun}`; and
5. prints nothing except the captured child stdout when appropriate.

The receipt stores a `ScriptRun`, **not** a verdict. `judgeMergeRun` stays owned
by `runMergePhase.ts`, so the verdict rules are neither duplicated nor moved.

### Step 7 — rewire `scripts/runMergePhase.ts`

Tests first, updating `tests/runMergePhase.test.ts`:
- `test_buildMergeOutcomesDerivesEveryCountFromTheStoredPhaseOutputs`
- `test_buildMergeOutcomesThrowsNamingTheEarlierPhaseThatIsMissing`
- `test_runMergePhaseRefusesWithoutAValidAuthorizationForTheCurrentDigest`
- `test_runMergePhaseAssemblesTheFlatCliInputInMemoryAndPassesItAsArgv`
- `test_runMergePhaseStoresTheVerdictWithItsAttemptIdAndClearsDecisionAnswers`

```ts
export function buildMergeOutcomes(config: ReadyRunConfig) {
    const planPhase = getPhaseOutput(config, 1);
    const verifyPhase = getPhaseOutput(config, 2);
    const implementPhase = getPhaseOutput(config, 3);
    const testPhase = getPhaseOutput(config, 4);
    return {
        doneCount: implementPhase.done.length,
        partialCount: implementPhase.partial.length,
        blockedCount: implementPhase.blocked.length,
        needsClarificationCount: planPhase.needsClarification.length,
        requeueCount: implementPhase.requeueCount,
        testReceipts: testPhase.testReceipts,
        reviewHandoffs: verifyPhase.reviewHandoffs,
    };
}
```

Attempt protocol:
1. **No receipt** → generate a unique `attemptId`, invoke the wrapper.
2. **Matching completed receipt whose `attemptId` is not yet in phase 6** → apply
   `judgeMergeRun`, then atomically store
   `{phase-6: {...verdict, attemptId}, decisionAnswers: []}`.
3. After that state write succeeds, **delete the consumed receipt**.
4. **Completed receipt whose `attemptId` is already in phase 6** → delete it as an
   already-consumed leftover.
5. **Matching `started` receipt with no completion** → refuse to rerun
   automatically. Report an indeterminate attempt with recovery instructions; git
   side effects may have occurred.
6. **Mismatched run ID or malformed receipt** → quarantine or reject by name,
   never silently.

Clearing `decisionAnswers` in the same write is what stops answers given for
conflict A from attaching to conflict B. Because a blocked receipt is consumed
before the unblock conversation, a post-unblock retry finds no receipt and creates
a genuinely new attempt.

### Step 8 — recovery and attempt-lifecycle tests

`tests/runMergePhaseRecovery.test.ts`:
- `test_parentDeathIsFollowedByRecoveryFromACompletedReceipt`
- `test_blockedAttemptThenSuccessfulUnblockRunsAGenuinelyNewAttempt`
- `test_crashAfterPhaseSixIsStoredButBeforeReceiptDeletionRecoversCleanly`
- `test_aStartedReceiptRefusesAutomaticReplay`
- `test_aMismatchedOrMalformedReceiptIsRejectedByName`
- `test_exactlyOneMetricsRecordIsAppendedPerCompletedAttempt`

Plus `tests/runMergePhaseIntegration.test.ts` exercising the real
`runMergePhase.ts` → `executeMergeAttempt.ts` → `mergeTaskWorktrees.ts` boundary
in a temporary git repository.

### Step 9 — `scripts/buildUnblockArgs.ts` (new)

Tests first, `tests/buildUnblockArgs.test.ts`:
- `test_buildUnblockArgsSerializesExactlyTheKeysDeclaredForPhaseSix`
- `test_buildUnblockArgsDerivesApprovalFromTheValidatedAuthorization`
- `test_buildUnblockArgsRefusesWhenTheAuthorizationIsAbsentOrInvalid`
- `test_buildUnblockArgsIncludesStoredDecisionAnswersOnARetry`
- `test_buildUnblockArgsOmitsDecisionsEntirelyOnTheFirstAttempt`
- `test_buildUnblockArgsThrowsWhenPhaseSixRecordedNoFailure`

It consumes `WORKFLOW_INPUT_CONTRACTS[6]` **directly**, and its
exact-serialized-keys test drives off the same declaration — so adding a key to
the merge workflow's contract leaves the test red until the builder supplies that
key's value. `approvedByUser` is derived from the validated authorization, never
from a free boolean.

### Step 10 — `scripts/buildCloseTasksArgs.ts` (new)

Tests first, `tests/buildCloseTasksArgs.test.ts`:
- `test_collectMergedTaskNumbersReturnsTheTasksOfEveryMergedGroup`
- `test_collectMergedTaskNumbersReturnsNothingUnlessTheVerdictIsMerged`
- `test_collectMergedTaskNumbersRejectsAMergedVerdictThatAlsoContainsConflicts`
- `test_collectMergedTaskNumbersRejectsAnUnknownOrDuplicatedGroupId`

Print `[]` unless `phase-6.status === "merged"`. For a merged verdict, map every
`result.merged[].groupId` through `pipelineArgs.groups[].tasks[].number`, and
throw on an unknown or duplicated group id. A "merged" verdict that also carries
conflicts is internally inconsistent and is rejected loudly, not silently
filtered. Prints `[268,270,281]` with no spaces. The `closureNote` reasoning stays
prose.

### Step 11 — `scripts/finalizeTaskRun.ts` (new)

Tests first, `tests/finalizeTaskRun.test.ts`:
- `test_finalizeTaskRunValidatesTheRetainedRunIdAndAuthorizationFirst`
- `test_finalizeTaskRunDeletesOnlyTheThreeOwnedArtifacts`
- `test_finalizeTaskRunPreservesTasksJsonCompletedTasksJsonWorktreesAndBranches`
- `test_abandonModeIsRequiredWhenTheWorkIsNotBeingClosed`
- `test_finalizeTaskRunRemovesTheLockOnlyForTheMatchingRun`
- `test_finalizeTaskRunLetsAFollowingPrelaunchSetupProceed`

Deletes exactly `runConfig.json`, `run-receipt.json` and `run.lock`. Validates the
retained `runId`/authorization before deleting anything. Requires an explicit
`--abandon` mode when the work is not being closed. The directory is enumerated
before and after both successful finalization and explicit abandonment, proving
only those three artifacts disappear.

### Step 12 — rewrite `skills/tackle-tasks/SKILL.md`

Head of file: the transport form P1 selected — one path only, no conditional.

Each phase section collapses to a fixed shape. State the command shape once, then
reference it. Word it correctly: a Workflow return value is not shell stdout and
cannot literally be piped.

> **Step 2 — verify.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildPhaseArgs.ts" 2`
> and pass its stdout as `args` to Workflow with scriptPath
> `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/verify.workflow.js`. Serialize the
> Workflow return value as JSON and provide that JSON as quoted-heredoc stdin to
> `node "${CLAUDE_PLUGIN_ROOT}/scripts/storePhaseResult.ts" 2`.

Delete outright: the "pipeline args JSON has these keys" paragraph, every "args =
the pipeline args plus X from step N" line, the Step 6 blank-template block, every
restatement of a workflow's return shape, and — per locked decision 3 — **the
conversational approval before `close-tasks`**. Successful finalization proceeds
to close-task derivation under the same single authorization.

Keep as prose, because each needs a model and not a script: the **Verification**
section, the blocked-task rule, the single approval gate presentation (task 50's),
asking the user the `decisions` questions, the `closureNote` reasoning, and the
commit-message section.

Extend `allowed-tools` to cover the new scripts.

---

## Verification

1. `npx tsc --noEmit` — clean.
2. `bun test` — full suite plus the new test files. Baseline before this work is
   1045 passing; task 49 and task 50 will move that number before this plan starts.
3. **Task 49's existing CLI assertions must still pass unedited.** That is the
   single loudest signal that locked decision 1 held.
4. End-to-end acceptance test proving this sequence:
   1. setup receives arguments through the P1-selected transport and writes a
      **ready** configuration;
   2. a second simultaneous setup is refused while the lock exists;
   3. re-invoking with the same canonical invocation enters resume mode and
      reports the first missing phase without recreating worktrees;
   4. re-invoking with a different invocation is refused and names
      `finalizeTaskRun.ts --abandon`;
   5. phases 1-4 are stored through stdin, and each next builder emits exactly its
      declared serialized keys;
   6. an out-of-order phase and a malformed phase each fail with an error naming
      the phase and field;
   7. merge without a valid authorization is refused; authorization from another
      run is refused; authorization followed by a phase-4 mutation is invalidated;
   8. the merge runs through the flat `argv[2]` contract, unchanged;
   9. killing the parent after the child completes lets the next invocation
      recover from the completed receipt without merging or recording metrics
      twice;
   10. a blocked attempt A, a successful unblock, and a genuinely executed attempt
       B — with attempt A's decision answers absent from B;
   11. a `started` receipt refuses automatic replay;
   12. close-task numbers are derived from the retained state, with no second
       approval prompt;
   13. `finalizeTaskRun.ts` deletes only the three owned artifacts, and a following
       setup then proceeds; and
   14. `tasks.json`, `completedTasks.json`, worktrees and branches are untouched
       throughout.
5. Read the rewritten SKILL.md end to end and confirm no sentence describes the
   *shape* of any data — only which command to run and what to do with a result.

## Success criteria

- SKILL.md's pipeline section names commands only; no data shapes, no key lists.
- No phase input is derived by the agent; every one comes from a script's stdout.
- A workflow input change, or a change to a workflow's top-level return shape,
  fails a contract test until the shared declaration and its builder are updated —
  enforced by the executing output test in Step 2, not by runtime validation alone.
- `mergeTaskWorktrees.ts` still accepts flat `WorkflowArguments` JSON at `argv[2]`,
  and task 49's tests pass unedited.
- Exactly one approval exists in a run, and it is task 50's authorization bound to
  the exact state presented at the gate.
- A blocked merge, an unblock, and a retry produce two distinct attempts; no
  receipt is ever replayed.
- Finalization removes exactly `runConfig.json`, `run-receipt.json` and `run.lock`.
