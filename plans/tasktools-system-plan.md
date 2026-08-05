# TaskTools implementation plan

## Starting state and constraints

- Implement on a new branch created from the base branch after tasks 33–36 have
  landed. Those tasks complete the recursive-repository publication path that
  this plan must use.
- Do not replace `repositoryDiscovery.ts`, `canonicalTaskGroups.ts`,
  `recoveryRefs.ts`, `approvalGate.ts`, `runConsolidation.ts`, `runFinalizer.ts`,
  or the Phase 4 publication modules with v1-derived equivalents.
- Preserve both supported task-file layouts:
  `.taskTools/tasks.json` and root-level `tasks.json`.
- Preserve unknown task fields when reading and writing registry entries.
- Put per-run files under `<git-common-dir>/taskTools/runs/<runId>/`; do not
  write generated briefs, agent results, or merge input into `plans/`.
- For every step below, add and run the named failing tests before changing
  production code. After the focused tests pass, run the full suite and
  typecheck before starting the next step.

## 1. Add reproducible test and typecheck commands

### Tests first

Create `tests/packageScripts.test.ts` with:

- `test_packageTestScriptRunsTypeScriptTestFiles`
- `test_packageTypecheckScriptUsesTheLocalTypeScriptBinary`
- `test_typescriptIsDeclaredAsADevelopmentDependency`

Run the new test directly with `node --test tests/packageScripts.test.ts` and
confirm it fails against the current `package.json`.

### Implementation

Update `package.json` and `package-lock.json`:

- add `typescript` to `devDependencies`;
- add `test: node --test tests/*.test.ts`;
- add `typecheck: tsc --noEmit`.

Fix the existing nondeterministic
`test_mergeOrderIsDeterministic` in `tests/runConsolidation.test.ts`. Set fixed
Git author and committer dates in the test fixture before creating the two
candidate merge commits. Do not weaken its OID equality assertion.

### Verify

```text
node --test tests/packageScripts.test.ts tests/runConsolidation.test.ts
npm test
npm run typecheck
```

## 2. Add strict task-registry parsing and validation

### Tests first

Extend `tests/taskFiles.test.ts` with:

- `test_readTaskFileReturnsEmptyWhenTheFileDoesNotExist`
- `test_readTaskFileThrowsWhenJsonIsMalformed`
- `test_readTaskFileThrowsWhenTheTopLevelValueIsNotAnArray`
- `test_validateTaskRegistriesRejectsDuplicateTaskNumbersAcrossBothFiles`
- `test_validateTaskRegistriesRejectsANonIntegerTaskNumber`
- `test_validateTaskRegistriesRejectsASelfBlocker`
- `test_validateTaskRegistriesReportsAnOpenDependencyCycle`
- `test_validateTaskRegistriesPreservesUnknownFields`
- `test_resolveTaskFilesStillFindsRootLevelLegacyRegistries`

Run `node --test tests/taskFiles.test.ts` and confirm the new corrupt-input and
schema tests fail.

### Implementation

Change `scripts/taskFiles.ts`:

- replace `readTaskFile`'s catch-all fallback with missing-file handling plus
  thrown parse/schema errors;
- add `parseTaskFileText(text, path)`;
- add `validateTaskRegistryPair(openTasks, completedTasks)`;
- add `findOpenTaskDependencyCycles(openTasks)`;
- keep `resolveTaskFiles`' current `.taskTools/`, root-level, and fresh-project
  resolution order.

Update callers that currently rely on corrupt input returning `[]` so their CLI
entry points catch the thrown error, print the registry path and parse error,
and exit non-zero. Do not catch these errors inside library functions.

### Verify

```text
node --test tests/taskFiles.test.ts tests/getTaskDetails.test.ts tests/viewTaskHook.test.ts
npm test
npm run typecheck
```

## 3. Make registry mutations locked and recoverable

### Tests first

Create `tests/taskRegistry.test.ts` with:

- `test_createTasksAllocatesUniqueAscendingNumbersInOneTransaction`
- `test_createTasksRejectsAStaleExpectedRevision`
- `test_aSecondWriterCannotAcquireTheRegistryLock`
- `test_patchTasksPreservesOrderAndUnknownFields`
- `test_closeTasksMovesOnlyTheExplicitTaskNumbers`
- `test_closeTasksReleasesTheClosedNumbersFromOpenBlockers`
- `test_closeTasksWritesNeitherRegistryWhenValidationFails`
- `test_recoverTaskRegistryTransactionCompletesAnInterruptedSecondRename`
- `test_recoverTaskRegistryTransactionRejectsUnexpectedFileDrift`

