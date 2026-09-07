# Amendment: Task 10 plan — per-task workflow.js and steps.json under projectRoot/.taskTools/workflows/N/

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/10-task.md
- Reviewed against: the live tackle-tasks codebase and task 10 requirements
Sections: 10 | Fixes: 5
Efficacy: 50%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/10-task.md must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Packet-file continuations fall back to the shared config

- Evidence: `[plans/pipeline-audit-20260905-114658/10-task.md:495-507, plans/pipeline-audit-20260905-114658/10-task.md:529-536, scripts/generateWorkflow.ts:96-98, scripts/runStepHook.ts:267-285, scripts/tackle-tasks/preambleStatusCheck/PREAMBLE_STATUS_CHECK.ts:15-30]`
- The plan claims: deriving the config from `startInput`'s `tasksFile` and `taskNumber` makes every real hook invocation load its per-task `steps.json`.
- Actually true: only the first workflow pass contains those fields. After a prompt, the generated workflow invokes `/run-step` with `{packetFile: ...}`; the proposed resolver runs before `walkFromStep` expands that packet file, sees no `tasksFile`, and selects the shared plugin config. The stored packet itself has `projectRoot` and `taskNumber`, because `PREAMBLE_STATUS_CHECK` deliberately removes `tasksFile`.

### 2. The proposed cross-project test uses an invalid custom workflow

- Evidence: `[plans/pipeline-audit-20260905-114658/10-task.md:343-365, scripts/generateWorkflow.ts:11-29, tests/generateSteps.test.ts:293-325]`
- The plan claims: a custom project containing only `one.mmd` with `A --> B` can call `skillBody("[9]", customRoot)` and then demonstrate isolated configs.
- Actually true: `buildWorkflowScript` always asserts that `pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK` exists. The proposed custom config has neither that diagram nor that box, so `skillBody` throws during workflow generation before the isolation assertions. The existing custom-workflow test uses the required diagram and start-box names for this reason.

### 3. Reset cannot migrate a run that predates per-task configs

- Evidence: `[plans/pipeline-audit-20260905-114658/10-task.md:613-641, scripts/runStepHook.ts:442-447, scripts/tackle-tasks/resetTask.ts:19-29]`
- The plan claims: reset can unconditionally read `.taskTools/workflows/<N>/steps.json`.
- Actually true: the hook intercepts `/tackle-tasks reset` before `SkillBodyEmitter` runs, so no per-task pair is generated on that invocation. A failed run created before task 10 has no per-task config and becomes unresettable immediately after this change.

### 4. The generated pair is not immutable for an active run

- Evidence: `[plans/pipeline-audit-20260905-114658/10-task.md:406-425, scripts/tackle-tasks/shared/SkillBodyEmitter.ts:33-40, scripts/generateSteps.ts:311-367, scripts/generateWorkflow.ts:103-107, diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd:29-35]`
- The plan claims: the per-task pair “stays immutable for the run.”
- Actually true: generation remains unconditional and occurs before the workflow reaches the active-task gate. A second invocation for the same active task rewrites both files, and both generators use direct non-atomic writes. Per-task naming prevents different task numbers from colliding, but does not protect a running task from a duplicate launch or a partial concurrent write.

### 5. A fresh per-task config silently loses every mutating flag

- Evidence: `[scripts/generateSteps.ts:182-196, scripts/generateSteps.ts:311-367, plans/pipeline-audit-20260905-114658/10-task.md:369-425]`
- The plan claims: each task can generate `steps.json` directly at its new task-numbered path and receive the same live configuration as the former shared file.
- Actually true: `generateSteps` preserves `mutating: true` only by reading those flags from the previous contents of its output path. A new per-task path has no previous file, so all mutation declarations are dropped. That changes execution safety policy, not just storage location.

## Durable fixes

### Fix for issue 1

- Change: Make config resolution understand both input forms before building `STEPS_BY_KEY`: resolve `tasksFile`/`taskNumber` directly on the initial pass, and on `{packetFile}` passes read the packet, derive `tasksFile` from its `projectRoot` with `resolveTaskFiles`, and use its `taskNumber`. Add a two-pass no-env test whose first custom block prompts, whose answer is written to the packet, and whose second hook invocation uses only `{packetFile}` and successfully runs the next custom block.
- Durable because: it tests the actual boundary between workflow agent calls, where a fresh hook process must rediscover the same per-task config.

### Fix for issue 2

- Change: Rewrite the custom-project isolation fixture to contain `pipeline-preambleStatusCheck.mmd` and `PREAMBLE_STATUS_CHECK` (as the existing integration fixture does), or explicitly extend `generateWorkflow` to accept and bake a custom start step. Keep the two project configs observably different while satisfying the selected start-step contract.
- Durable because: the acceptance test will exercise a workflow that can actually be generated and launched instead of failing during setup.

### Fix for issue 3

- Change: Specify migration behavior for a missing per-task config in `resetTask`: derive the target project's diagram setting and generate the task pair before resolving the block, with a safe default-pipeline fallback for pre-task-10 runs. Add a test that creates an old-style failed run with no `.taskTools/workflows/<N>` directory and proves reset remains usable.
- Durable because: upgrades no longer remove the recovery command needed by already-failed runs.

### Fix for issue 4

- Change: Add a per-task generation lock and publish `steps.json`/`workflow.js` atomically as one validated pair. Before replacement, inspect the task's run state; an active run must reuse its existing pair rather than regenerate it. Add duplicate-active-invocation and concurrent-generation tests that assert unchanged active-run bytes and a parseable, mutually matching pair.
- Durable because: isolation then covers duplicate launches of the same task as well as different tasks and projects, and readers cannot observe half-written artifacts.

### Fix for issue 5

- Change: define a committed canonical source for mutation metadata. Seed each new per-task config from the canonical `scripts/steps.json` before regeneration, or move mutation declarations to a separate committed manifest that `generateSteps` always reads. Add an assertion that the per-task config preserves the exact set of mutating step keys from the canonical source.
- Durable because: creating a new runtime destination can no longer erase policy that the generator currently derives from its prior output.

## Sections that hold up

- Task-numbered directory convention and baked task validation — verified against `scripts/generateWorkflow.ts:26-44` and `scripts/taskFiles.ts:18-37`
- Retirement of the committed shared workflow path — verified against `scripts/generateWorkflow.ts:103-112`
- Reset's current shared-config defect — verified against `scripts/tackle-tasks/resetTask.ts:19-35`
