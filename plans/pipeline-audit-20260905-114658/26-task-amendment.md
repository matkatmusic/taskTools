# Amendment: Task 26 plan — acceptance test: run tackle-tasks end to end from a separate target repository

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/26-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/26.json and the live tackle-tasks workflow and skill
Sections: 12 | Fixes: 6
Efficacy: 50%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/26-task.md must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The driver looks up the first prompt answer under the wrong box

- Evidence: `[plans/pipeline-audit-20260905-114658/26-task.md:29-57, scripts/runStepHook.ts:251-262]`
- The plan claims: `const promptBox = box.split("::").pop()` identifies the prompt box just reached.
- Actually true: `box` is the block at which that hook pass started. The hook can walk through many green blocks before stopping at a prompt, and names the packet from `output.box`. On the baseline's first pass, `box` is `PREAMBLE_STATUS_CHECK` while the payload is produced by `PLAN_THE_TASK`; the driver therefore asks for `answers.PREAMBLE_STATUS_CHECK` and fails before using the planning answer.

### 2. The scripted agents and their required side effects are not specified

- Evidence: `[plans/pipeline-audit-20260905-114658/26-task.md:61-65, plans/pipeline-audit-20260905-114658/26-task.md:86-88]`
- The plan claims: `standardHappyPathAnswers` supplies the minimum valid planning, implementation, and review behavior.
- Actually true: the plan defers discovering the prompt boxes and contracts until implementation and only defines answer objects. Real agents also create a plan, edit implementation/test files, write review artifacts, and sometimes amend task state. Without explicit deterministic side effects and a complete ordered prompt transcript, the baseline cannot be implemented from this plan or prove the real workflow contract.

### 3. The baseline skips task tests and still reaches the full-suite block

- Evidence: `[plans/pipeline-audit-20260905-114658/26-task.md:69-88, diagrams/tackle-tasks/pipeline-commitImplementationIfNeeded.mmd:22-31, diagrams/tackle-tasks/pipeline-rebase.mmd:18-22, scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts:23-40]`
- The plan claims: `hasTests: false` keeps the baseline out of `RUN_FULL_SUITE`, while a later scenario will exercise the test-fix loop.
- Actually true: `hasTests: false` bypasses `RUN_TASK_TESTS` and goes to the source-lock/rebase path; a conflict-free rebase then always enters `RUN_FULL_SUITE`. The described fixture has no explicit test policy or executable task test, so it does not satisfy task 26's requirement to run through task tests, and the claimed routing is false.

### 4. The concurrency scenario is sequential and its isolation assertion is tautological

- Evidence: `[plans/pipeline-audit-20260905-114658/26-task.md:120-143]`
- The plan claims: `Promise.all([driveRun(...), driveRun(...)])`, or wrapping those synchronous calls in `setImmediate`, runs two target repositories concurrently and proves their generated configurations never cross.
- Actually true: each `driveRun` call uses blocking `execFileSync` and is evaluated before `Promise.all` receives the array; `setImmediate` callbacks still execute one blocking driver at a time on the same event loop. Also `firstSteps !== secondSteps + "-different-project-marker"` is true for nearly every pair of strings and proves no project identity or isolation property.

### 5. The pre-creation failure changes permissions on the shared worktree root

- Evidence: `[scripts/prepareTasks.ts:376-384, plans/pipeline-audit-20260905-114658/26-task.md:145-166]`
- The plan claims: chmodding `dirname(resolveTaskWorktreeConventionDirectory(root))` is a fixture-scoped way to make one target's worktree creation fail.
- Actually true: every target convention directory has the common parent `join(tmpdir(), "taskTools-wt")`. Changing that parent's mode affects all target repos and concurrently running tests, exactly the isolation behavior this acceptance suite is intended to validate.

### 6. Three required scenarios remain pseudocode and the verification permits a red result

- Evidence: `[plans/pipeline-audit-20260905-114658/26-task.md:168-227, plans/pipeline-audit-20260905-114658/26-task.md:229-253]`
- The plan claims: it defines deterministic source-lock failure, conflict-fix, and interrupted-cleanup/resume acceptance cases.
- Actually true: the lock precondition says to adjust it later; deleting `staging` is not established to fail after lock acquisition. The conflict setup is deferred and the `FIX_CONFLICTS` answer never performs the file edit that resolves the conflict. Cleanup contains literal `... spawn, poll, kill ...` pseudocode and an unresolved worktree suffix. Verification explicitly allows required cases to remain red, so completion would not mean the acceptance test is usable or passing.

## Durable fixes

### Fix for issue 1

- Change: Derive the stopped prompt box from the packet filename or the final `result.ran` entry, validate it against the packet's prompt, and add a driver unit test where one invocation walks from preamble through several green boxes to `PLAN_THE_TASK`.
- Durable because: Answer dispatch follows the hook's actual stop point rather than the caller's starting point.

### Fix for issue 2

- Change: Enumerate every prompt expected on the happy path and define each stub's answer plus filesystem/git side effects. Prefer an injectable agent callback keyed by the stopped prompt packet, with assertions that no unexpected or repeated prompt is silently accepted.
- Durable because: Diagram or contract drift produces a focused acceptance failure instead of being filled in ad hoc during implementation.

### Fix for issue 3

- Change: Give the fixture a minimal real test policy, implementation file, and test file; set `hasTests: true`; make the implementation stub change behavior while the task-test and full-suite commands pass. Add a separate `hasTests: false` route test only if skip behavior is also required.
- Durable because: The baseline exercises both testing stages named by the acceptance requirement and cannot pass merely because no suite is discoverable.

### Fix for issue 4

- Change: Run each complete driver in a separate child process with a barrier that proves both reached a chosen hook point before either proceeds. Seed distinguishable per-project workflow/steps data and assert each generated file contains only its own absolute project paths and each staging branch receives only its own change.
- Durable because: Actual process overlap and meaningful project-specific assertions expose shared mutable configuration.

### Fix for issue 5

- Change: Add a test-only, fixture-scoped failure injection at the pre-creation operation, or inject an isolated worktree-base resolver for the child. Never chmod the shared `taskTools-wt` parent. Assert unrelated fixture creation remains possible while the failure is held.
- Durable because: Failure injection cannot perturb another repository or parallel test.

### Fix for issue 6

- Change: Replace all deferred comments and ellipses with executable setup: name the exact post-lock block and injected failure, perform the conflict edit before writing its receipt, add an observable kill hook/barrier for a specific cleanup operation, and restart via the real workflow entry. Add every implementation task those scenarios require (including crash-safe reset/cleanup work) as a dependency, and require every acceptance case plus the full suite to be green before task 26 is complete.
- Durable because: The final acceptance task becomes a deterministic release gate rather than a scaffold that can succeed while required cases are missing or red.

## Sections that hold up

- Use of a separate real Git repository and plugin-root script paths — verified against `scripts/tackle-tasks/shared/SkillBodyEmitter.test.ts:22-37`
- Agent answers must use the packet envelope — verified against `scripts/tackle-tasks/shared/writeAgentAnswer.ts:1-15`
- The target-path-with-spaces case uses argument-array process APIs — verified against `plans/pipeline-audit-20260905-114658/26-task.md:90-100`
- Success assertions cover archive membership and the staging tree — verified against `plans/pipeline-audit-20260905-114658/26-task.md:67-83`
