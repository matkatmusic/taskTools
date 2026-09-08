# Amendment: Retry `agent()` on API disconnect in the tackle-tasks workflows

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools/plans/ultra-fuzzy-star.md
- Reviewed against: the state of the codebase and latest changes on the new-usage-graph branch
Sections: 11 | Fixes: 1
Efficacy: 91%
Ruling: /Users/matkatmusicllc/Programming/taskTools/plans/ultra-fuzzy-star.md can be used after incorporating the fix below.Keep your edits small.  Do not state that the edits are theresult of feedback from an amendment.

## Issues

### 1. The tests do not protect the full nullish-only retry contract

- Evidence: `[skills/tackle-tasks/plan.workflow.js:65-71, skills/tackle-tasks/verify.workflow.js:95-101, skills/tackle-tasks/implement.workflow.js:104-110, skills/tackle-tasks/test.workflow.js:123-131, skills/tackle-tasks/merge.workflow.js:85-94]`
- The plan claims: `retryAgent` retries only `null`/`undefined`, preserves a falsy-but-valid `0`, and the focused tests verify its behavior, but both proposed behavior tests exercise only `null`.
- Actually true: the existing workflow fallbacks consistently treat both `null` and `undefined` as missing results. An implementation using `if (result)` would pass both proposed behavior tests while incorrectly retrying `0`, and an implementation checking only `result !== null` would also pass while incorrectly returning `undefined`; the identical-copy, wiring, and parse tests do not exercise either semantic edge.

## Durable fixes

### Fix for issue 1

- Change: Add behavior cases that make spawn return `undefined` before a valid object and return `0` immediately; assert the first case retries and succeeds on call two, and the second returns `0` after exactly one call. Include these cases in the Verification description.
- Durable because: The suite will fail if all five identical helpers drift from nullish-only retry semantics together or if a truthiness check is substituted for the explicit `null`/`undefined` check.

## Sections that hold up

- Context — verified against `skills/tackle-tasks/plan.workflow.js:62-71`, `skills/tackle-tasks/verify.workflow.js:88-101`, and `skills/tackle-tasks/implement.workflow.js:92-110`
- The change — verified against all six current calls at `skills/tackle-tasks/plan.workflow.js:59-65`, `skills/tackle-tasks/verify.workflow.js:86-101`, `skills/tackle-tasks/implement.workflow.js:92-110`, `skills/tackle-tasks/test.workflow.js:122-143`, and `skills/tackle-tasks/merge.workflow.js:84-94`
- Constraint — verified against `plans/handoff-new-usage-graph-20260805-0015.md:75-84`
- The helper — its async return shape and explicit nullish contract fit the existing consumers at `skills/tackle-tasks/plan.workflow.js:65-71`, `skills/tackle-tasks/test.workflow.js:123-131`, and `skills/tackle-tasks/merge.workflow.js:85-94`
- What `null` actually tells us — the code exposes only missing-result fallbacks, with no error classification, at `skills/tackle-tasks/verify.workflow.js:88-101` and `skills/tackle-tasks/implement.workflow.js:104-110`
- Call sites — verified all six against `skills/tackle-tasks/plan.workflow.js:62`, `skills/tackle-tasks/verify.workflow.js:88-93`, `skills/tackle-tasks/implement.workflow.js:95`, `skills/tackle-tasks/test.workflow.js:123-143`, and `skills/tackle-tasks/merge.workflow.js:85`
- Existing fallbacks stay — verified against `skills/tackle-tasks/plan.workflow.js:65-71`, `skills/tackle-tasks/verify.workflow.js:95-101`, `skills/tackle-tasks/implement.workflow.js:104-119`, `skills/tackle-tasks/test.workflow.js:123-150`, and `skills/tackle-tasks/merge.workflow.js:85-94`
- Tests, apart from issue 1 — source-reading wiring gates match the repository's test style at `tests/runAuthorization.test.ts:2-6` and `tests/runAuthorization.test.ts:33-43`; TypeScript includes the proposed test path via `tsconfig.json:2-14`
- Syntax gate — the proposed wrapper accommodates the exported `meta` and sandbox-level returns visible at `skills/tackle-tasks/plan.workflow.js:1-5` and `skills/tackle-tasks/plan.workflow.js:65-78`
- Verification — the named test runner and typecheck configuration match `package.json:1-6` and `tsconfig.json:1-14`
- Not doing — the acknowledged mutating retries are supported by the worker and fixer commit instructions at `skills/tackle-tasks/implement.workflow.js:72-75` and `skills/tackle-tasks/test.workflow.js:100-106`, plus merge-diagnoser edits and commits at `skills/tackle-tasks/merge.workflow.js:46-60`
