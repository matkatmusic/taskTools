# Amendment: Task 18 plan — sandbox-execute the workflow's four error branches; make the two non-conflict answer consumers act on their meaningful field

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/18-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/18.json and the live codebase
Sections: 6 | Fixes: 3
Efficacy: 50%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/18-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. `implemented: false` is a workflow outcome, not an operational exception

- Evidence: `[scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.ts:111-128, scripts/runStepHook.ts:333-343, plans/pipeline-audit-20260905-114658/18-task.md:80-118]`
- The plan claims: throwing from `COMMIT_IMPLEMENTATION_IF_NEEDED` is the correct way to act on `implemented: false`.
- Actually true: the planner prompt explicitly defines false as a valid outcome when the plan cannot be completed. A throw is converted into a generic hard block failure by `runStepHook`; it does not route through `FAILURES_EXIT`, persist an intentional exit type/note, or close the active run. That recreates the pipeline-stranding behavior this audit is meant to eliminate.

### 2. Presence of a boolean is not a reliable predecessor discriminator

- Evidence: `[scripts/tackle-tasks/commitImplementationIfNeeded/COMMIT_IMPLEMENTATION_IF_NEEDED.template.json:1-25, scripts/templateShape.ts:17-38, scripts/runStepHook.ts:228-240, plans/pipeline-audit-20260905-114658/18-task.md:105-118]`
- The plan claims: if `additionalData.implemented` is not a boolean, the input can safely be treated as the test-fix path.
- Actually true: the template requires only that `additionalData` be an object; it does not require `implemented`. A malformed or incomplete `IMPLEMENT_TASK` answer therefore follows the same branch as a valid `FIX_IMPLEMENT_TASK_TESTS` answer and commits/proceeds silently. The two predecessor protocols remain ambiguous.

### 3. Copying `fixSummary` into an otherwise unused packet does not make it affect anything

- Evidence: `[scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts:25-37, scripts/tackle-tasks/shared/runFullSuite.ts:78-85, plans/pipeline-audit-20260905-114658/18-task.md:120-197]`
- The plan claims: carrying `fixSummary` on the output packet fixes the semantic-discard defect.
- Actually true: no downstream box consumes that field and it is not persisted in task run state. `RUN_FULL_SUITE` independently computes and stores its test result, so the summary remains transient metadata that eventually disappears. The proposed change validates the shape but does not create an observable semantic or diagnostic effect.

## Durable fixes

### Fix for issue 1

- Change: Represent implementer completion as diagram routing. Add a decision step that consumes the required implementer outcome before any commit: true proceeds to the implementation commit; false emits a specific exit type/note and enters `FAILURES_EXIT`. Add an end-to-end walk test proving false reaches the failure tail and never invokes `commitTaskWork`.
- Durable because: a supported negative answer follows an explicit, resumable workflow edge rather than masquerading as a process crash.

### Fix for issue 2

- Change: Stop multiplexing two answer protocols through one consumer. Give `IMPLEMENT_TASK` and `FIX_IMPLEMENT_TASK_TESTS` distinct consuming boxes/templates (or add trusted prompt-source metadata in the packet), then require the exact fields for that source. Replace the `{ok:true}`/empty-object test fixtures with faithful fixtures and add malformed-answer negatives for both paths.
- Durable because: validation is selected from workflow provenance, not from the untrusted answer field whose absence is the defect being detected.

### Fix for issue 3

- Change: Either remove the unsupported claim that `fixSummary` must have semantic effect and keep only explicit validation, or persist it in a named run receipt/agent-outcome record keyed by run and attempt. Add a test that reloads `tasks.json` and observes the persisted summary after the consumer returns.
- Durable because: the answer is either honestly treated as non-authoritative prose or retained in durable state for later diagnostics; it is not merely shuffled between ephemeral packets.

## Sections that hold up

- Four workflow error returns and normal `outcome.next === null` success — verified against `scripts/generateWorkflow.ts:61-99`
- Behavioral execution belongs with generated-workflow tests, not the frozen v1.1 retry tests — verified against `tests/generateWorkflow.test.ts:1-150` and `tests/tackleTasksRetry.test.ts:1-110`
- `COMMIT_SUITE_FIX_IF_NEEDED` currently discards its agent-answer fields — verified against `scripts/tackle-tasks/runFullSuite/COMMIT_SUITE_FIX_IF_NEEDED.ts:9-43`
