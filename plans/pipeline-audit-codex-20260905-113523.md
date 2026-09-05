# Adversarial review of the tackle-tasks audit task list

Reviewed: 2026-09-05 11:35 PDT

Scope:

- `/Users/matkatmusicllc/.claude/tasks/taskTools-86/*.json`
- `.taskTools/tasks.json` tasks 194 and 195, because several audit tasks depend on them
- `skills/tackle-tasks/`, `scripts/tackle-tasks/`, `scripts/runStepHook.ts`, `scripts/generateSteps.ts`, `scripts/generateWorkflow.ts`, `scripts/taskFiles.ts`, `hooks/hooks.json`, and `diagrams/tackle-tasks/`
- the 210 current `*run-log.json` files

This document contains disagreements and missing work only. It does not repeat findings that hold up.

## Critical: task 10 / task 194 does not make the workflow safe for global use

Task 10 correctly moves each workflow file into the target project. That change fixes only the `scriptPath` location.

`SkillBodyEmitter.ts:34-38` still regenerates `steps.json` before every launch. Without `RUN_STEP_CONFIG`, it writes the shared plugin file from `DEFAULT_STEPS_CONFIG_PATH` at line 10. `runStepHook.ts:29-31,77` later reads that same shared plugin file.

This creates three remaining failures:

1. A project with a custom diagram replaces the shared configuration used by every other project.
2. Two concurrent projects can overwrite or read this file at the same time.
3. A read-only plugin installation cannot support this write.

Per-task workflow files do not isolate routing. The task also says `.taskTools/workflows/` becomes ignored by editing this repository's `.gitignore`. That does not change another project's `.gitignore`. `scripts/taskFiles.ts` must ship the rule to the target project.

The task's “each file carries only its own task number” test also disagrees with the proposed implementation. `buildWorkflowScript(taskNumber)` only needs the number for `meta.name` as written. Runtime `args.task` remains unconstrained. Either bake and validate the expected number, or change that test and goal.

Required correction: `steps.json` must be generated per task, just like that task's generated `workflow.js`, rather than written to the shared plugin path. Store the two files together under the task's target-project state (for example, `.taskTools/workflows/<task-number>/workflow.js` and `.taskTools/workflows/<task-number>/steps.json`) and have the hook load the matched pair for that task. The pair must remain immutable for the lifetime of the run so another task, project, or plugin update cannot change its routing mid-run. Add a real acceptance test from a separate target repository, and run two tasks concurrently with different diagrams to prove their step configurations cannot overwrite or cross-load one another.

## Critical: task 195 inserts its rebase on a path that normal resume bypasses

Task 195 says to insert `REBASE_RESUMED_WORKTREE_ONTO_STAGING` after `IS_PREVIOUS_RUN_RESUMABLE_Q` in the preamble.

That does not cover the usual resume path. `runStepHook.ts:296-300` calls `findResumeEntry()` before it walks the preamble. When a worktree and checkpoint exist, `resumeRun.ts:20-27` returns the checkpoint block directly. The walk never reaches `IS_PREVIOUS_RUN_RESUMABLE_Q`.

The proposed end-to-end test should expose this, but `resumeRun.ts` is absent from task 195's modifiable files. The task cannot implement its main goal as scoped.

Required correction: put the staging-movement check in the direct checkpoint-resume path, or route all resumes through one preamble gate. Test a real checkpoint resume, not only an existing-worktree preamble walk.

The root-only `git merge-base --is-ancestor staging HEAD` check also misses independently moved source branches in submodules. The rebase helper supports repository occurrences, so the decision must use the same occurrence set or explicitly narrow the product contract.

## Critical: task 12's one-line fix is not shipped to existing target projects

Task 12 says adding `**/plans/checkpoint.json` to `DEFAULT_IGNORE_PATTERNS` fixes the target-repository problem.

It does not. `seedTaskFilesIfAbsent()` calls `seedGitignore()` only when the `.taskTools` directory does not exist (`scripts/taskFiles.ts:42-45`). Every established target project already has that directory. Those projects never receive a new ignore pattern.

The proposed fresh-fixture test would pass while upgrades remain broken.

Required correction: call the idempotent `seedGitignore()` on every seed/use path, not only directory creation. Test both a new target and an existing target with `.taskTools/tasks.json` already present. Task 10's `.taskTools/workflows/` rule needs the same mechanism.