Each test must create temporary registry files; no test may use the repository's
real backlog.

### Implementation

Create `scripts/taskRegistry.ts` with these exported operations:

- `computeTaskRegistryRevision(tasksText, completedTasksText)` using SHA-256;
- `acquireTaskRegistryLock(taskFilePair, owner)` using an atomic lock-directory
  creation beside the task files;
- `releaseTaskRegistryLock(lock)`;
- `readTaskRegistrySnapshot(taskFilePair)`;
- `writeTaskRegistryPairTransaction(snapshot, nextOpenTasks, nextCompletedTasks)`;
- `recoverTaskRegistryTransaction(taskFilePair)`;
- `createTasks(snapshot, taskInputs)`;
- `patchTasks(snapshot, taskPatches)`;
- `closeTasks(snapshot, taskNumbers, completionFieldsByTask)`.

Use a transaction journal beside the registries because two file renames are not
atomic as one operation. The journal stores the expected old revision, hashes of
both replacement files, both temporary paths, and the completed rename phase.
Recovery only rolls forward when the current files match the old or replacement
hashes recorded in the journal; otherwise it stops and reports drift.

Do not automatically break a stale-looking lock. Add the lock owner, process ID,
start timestamp, and recovery command to the error so the user can inspect it.

### Verify

```text
node --test tests/taskRegistry.test.ts tests/taskFiles.test.ts
npm test
npm run typecheck
```

## 4. Put all deterministic backlog operations behind one CLI

### Tests first

Create `tests/taskRegistryCli.test.ts` with:

- `test_listPrintsOneVersionedJsonResult`
- `test_unblockedPrintsAscendingTaskNumbers`
- `test_createReadsAJsonInputFileAndReturnsCreatedTasks`
- `test_patchReadsAJsonInputFileAndReturnsTheNewRevision`
- `test_closeRequiresExplicitTaskNumbersAndCompletionFields`
- `test_cliRejectsAnInputFileOutsideTheRepositoryAndGitCommonDirectory`
- `test_cliNeverAcceptsStructuredJsonAsShellSource`

### Implementation

Create `scripts/taskRegistryCli.ts`. Support these modes:

- `list`
- `view`
- `stats`
- `unblocked`
- `create --input <path>`
- `patch --input <path>`
- `close --input <path>`
- `recover`

Mutating input files contain the expected registry revision and the requested
operation. Accept a file path rather than JSON embedded in a shell command.
Print one versioned JSON object to stdout. Print errors to stderr and exit
non-zero.

Update these skills to call the CLI instead of editing JSON directly:

- `skills/create-task/SKILL.md`
- `skills/goal-tasks/SKILL.md`
- `skills/update-tasks/SKILL.md`
- `skills/update-task-files/SKILL.md`
- `skills/close-tasks/SKILL.md`
- `skills/pick-a-task/SKILL.md`
- `skills/tackle-unblocked-tasks/SKILL.md`
- `skills/task-stats/SKILL.md`

The skills still decide task wording, relevance, file ownership, closure notes,
and goal decomposition. They write one operation input file and invoke the CLI
once for the accepted batch.

Update `scripts/viewTaskHook.ts` to use the strict registry reader but retain its
zero-model hook response.

### Verify

```text
node --test tests/taskRegistryCli.test.ts tests/viewTaskHook.test.ts tests/taskStats.test.ts
rg -n 'edit.*tasks\.json|append.*tasks\.json' skills
npm test
npm run typecheck
```

The `rg` command must return no direct-edit instruction in a skill.

## 5. Add persisted run state and repository locking

### Tests first

Create `tests/runManifest.test.ts` with:

- `test_createRunManifestWritesUnderTheGitCommonDirectory`
- `test_writeRunManifestUsesAtomicReplacement`
- `test_transitionTaskStateRejectsAnInvalidTransition`
- `test_resumeRunRejectsAManifestVersionMismatch`
- `test_resumeRunRejectsASourceOidMismatch`
- `test_resumeRunRejectsARegistryRevisionMismatch`

