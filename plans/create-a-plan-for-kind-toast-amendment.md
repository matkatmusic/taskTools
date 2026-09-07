# Amendment: Task 38: pick the model for each `agent()` call by block and difficulty

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/create-a-plan-for-kind-toast.md
- Reviewed against: Task 38 requirements and the current repository implementation
Sections: 14 | Fixes: 8
Efficacy: 43%
Ruling: plans/create-a-plan-for-kind-toast.md must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Bare starting blocks bypass their configured agent options

- Evidence: `[scripts/tackle-tasks/shared/resolveTaskRun.ts:43-50, scripts/tackle-tasks/shared/SkillBodyEmitter.ts:76-89, scripts/tackle-tasks/generateWorkflow.ts:60-74, scripts/hooks/runStepHook.ts:566-578]`
- The plan claims: The first input takes its agent options from `AGENT_BY_BLOCK[blockToRun]`, including when the caller supplies `args.startingBlock`.
- Actually true: Supported starting-block arguments may be bare names such as `IMPLEMENT_TASK`, while `AGENT_BY_BLOCK` is keyed only by `diagram.mmd::BOX`. The hook canonicalizes a bare name, but only after the workflow has already selected the first `agent()` options, so a bare restart runs on the session model.

### 2. The Step 4 executable test contradicts the planned first-call behavior

- Evidence: `[plans/create-a-plan-for-kind-toast.md:15, plans/create-a-plan-for-kind-toast.md:185-188, plans/create-a-plan-for-kind-toast.md:202-204]`
- The plan claims: The initial input contains the first block's resolved options and `agent()` spreads them, but `test_buildWorkflowScript_runsEachPassWithTheModelTheHookNamed` should assert that the first call has no `model`.
- Actually true: With the proposed initialization and spread, the first call must carry the configured relay model. Step 5 correctly expects that same call to use `haiku`, so the Step 4 assertion will fail or force an implementation that violates the stated design.

### 3. The proposed Step 4 and Step 5 configs cannot pass the fixed start-step guard

- Evidence: `[scripts/tackle-tasks/generateWorkflow.ts:12-30, tests/generateWorkflow.test.ts:11-27, tests/generateWorkflow.test.ts:196-200, plans/create-a-plan-for-kind-toast.md:212-217]`
- The plan claims: A config made with the existing `buildProject` helper, and a Step 5 config containing only `A` and `IMPLEMENT_TASK`, can be passed to `buildWorkflowScript`.
- Actually true: `buildWorkflowScript` always requires `pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK`. The existing helper hardcodes `one.mmd`, and the two-block Step 5 fixture omits the required key, so both proposed fixture patterns throw before testing agent options.

### 4. Step 5 parses the hook process's stdout at the wrong layer

- Evidence: `[scripts/hooks/runStepHook.ts:545-551, tests/runStepHook.test.ts:29-37, plans/create-a-plan-for-kind-toast.md:216-218]`
- The plan claims: Parse the spawned hook's first stdout line as the hook output and return it from the fake agent.
- Actually true: The process prints a hook injection envelope. The hook output is the first line inside `hookSpecificOutput.additionalContext`, after parsing that envelope; passing the outer object to the workflow does not provide `ok`, `ran`, or `outcome`.

### 5. Requiring difficulty breaks existing workflow-generation fixtures the plan does not migrate

- Evidence: `[scripts/tackle-tasks/shared/SkillBodyEmitter.test.ts:24-37, scripts/tackle-tasks/shared/SkillBodyEmitter.test.ts:40-149, tests/generateSteps.test.ts:294-329, plans/create-a-plan-for-kind-toast.md:98-103, plans/create-a-plan-for-kind-toast.md:116-120]`
- The plan claims: `resolveAgentOptions` should throw for a missing task or difficulty on every generated workflow, while only adding one new difficulty-bearing emitter test.
- Actually true: The shared `SkillBodyEmitter` fixture creates tasks without `difficulty`, and the custom-diagram integration invokes `skillBody` against an empty task list. Calling the resolver from `ensureTaskWorkflowPair` makes these existing tests fail before their current assertions.

### 6. Step 6 names legacy tests that do not drive this hook and misses a live fixed-hop driver

- Evidence: `[tests/taskWorkflowPlanImplementStage.test.ts:11-37, tests/taskWorkflowMergeStage.test.ts:16-56, tests/tackleTasksAcceptance.test.ts:91-107, tests/tackleTasksAcceptance.test.ts:193-234, tests/tackleTasksAcceptance.test.ts:318-337]`
- The plan claims: Update hook-walking drivers in `taskWorkflowPlanImplementStage.test.ts` and `taskWorkflowMergeStage.test.ts`, plus the two named acceptance drivers.
- Actually true: The two task-workflow files load the legacy `skills/tackle-tasks-v1_1/tackle-tasks.workflow.js` and never drive `runStepHook`. Meanwhile, the acceptance test has another live two-hop loop that immediately looks up and writes an answer on every hop; the new walker stop has no prompt, so this omitted loop will fail.