## Critical: task 13's proposed failure edge can fail inside the failure handler

Task 13 does not state exactly where the disk check sits. If it runs immediately before `CREATE_WORKTREE`, the task is already active but `packet.worktree` is still empty.

Routing that packet into `FAILURES_EXIT` is unsafe. `READ_FAILURES_PUBLICATION_STATE.ts:10-13` calls `buildWorktreeOccurrences()` with the empty path. Later, `RECORD_MODIFIED_FILES_FAILURE.ts:13-16` also assumes a real worktree. The intended clean report can become another hard failure.

The phrase “worktree volume” is also undefined before the worktree exists. Worktrees live below the temporary-directory convention, which can be a different volume from `projectRoot`.

Required correction: compute the intended worktree parent and check its nearest existing ancestor before `MARK_TASK_ACTIVE`, then route low space to `REPORT_ONLY_EXIT`. If the check remains after the claim, add a no-worktree cleanup path that ends the run without publication-state or diff inspection.

A fixed 2 GB threshold is only a heuristic. It does not establish enough space for an arbitrary repository and test suite. The task should state that it prevents the observed failure but does not guarantee capacity.

## Critical: task 20 checks defaults, not the current permission mode

Reading the project and user `settings.json` files cannot tell whether the current session is in plan mode.

Claude Code settings have more sources. Local project settings override shared project and user settings. Managed settings and command-line flags can also override them. A user can change mode after session start. Therefore, the proposed check can both refuse a usable session and allow a blocked session.

The hook payload already reports the current `permission_mode`. The official hook reference shows it on `UserPromptSubmit` input: <https://code.claude.com/docs/en/hooks#common-input-fields>.

Required correction: inspect `permission_mode` in a hook before skill expansion and block only when its live value is `plan`. Do not infer live state from configuration defaults. Test shared, local, command-line/session override, and a mode changed during the session.

## High: task 9's “43 of 126 real runs” premise is false

The audit counts log files as runs. One workflow run can write two sibling logs with the same stamp:

- `<stamp>-task-N-run-log.json` for the task-bearing pass
- `<stamp>-run-log.json` for later packet-file passes, because `currentTaskNumber` is not restored after `runDirectory` changes

For example, `2026-09-04T22-19-40-56312-task-113-run-log.json` ends at `PLAN_THE_TASK`. Its sibling `2026-09-04T22-19-40-56312-run-log.json` continues through the plan review and records `FAILURE`. This is not a mid-agent death.

I regrouped all 43 cited prompt-ending files by stamp. They represent 41 stamps. Seventeen prompt-ending files belong to groups that have a terminal `FAILURE`, `HOOK EXCEPTION`, or `STOP`. Only 24 stamp groups remain open by this test, before deduplication by task `runId`.

Required correction: first fix or account for split logging. Recompute by durable `runId`, not filename. Then distinguish agent failure, user/session cancellation, in-progress work, and a later resumed pass. The task's count and percentage must not guide prioritization as written.

## High: task 18 confuses shape validation with semantic validation

The workflow has four error returns, not five. `outcome.next === null` is its normal success return (`generateWorkflow.ts:92-95`). Calling all five “early-return failure branches” is false.

The claim that a missing answer silently reaches `COMMIT_IMPLEMENTATION_IF_NEEDED` or `COMMIT_SUITE_FIX_IF_NEEDED` is also false. Their input templates require `message` and `additionalData`. `runStepHook.ts:302-305` validates the start packet before the consumer runs. `tests/runStepHook.test.ts:248-261` already proves a missing `message` becomes a contract failure.

The real defect is semantic:

- `COMMIT_IMPLEMENTATION_IF_NEEDED.ts:13` discards `{implemented, notes}` inside `additionalData`, so `implemented:false` still proceeds.
- `COMMIT_SUITE_FIX_IF_NEEDED.ts:23-42` ignores `fixSummary`, although the next full-suite run gives an independent result.
- `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts:15-29` ignores the conflict receipt, although live Git state can independently prove resolution.

Required correction: keep the workflow branch tests, but rewrite the consumer work around each prompt's meaningful result and the authoritative filesystem/Git check. Do not add another generic “fields exist” test that duplicates the current contract test.

## High: task 7's path-aware parse remedy cannot work as described

Task 7 says to check existence and non-empty content, then “let parse throw with the path in the message.” `JSON.parse()` does not include the source path in its error. A non-empty truncated `plan.json` still produces only a syntax location.