Create `tests/runLock.test.ts` with:

- `test_acquireRunLockRecordsTheRunIdAndSelectedTasks`
- `test_overlappingRunIsRejectedWithTheOwningRunId`
- `test_disjointRunIsRejectedWhileRepositoryPublicationIsActive`
- `test_releaseRunLockRequiresTheOwningRunId`

### Implementation

Create `scripts/runManifest.ts`:

- define versioned `RunManifest`, `RunTaskState`, `AgentAttempt`, `TaskResult`,
  `TestReceipt`, `ApprovalRecord`, and `PublicationRecord` types;
- add `createRunManifest`, `readRunManifest`, `writeRunManifestAtomically`, and
  `transitionRunTaskState`;
- store every transition with its previous state, next state, timestamp, and
  reason.

Create `scripts/runLock.ts`:

- store the lock under `<git-common-dir>/taskTools/run.lock`;
- add `acquireRunLock`, `readRunLock`, and `releaseRunLock`;
- permit parallelism only inside one scheduler run; do not permit two schedulers
  to publish into the same repository graph concurrently.

Update `scripts/prepareTasks.ts` to create the manifest and lock before creating
any branch or worktree. On preparation failure, update the manifest with the
failure and leave it readable.

### Verify

```text
node --test tests/runManifest.test.ts tests/runLock.test.ts tests/prepareTasks.test.ts
npm test
npm run typecheck
```

## 6. Replace reusable group worktrees with run-scoped worktrees

### Tests first

Extend `tests/prepareTasks.test.ts` with:

- `test_worktreePathContainsRepositoryIdentityAndRunId`
- `test_twoRepositoriesWithTheSameBasenameUseDifferentWorktreePaths`
- `test_aFreshRunNeverResetsAnExistingWorktreeBranch`
- `test_resumeUsesOnlyTheWorktreeRecordedInItsManifest`
- `test_resumeRefusesADirtyUnrecordedWorktree`
- `test_prepareLeavesTheSourceWorkingTreeClean`
- `test_preparationFailureLeavesAReadableManifest`

Delete or rewrite the current test that expects a stale worktree commit to
disappear after forced branch reset.

### Implementation

Change `scripts/prepareTasks.ts`:

- accept `runId` and the persisted repository manifest as inputs;
- build worktree paths from a repository identity hash plus `runId` and group ID;
- create new branches from recorded source OIDs;
- remove all `checkout --force -B` reuse behavior;
- allow reuse only in an explicit `resume` mode after manifest, path, branch,
  OID, and cleanliness validation;
- record each created worktree and branch immediately in the run manifest.

Use `buildCanonicalTaskGroups` from `scripts/canonicalTaskGroups.ts`; do not call
raw `groupTasksByFileOverlap` in production preparation. Set each prepared
task's owned files from that task, and keep the group union in a separate field.

Call `snapshotWorkerRecovery` from `scripts/recoveryRefs.ts` after worktree
creation and after each completed worker attempt. Record the recovery ref in the
run manifest.

### Verify

```text
node --test tests/prepareTasks.test.ts tests/canonicalTaskGroups.test.ts tests/recoveryRefs.test.ts
rg -n 'checkout.*--force|worktree.*--force' scripts/prepareTasks.ts scripts/mergeTaskWorktrees.ts
npm test
npm run typecheck
```

The `rg` command must return no forced worktree reset or removal.

## 7. Extract and test the task-pipeline state machine

### Tests first

Create `tests/pipelineState.test.ts` with:

- `test_missingPlannerResultBecomesNeedsClarification`
- `test_wrongPlannerTaskNumberIsRejected`
- `test_missingWorkerResultBecomesBlocked`
- `test_wrongWorkerTaskNumberIsRejected`
- `test_partialResultReceivesAtMostOneRetry`
- `test_retryUsesOnlyTheOriginalDeadlineRemainingTime`
- `test_missingRetryResultBecomesBlocked`
- `test_ownershipViolationCannotBecomeComplete`
- `test_failingTestReceiptCannotBecomeComplete`
- `test_summaryArraysAreDerivedFromCanonicalTaskResults`

Create `tests/tackleTasksWorkflow.test.ts` with an injected workflow harness for
`args`, `agent`, `parallel`, `pipeline`, and `log`. Test the workflow without
launching real agents.

### Implementation

