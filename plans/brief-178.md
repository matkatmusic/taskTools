# Task 178: Run the configured typecheck in rebase-test so the brief's promise holds (audit C86-13)

## User request

Rebase-test does not rerun the claimed typecheck. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-12.

This is finding C86-13 (MEDIUM) in plans/task-86-codex-audit.md.

The generated brief promises that every rebase-test runs "typecheck + each layer's complete test suite" (scripts/tackleTasksBrief.ts:155). It does not.

rebaseAndTestSubmoduleLayer (scripts/mergeTaskWorktrees.ts:295-304, around lines 256-304) and rebaseParentOntoSourceAndTest (:370-379, around lines 354-380) execute only testPolicyResult.policy.completeSuiteCommand from discoverTestPolicy() in scripts/testPolicy.ts. In this repository that resolves to `npm run test`, and package.json's test script contains no typecheck.

TYPECHECK_COMMAND (default `npx tsc --noEmit`) is referenced only in skills/tackle-tasks/task.workflow.js (lines 4, 215, 230), where the implementation worker uses it. It is omitted from tail launches entirely, so the rebase-test stage never receives it.

FIX DIRECTION, settled with the user: make the promise true rather than deleting it. Thread the configured typecheck command into the tail launches and run it in BOTH rebase-test functions, alongside completeSuiteCommand, at every layer. A rebase that introduces type breakage must then fail the stage before any merge, instead of merging clean.

## Files

@scripts/mergeTaskWorktrees.ts
@scripts/testPolicy.ts
@scripts/tackleTasksBrief.ts
@skills/tackle-tasks/task.workflow.js
@tests/mergeTaskWorktrees.test.ts