Atomic `writeAgentAnswer()` output fixes only a kill during that one writer. It does not address:

- planner-written `plan.json`
- Codex review files parsed by `readReviewJson.ts:4-15`
- non-atomic `checkpoint.json` writes in `checkpoint.ts:29-32`
- non-atomic run-log rewrites in `runStepHook.ts:123-128,281-284`
- the uncaught-exception handler parsing the same possibly malformed run log at `runStepHook.ts:19-25`

Required correction: define a path-aware JSON reader that raises an error naming the file, or catch only at the orchestration boundary and build a `FAILURE`. Use atomic writes for every pipeline-owned state file. Agent-owned files need validation before the next state transition. Add a non-empty truncated-file case; an empty-file test is insufficient.

## High: task 16's proposed lease assertion conflicts with the safety design

Task 16 proposes a test where “crash after worktree deletion leaves no lease.” That is not always safe.

`cleanupTaskWorktree.ts:82-90` intentionally retains the lease whenever cleanup leaves artifacts. `cleanupTaskWorktree.test.ts:80-100` asserts this rule. The lease protects remaining task branches, merge refs, and partially removed work. Releasing it merely because the directory disappeared can allow a new run to collide with those artifacts.

The real bug is loss of a resumable cleanup cursor. `resumeRun.ts:29-37` skips back to closure after the worktree and its checkpoint disappear.

Required correction: persist cleanup progress outside the disposable worktree and resume `CLEAN_UP_WORKTREES` until every protected artifact is gone. Release the lease only when `collectRetainedTaskArtifacts()` is empty. For rebase, release the source lock on every exceptional exit after acquisition, not only the two explicit throws at lines 149 and 167. Preserve the lock for the deliberate conflict-resolution path.

## High: task 17 leaves another unbounded suite runner in the pipeline

Task 17 limits `taskTestsRunner.ts`, but `shared/runFullSuite.ts:24-34` still uses `execSync(command)` without a timeout. A hung full suite remains able to consume the outer five-minute block limit and leave descendants alive.

Required correction: use one process-tree-aware runner for both task tests and each full-suite occurrence. The timeout result must be persisted as a normal red or operational failure before the outer hook kills the block. If the implementation uses negative process-group identifiers, state and test the POSIX-only assumption; that mechanism is not portable to Windows.

## High: task 14 now has a confirmed, more complex timeout mismatch

The official Claude Code hook documentation now states:

- command hooks default to 10 minutes
- `UserPromptSubmit` lowers that default to 30 seconds

Source: <https://code.claude.com/docs/en/hooks-guide#limitations>

`runStepHook.ts` is registered for both `UserPromptSubmit` and `PostToolUse:Skill` without its own timeout (`hooks/hooks.json:3-17,62-72`). Therefore, there is no single default ceiling. A typed `/run-step` can die near 30 seconds. A workflow skill call can die near 10 minutes. Both are shorter than the 15-minute lock loop.

Required correction: set explicit hook timeouts for both registrations and make the lock-wait deadline shorter than the smallest supported ceiling. Better, yield a durable retry state instead of sleeping in one hook call. Test both hook event paths.

## High: task 8 must forbid advancing staging from an arbitrary session branch

The task correctly identifies the fragile error-message parser and failed `--ff-only` fallback. Its proposed alternatives remain undecided.

Under the stated product contract, `staging` contains work that passed this pipeline for user review. `resolveOrCreateStagingTip()` currently moves an existing `staging` ref to the caller's current `HEAD` whenever staging is its ancestor (`prepareTasks.ts:186-202`). That can put unrelated current-branch commits into staging without any pipeline review.

Required correction: use an existing staging tip as-is. Create staging from `HEAD` only when the branch is absent. Pipeline merge code should be the only normal writer to an existing staging branch. This also removes the force-move conflict with the persistent staging worktree. Add a test proving a current branch ahead of staging does not advance staging during `CREATE_WORKTREE`.

## Medium: tasks 5 and 11 do not close runtime failure gaps

Task 5 combines a useful regeneration guard with edits to `_pipeline-monolith.mmd`, an overview that `generateSteps.ts:199-202` deliberately excludes. Stale overview text cannot break the pipeline. Split the regeneration test from documentation cleanup and prioritize the test.