Create `scripts/pipelineState.ts` with pure operations for:

- validating planner and worker result schemas;
- calculating remaining time from one task deadline;
- choosing whether one partial retry is allowed;
- transitioning task phases;
- deriving the final return object from canonical task results.

Create `skills/tackle-tasks/tackle-tasks.briefs.js` and move planner, verifier,
worker, and repair prompt builders out of
`skills/tackle-tasks/tackle-tasks.workflow.js`.

Change `writeTaskBriefFile` so the brief contains the task record, repository
facts, and owned-path list only. Stop embedding entire source files. Planner and
worker prompts may read the task's owned files from the worktree.

Change `tackle-tasks.workflow.js` to call the pure state operations after every
agent result. Keep tasks serial within a canonical group and groups concurrent.
Do not maintain separate mutable `merged`, `blocked`, and conflict result stores.

Before implementing the deadline, add
`skills/tackle-tasks/workflow-timeout-probe.workflow.js`. The probe launches a
deliberately long agent with a 100 ms workflow timeout and records whether the
runtime cancels the agent rather than only abandoning its result. Run the probe
once against the supported Claude Code version.

- If cancellation succeeds, use that same documented workflow option and pass
  the remaining task budget to every agent call.
- If cancellation does not stop the agent, do not use `Promise.race`. Replace
  workflow agent launching with a cancellable Agent SDK subprocess before
  claiming that task deadlines are enforced.

Persist each attempt's start, end, duration, phase, attempt number, model, effort,
result validation, and termination reason in the run manifest.

### Verify

```text
node --test tests/pipelineState.test.ts tests/tackleTasksWorkflow.test.ts
npm test
npm run typecheck
```

Also run the timeout probe and attach its JSON result to the implementation
notes. A timeout test that leaves the agent running does not pass this step.

## 8. Make test discovery and execution deterministic

### Tests first

Extend `tests/testPolicy.test.ts` and `tests/relatedTests.test.ts` with:

- `test_testPolicyReturnsExecutableAndArgumentArray`
- `test_relatedTestsNeverRunsTheCompleteSuiteAsItsFallback`
- `test_duplicateRelatedCommandsRunOncePerRepositoryAndDigest`
- `test_aTimedOutTestCommandProducesAFailingReceipt`
- `test_fullOutputIsStoredWhileTheResultContainsOnlyABoundedTail`
- `test_greenReceiptIncludesCommandWorkingDirectoryAndCandidateOid`

### Implementation

Change `scripts/testPolicy.ts` so a policy stores `executable`, `arguments`, and
`workingDirectory`; stop returning shell command strings.

Change `scripts/relatedTests.ts`:

- execute commands with `execFile`/`spawn`, not `execSync` shell strings;
- accept an abort signal and output limit;
- deduplicate by repository occurrence, command, and candidate digest;
- return a structured `TestReceipt`;
- report `needsResolution` when no related-test command exists instead of using
  the complete suite after every edit.

Add complete-suite execution to the final candidate verification path only.
Store full logs in the run directory and put only the bounded failure tail in
agent context.

### Verify

```text
node --test tests/testPolicy.test.ts tests/relatedTests.test.ts tests/syncVerification.test.ts
npm test
npm run typecheck
```

## 9. Wire preparation, approval, publication, and archival into one run

Start this step only after tasks 33–36 and their acceptance fixture are on the
branch.

### Tests first

Update `tests/prepareTasks.test.ts` and `tests/mergeTaskWorktrees.test.ts`; add
`tests/tackleTasksEndToEnd.test.ts` with:

- `test_workflowReturnsReadyForApprovalBeforePublication`
- `test_noBaseRefMovesBeforeApproval`
- `test_approvalDigestChangesWhenTaskResultsDrift`
- `test_approvalDigestChangesWhenATestReceiptDrifts`
- `test_parallelGroupsPublishThroughOneSerializedFinalizer`
- `test_contentConflictLeavesEveryBaseRefUnchanged`
- `test_gitlinkResolutionUsesThePreparedChildOid`
- `test_publicationFailureRollsBackEarlierRefUpdates`
- `test_onlyExplicitlyPublishedTasksAreArchived`
- `test_mixedSuccessNeverArchivesConflictedOrBlockedTasks`

### Implementation

Change `scripts/prepareTasks.ts` to return the run manifest path and normalized
workflow arguments.

