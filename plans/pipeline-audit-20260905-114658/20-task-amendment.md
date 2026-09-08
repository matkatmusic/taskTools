# Amendment: Task 20 plan — block /tackle-tasks when the live permission_mode is plan

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/20-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/20.json, the live codebase, and the official Claude Code hooks reference
Sections: 6 | Fixes: 1
Efficacy: 83%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/20-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. A separate blocker does not stop the reset hook's parallel mutation

- Evidence: `[hooks/hooks.json:3-28, scripts/runStepHook.ts:433-451, plans/pipeline-audit-20260905-114658/20-task.md:89-122]`
- The plan claims: appending a separate `UserPromptSubmit` hook blocks every `/tackle-tasks` operation before it can mutate in plan mode.
- Actually true: `runStepHook.ts` independently recognizes `/tackle-tasks reset N` and calls `resetTask` before producing output. Claude Code runs all matching hooks for one event in parallel, so the new hook's eventual block cannot prevent that sibling hook from resetting state. The official hooks guide confirms both the parallel execution and that side effects from sibling hooks still occur: https://code.claude.com/docs/en/hooks-guide#how-hooks-work.

## Durable fixes

### Fix for issue 1

- Change: Put the live `permission_mode === "plan"` guard on every hook path that can perform tackle-tasks mutations, especially before `runStepHook.ts` calls `resetTask`. Share a small pure predicate/response builder with the new entry gate so matching stays consistent. Add a real hook-process test that seeds task/checkpoint state, submits `/tackle-tasks reset N` with plan mode, and asserts both a block response and byte-for-byte unchanged state; retain the default-mode reset test as the positive control.
- Durable because: each parallel hook enforces the permission invariant before its own side effects instead of assuming another hook can serialize or cancel it.

## Sections that hold up

- Live mode must come from each hook payload rather than settings files — verified against `scripts/runStepHook.ts:433-451` and the official common-input-field reference at https://code.claude.com/docs/en/hooks#common-input-fields
- The retired `tackleTasksHook.ts` must not be re-registered with its old skill-body behavior — verified against `scripts/tackleTasksHook.ts:1-76` and `skills/tackle-tasks/SKILL.md:1-12`
- Bare and plugin-namespaced prompt normalization — verified against `scripts/runStepHook.ts:435-443`