Task 11 only comments out dead optional prompt code. It does not prevent or handle a run failure. It is relevant only because task 19 edits the same function. Keep it as cleanup, but do not count it as pipeline hardening.

## Medium: task 21's duplicate definition is too weak and one open question is already answered

An `(event, script path)` pair is not enough to identify duplicate execution. Two registrations under disjoint matchers can be valid. Conversely, the same command written with `node` versus `node --no-inspect`, or with a resolved path versus `${CLAUDE_PLUGIN_ROOT}`, can run twice while string comparison says they differ.

The current `taskTestsHook.ts` registration on two events is intentional. Its code has separate handling for typed prompts and Skill tool payloads (`taskTestsHook.ts:13-23`). One registration serves `UserPromptSubmit`; the other serves `PostToolUse:Skill`.

Required correction: compare normalized command identity plus overlapping event/matcher scope. Test the merged configuration sources Claude Code actually loads for a target project. Do not flag the intended two-event registration.

## Missing critical task: FIX_CONFLICTS emits the wrong answer protocol

The active conflict prompt ends with `printAsFinalMessageSection()` (`FixConflictsBodyEmitter.ts:84`). It asks the workflow agent to return raw `{resolved, unresolvedPaths}`.

The surrounding run-step protocol requires `{message, additionalData}` and tells the agent to pass it to `writeAgentAnswer.ts`. That writer rejects the raw conflict receipt (`writeAgentAnswer.ts:5-9`). The compatible `whatToReturnSection()` call still exists only inside commented code in `FIX_CONFLICTS.ts:27-47`.

This path can fail exactly when a rebase conflict occurs, which is one of the pipeline's central recovery cases.

Required task: make the active prompt use the packet answer protocol. Validate `additionalData.resolved` and `unresolvedPaths`, then verify live unmerged paths before committing or continuing the rebase. Add an end-to-end conflict fixture through prompt answer consumption.

## Missing critical task: hard block failures do not enter a durable failure state

`runStepHook.ts:336-359` returns `buildFailure()` for timeouts, non-zero exits, missing output, and contract errors. `buildFailure()` only writes a log and returns an error object (`runStepHook.ts:203-210`). It does not enter `FAILURES_EXIT`, end the task run, or release held resources.

Resume can retry a valid checkpoint, but deterministic failures repeat forever. A crash inside the failures-exit chain is worse: `inFailureChain` suppresses later checkpoint writes (`runStepHook.ts:317,385-408`), so resume returns to the pre-failure box instead of the failed cleanup box.

Required task: persist a failure-tail cursor outside the worktree. Every hard failure after a task claim must either reach a terminal report or leave a precise resumable cleanup state. Add injected failures at each failures-exit box and prove the next invocation continues cleanup instead of rerunning task work.

## Missing critical task: worktree reset and creation are not crash-safe

`_createFreshTaskWorktree.ts:1-2` explicitly says a mid-step crash leaves a partial worktree for manual cleanup. `RESET_WORKTREE` can delete the old worktree and its checkpoint before replacement succeeds. The audit calls this PRE-12, but no pending task owns it.

Required task: use the existing external creation-journal pattern, or an equivalent durable intent, for the live `CREATE_WORKTREE` and `RESET_WORKTREE` blocks. Test termination after lease creation, worktree deletion, Git worktree creation, branch reset, and task-state publication.

## Missing high-priority task: lock mutation-guard recovery

The audit identifies a process death while holding `.git/taskTools-source.lock.mutation-guard` as a repository-wide permanent blocker. No pending task owns this gap.

Required task: add ownership data and a safe stale-recovery protocol for the mutation guard. Exercise kill points around guard acquisition, lock publication, refresh, and release. Recovery must never remove a guard owned by a live process.

## Missing high-priority task: end-to-end external-repository acceptance

The current unit tests mock paths or run from this plugin checkout. That allowed the external `scriptPath` failure, target `.gitignore` omissions, and shared plugin-state design to survive.

Required task: install or point the plugin from one checkout, invoke the skill from a separate repository, and run a minimal task through creation, planning stubs, implementation stubs, tests, staging merge, and archive. Include:

- a target path containing spaces
- an existing `.taskTools` directory
- two concurrent target repositories
- one injected failure before worktree creation
- one injected failure while the source lock is held
- one conflict-fix round
- one interrupted cleanup followed by resume

This acceptance test is the proof that the skill works globally. Per-module tests cannot provide that proof.