Change `tackle-tasks.workflow.js` to stop after all eligible task results and
test receipts are persisted. Return `readyForApproval`, the approval digest
inputs, and all non-ready task results. Do not invoke the merge CLI from the
workflow.

Change `skills/tackle-tasks/SKILL.md`:

1. invoke the workflow;
2. present canonical task results and review handoffs;
3. ask the user once when `readyForApproval` is true;
4. after approval, invoke the finalizer CLI with the manifest path and approval
   response;
5. report publication and archival results from the final manifest.

Change `scripts/mergeTaskWorktrees.ts` into the finalizer CLI adapter. It must
call the production Phase 4 operations in this order:

1. reread and validate the run manifest;
2. record approval with `approvalGate.ts`;
3. call `runFinalizer.ts` to consolidate logical repositories;
4. run complete suites against the final candidate;
5. revalidate approval inputs;
6. call `operationPush.ts` and `basePublication.ts`;
7. call `taskArchival.ts` with the explicit published task numbers;
8. persist the final result and append metrics once.

Delete the old `resolveGitlinkConflicts` behavior. Recursive consolidation must
receive the prepared child OID; any other gitlink conflict returns `conflict`.

### Verify

```text
node --test tests/tackleTasksEndToEnd.test.ts tests/revengEndToEnd.test.ts tests/mergeTaskWorktrees.test.ts
npm test
npm run typecheck
```

## 10. Replace the three parallel post-edit hooks with one sequenced hook

### Tests first

Create `tests/postEditChecks.test.ts` with realistic Claude `PostToolUse` stdin:

- `test_postEditChecksReadsToolInputFilePath`
- `test_postEditChecksRecordsTheTurnBeforeReflowing`
- `test_postEditChecksRunsRelatedTestsAfterReflow`
- `test_postEditChecksDoesNotReadANonexistentToolCallsArray`
- `test_postEditChecksStoresFullTestLogsOutsideHookOutput`
- `test_postEditChecksReturnsAConciseFailureToClaude`

### Implementation

Extract callable functions from:

- `scripts/turn-modified-flag.ts`;
- `scripts/reflow-comments-post.ts`;
- `scripts/relatedTests.ts`.

Create `scripts/postEditChecks.ts`. Read one standard `PostToolUse` payload and
run these operations in order:

1. record the edited path for the session;
2. reflow comments;
3. run the resolved related-test command for the reflowed file;
4. emit one hook response.

Update `hooks/hooks.json` so `PostToolUse` has one command handler for
`Edit|Write|NotebookEdit`. Remove the three parallel handlers.

### Verify

```text
node --test tests/postEditChecks.test.ts tests/reflow-comments-post.test.ts tests/relatedTests.test.ts
npm test
npm run typecheck
```

## 11. Add the bounded task-loop state machine

### Tests first

Create `tests/taskLoop.test.ts` with:

- `test_loopStopsWhenNoOpenTasksRemain`
- `test_loopWaitsWithoutLaunchingAgentsWhenEveryTaskIsBlocked`
- `test_loopReturnsWaitingForUserOnClarification`
- `test_loopReturnsWaitingForUserOnApproval`
- `test_loopNeverLaunchesATaskReservedByAnotherRun`
- `test_loopStopsAfterTheConfiguredRepeatedFailureLimit`
- `test_loopBackoffIncreasesAfterRepeatedInfrastructureFailures`
- `test_loopResumeDoesNotDuplicateThePreviousPass`

### Implementation

Create `scripts/taskLoop.ts` with `runTaskLoopPass(loopState, registrySnapshot,
activeRun)` as a pure state transition. Persist loop state under
`<git-common-dir>/taskTools/loops/<loopId>.json`.

Create `scripts/taskLoopCli.ts` with `start`, `next`, `status`, `resume`, and
`stop` modes. One `next` invocation performs one bounded decision and returns
one of:

- `runTasks` with an explicit task-number list;
- `waitingBlocked` with blocker details;
- `waitingForUser` with clarification or approval data;
- `backingOff` with the next eligible timestamp;
- `complete`;
- `failed`.

Create `skills/run-task-loop/SKILL.md`. It calls `taskLoopCli.ts next`, invokes
`tackle-tasks` only for `runTasks`, records that result, and schedules another
pass through the supported loop facility. It never invents task numbers or
answers clarification/approval itself.

