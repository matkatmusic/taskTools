# Task 121: Drift test pinning the inlined blocker constants to scripts/blockerVerdicts.ts

## User request

the inlined constants in skills/tackle-tasks/blockers.workflow.js  now duplicate scripts/blockerVerdicts.ts. If those two ever drift, the workflow breaks quietly. Create a test to ensure they don't drift.

Three declarations are copied at skills/tackle-tasks/blockers.workflow.js:8-12 from scripts/blockerVerdicts.ts:5-13: BLOCKER_VERDICTS, BLOCKER_VERDICT_SCHEMA_FRAGMENT, and buildBlockerInvestigationPrompt. The marker comment at :7 states why the copy exists (workflow scripts run in a sandbox that forbids imports), so the duplication stays and the test pins it.

Use the mechanism already proven in tests/tackleTasksRetry.test.ts:14-24: locate the marker comment, slice the source region below it, compile that text with new Function returning the declared bindings, then assert against the real imports. Follow that file's convention of a negative-control test (:84-89, :104-107) proving the gate can fail.

Put the tests in tests/blockerVerdicts.test.ts, which already imports these constants, rather than a new file.

Second gap found while reading: WORKFLOW_NAMES at tests/tackleTasksRetry.test.ts:7 lists plan, verify, implement, test, merge — blockers.workflow.js is absent, so its retryAgent copy, its agent() wiring, and its sandbox-parse are all unchecked today. Adding "blockers" to that array and EXPECTED_AGENT_CALLS at :8 (value 1, one wrapped agent() call) extends three existing gates for two lines. Its retryAgent block already matches the others byte-for-byte, so the identical-helper assertion should pass unchanged.

## Files

@tests/blockerVerdicts.test.ts
@tests/tackleTasksRetry.test.ts
@skills/tackle-tasks/blockers.workflow.js
@scripts/blockerVerdicts.ts