### 7. The live verification's eight-key expectation cannot follow the proposed emitter

- Evidence: `[plans/create-a-plan-for-kind-toast.md:97-113, plans/create-a-plan-for-kind-toast.md:192-200, plans/create-a-plan-for-kind-toast.md:242, scripts/tackle-tasks/diagram-steps.json:1-869]`
- The plan claims: The generated workflow's `AGENT_BY_BLOCK` should have 8 keys.
- Actually true: The resolver writes `agent` on every steps entry and the generator includes every entry whose `agent` is defined. The canonical config currently has 86 entries; eight is only the number of prompt entries, not the emitted map size.

### 8. The task-number bookkeeping targets unrelated archived tasks

- Evidence: `[plans/create-a-plan-for-kind-toast.md:1, plans/create-a-plan-for-kind-toast.md:233-235, .taskTools/completedTasks.json:643-671]`
- The plan claims: This is Task 38 and the change should mark Task 37 done.
- Actually true: This repository's Task 37 is the archived `tackle-unblocked-tasks` task and Task 38 is the archived `tackle-tasks-loop` task. Marking Task 37 done cannot close the model-selection work and risks changing an unrelated historical record.

## Durable fixes

### Fix for issue 1

- Change: Canonicalize `args.startingBlock` against the emitted step keys before initializing `input` or calling `agent()`, preserving the hook's zero-match and ambiguous-name failures, and add an executable bare-`IMPLEMENT_TASK` model-selection test.
- Durable because: Every entry path, including user-requested restarts, selects options with the same canonical key space as `AGENT_BY_BLOCK`.

### Fix for issue 2

- Change: Change the Step 4 assertion to expect the first call's configured options (haiku for the canonical start), matching Step 5 and the proposed initialization.
- Durable because: The unit and integration tests then enforce one consistent rule for the initial pass.

### Fix for issue 3

- Change: Extend the workflow-test helper to accept diagram keys and build the fixture's first entry as `pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK`; connect it across a diagram seam to `IMPLEMENT_TASK` and use the same canonical start in the real-hook call.
- Durable because: Config-specific workflow tests will exercise the same mandatory start invariant as production generation.

### Fix for issue 4

- Change: In Step 5, parse stdout as the injection envelope, split `hookSpecificOutput.additionalContext`, and parse its first line as the hook output before returning it from the fake agent.
- Durable because: The test will follow the hook's actual external protocol rather than depending on an impossible output shape.

### Fix for issue 5

- Change: Add a default valid `difficulty` to `makeTargetRepository`, seed task 999999 with a difficulty in the custom-diagram test, and audit other direct `skillBody` fixtures for the new precondition; keep dedicated missing-task and missing-difficulty tests explicit.
- Durable because: Existing behavior tests remain focused on their intended contracts while the resolver's new validation has isolated coverage.

### Fix for issue 6

- Change: Remove the two v1 workflow files from Step 6, inventory actual `runStepHook` drivers, and update the fixed two-hop acceptance loop as well as `driveRun` and the inline child to skip answer writing for payloads without `prompt`.
- Durable because: Every real test driver follows the two-stop protocol, and unrelated legacy coverage remains untouched.

### Fix for issue 7

- Change: Replace the hard-coded eight-key check with a comparison against all keys in the resolved per-task steps config, plus representative assertions for band, relay, and prompt blocks.
- Durable because: The verification follows the stated every-entry invariant and remains correct when diagrams add or remove blocks.

### Fix for issue 8

- Change: Identify the actual open task record for this work and update the title and Step 7 to that record; if there is no such record, remove both task-number claims and do not mutate archived Tasks 37 or 38.
- Durable because: Completion bookkeeping will be tied to the model-selection task's identity instead of reused historical numbers.

## Sections that hold up

- Data shapes and resolution precedence — verified against `scripts/tackle-tasks/generateSteps.ts:55-60` and `scripts/shared/taskFiles.ts:7-8`
- Hook schema extension — verified against `scripts/tackle-tasks/buildRunStepSchemas.ts:8-32`
- Walker-stop placement and prompt-stop separation — verified against `scripts/hooks/runStepHook.ts:310-322` and `scripts/hooks/runStepHook.ts:373-440`
- Extra workflow input fields do not enter block contracts — verified against `scripts/shared/templateShape.ts:17-37` and `scripts/tackle-tasks/preambleStatusCheck/PREAMBLE_STATUS_CHECK.ts:12-39`
- Baseline verification semantics — verified against `package.json:3-9` and `scripts/shared/checkTestBaseline.ts:1-15`