### Verify

```text
node --test tests/taskLoop.test.ts tests/taskRegistry.test.ts tests/runLock.test.ts
npm test
npm run typecheck
```

## 12. Record cost metrics and remove repeated context work

### Tests first

Extend `tests/tackleMetrics.test.ts` with:

- `test_appendMetricsIsIdempotentByRunId`
- `test_metricsContainOneRecordPerAgentAttempt`
- `test_metricsContainPhaseDurationsAndContextBytes`
- `test_metricsCountAgentLaunchesAndTestCommands`
- `test_metricsDistinguishTaskDeadlineFromAttemptDuration`

Extend `tests/prepareTasks.test.ts` with:

- `test_taskBriefDoesNotEmbedCompleteOwnedFiles`
- `test_taskBriefRecordsItsUtf8ByteCount`

### Implementation

Change `scripts/tackleMetrics.ts`:

- derive the record from the final run manifest;
- include per-task phase durations, attempts, agent-launch count, test-command
  count, brief bytes, outcome, and recovery status;
- include model token fields only when the workflow/SDK result supplies them;
- make final append idempotent by checking `runId` under a metrics lock;
- reject a second record whose same `runId` has different content.

Remove complete-file contents from generated briefs. Keep full test output and
Git diagnostics in run files; pass bounded summaries and paths to agents.

Create `tests/fixtures/tacklePerformanceCases.ts` defining the same small,
disjoint, overlapping, blocked, timeout, and recursive cases used for every
before/after measurement. Add `scripts/tacklePerformanceReport.ts` to compare
two metrics files by case.

### Verify

```text
node --test tests/tackleMetrics.test.ts tests/prepareTasks.test.ts
npm test
npm run typecheck
node scripts/tacklePerformanceReport.ts plans/tackle-baseline.jsonl plans/tackle-metrics.jsonl
```

Do not declare a token improvement when token data is unavailable. In that case,
report brief bytes, agent launches, test executions, success rate, and wall time.

## 13. Update entry points and retain one-release compatibility shims

### Tests first

Create `tests/pluginEntryPoints.test.ts` with:

- `test_everySkillCommandPathExists`
- `test_everyHookCommandPathExists`
- `test_pluginAndMarketplaceVersionsMatch`
- `test_legacyScriptEntryPointsForwardToTheNewCli`
- `test_pluginSkillsAreFoundThroughTheDefaultSkillsDirectory`

### Implementation

- Update all `SKILL.md`, hook, README, plugin, and marketplace paths.
- Keep forwarding files at old public script paths for one release. Each shim
  imports or invokes the new entry point without duplicating behavior.
- Bump `.claude-plugin/plugin.json` and both version fields in
  `.claude-plugin/marketplace.json.devblock` together.
- Do not add an inventory of every skill to the manifest; the default `skills/`
  directory is the source of truth.
- Document `run list`, `run resume`, `run cleanup`, registry recovery, task-loop
  status, and rollback commands in `README.md`.

### Verify

```text
node --test tests/pluginEntryPoints.test.ts
npm test
npm run typecheck
git diff --check
```

## Final acceptance

Run all acceptance work against disposable repositories and copied registries,
not TaskTools' live backlog.

1. Run one task in a plain repository and verify exact publication and archival.
2. Run three disjoint tasks and verify parallel workers plus serialized
   finalization.
3. Run three overlapping tasks and verify serial execution in one canonical
   group.
4. Run a mixed complete/blocked/conflict batch and verify only the published
   task is archived.
5. Run the RevEng recursive fixture and verify repeated occurrences converge.
6. Terminate a worker, verifier, test command, consolidator, and publisher in
   separate runs; verify each manifest names a resolvable recovery ref and resume
   command.
7. Move a source ref after approval and verify publication refuses it.
8. Start a second scheduler and verify it reports the first run instead of
   creating worktrees.
9. Run the task loop against empty, fully blocked, clarification, approval, and
   repeatedly failing backlogs; verify it does not spin or duplicate agents.
10. Run the performance fixtures and compare agent launches, test executions,
    brief bytes, success rate, recovery rate, wall time, and tokens when exposed.

The implementation is complete only after `npm test`, `npm run typecheck`, and
`git diff --check` pass and the ten acceptance runs have their manifests and
results attached to implementation notes.
