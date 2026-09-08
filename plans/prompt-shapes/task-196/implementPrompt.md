## NOTE FOR THIS RUN

[implement-blocks] Route the false branch in DOES_FRESH_WORKTREE_SUITE_PASS_Q, the diagram edge, the decision template, and diagram-steps.json to pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT; remove the decision's direct lease release and use the report-only exit's established cleanup path.

Durable because: This preserves the required worktree and uses the same inactive-and-lease-release lifecycle as the other report-only outcomes.

[red-tests] Replace the two commented RUN_SUITE_ON_FRESH_WORKTREE test skeletons with complete literal test code, including imports, fixture repository/worktree creation, task claim, committed green/red baseline files, exact main invocation, and assertions.

Durable because: The tests will directly exercise the new block's real baseline-aware suite behavior instead of requiring the implementer to invent coverage.

[implement-blocks] Replace the template prose with three complete `old: (file absent)` / `new:` JSON diffs that enumerate every input and output field and the exact green and red routing values for each new block.

Durable because: Each template becomes reproducible and remains synchronized with the packet contracts and generated step configuration.

## YOUR JOB

You are implementing exactly one pre-planned task, task 196, inside the worktree `/Users/matkatmusicllc/Programming/taskTools`.
The plan is already written and already reviewed.
Decide nothing the plan already decided.

## BEFORE YOU IMPLEMENT

invoke this skill exactly:
```
/ponytail ultra
```

then

invoke this skill exactly:
```
/jot:implement /Users/matkatmusicllc/Programming/taskTools/plans/plan.json
```

## WHAT TO READ

invoke this skill exactly:
```
/read-file "/Users/matkatmusicllc/Programming/taskTools/plans/brief-196.md" "/Users/matkatmusicllc/Programming/taskTools/plans/plan.json" "/Users/matkatmusicllc/Programming/taskTools/diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd" "/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/diagram-steps.json" "/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/runFullSuite.ts" "/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/writeTaskExitNotes.ts" "/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/taskRunState.ts" "/Users/matkatmusicllc/Programming/taskTools/tests/tackleTasksAcceptance.test.ts" "/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/generateSteps.ts" "/Users/matkatmusicllc/Programming/taskTools/tests/generateSteps.test.ts" "/Users/matkatmusicllc/.claude/guides/coding-standards.md" "/Users/matkatmusicllc/.claude/guides/tdd.md"
```
The skill puts the brief, the plan, the files this task owns, and the guides you must follow into your context.

## OBEY THE REVIEW NOTES

Do not ignore, and instead follow, any non-empty `codexNotes` field in each section of the plan.

## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under `/Users/matkatmusicllc/Programming/taskTools`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside `/Users/matkatmusicllc/Programming/taskTools`.

## WHAT YOU MAY EDIT

- `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` => `/Users/matkatmusicllc/Programming/taskTools/diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd`
- `scripts/tackle-tasks/preambleStatusCheck/RUN_SUITE_ON_FRESH_WORKTREE.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/RUN_SUITE_ON_FRESH_WORKTREE.ts`
- `scripts/tackle-tasks/preambleStatusCheck/RUN_SUITE_ON_FRESH_WORKTREE.template.json` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/RUN_SUITE_ON_FRESH_WORKTREE.template.json`
- `scripts/tackle-tasks/preambleStatusCheck/RUN_SUITE_ON_FRESH_WORKTREE.test.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/RUN_SUITE_ON_FRESH_WORKTREE.test.ts`
- `scripts/tackle-tasks/preambleStatusCheck/DOES_FRESH_WORKTREE_SUITE_PASS_Q.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/DOES_FRESH_WORKTREE_SUITE_PASS_Q.ts`
- `scripts/tackle-tasks/preambleStatusCheck/DOES_FRESH_WORKTREE_SUITE_PASS_Q.template.json` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/DOES_FRESH_WORKTREE_SUITE_PASS_Q.template.json`
- `scripts/tackle-tasks/preambleStatusCheck/DOES_FRESH_WORKTREE_SUITE_PASS_Q.test.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/DOES_FRESH_WORKTREE_SUITE_PASS_Q.test.ts`
- `scripts/tackle-tasks/diagram-steps.json` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/diagram-steps.json`
- `scripts/tackle-tasks/shared/runFullSuite.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/runFullSuite.ts`
- `scripts/tackle-tasks/shared/writeTaskExitNotes.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/writeTaskExitNotes.ts`
- `scripts/tackle-tasks/shared/taskRunState.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/taskRunState.ts`
- `tests/tackleTasksAcceptance.test.ts` => `/Users/matkatmusicllc/Programming/taskTools/tests/tackleTasksAcceptance.test.ts`
- `scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_FRESH_Q.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_FRESH_Q.ts`
- `scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_FRESH_Q.template.json` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_FRESH_Q.template.json`
- `scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_FRESH_Q.test.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/preambleStatusCheck/IS_WORKTREE_FRESH_Q.test.ts`
- `scripts/tackle-tasks/generateSteps.ts` => `/Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/generateSteps.ts`
- the implementation log at `/Users/matkatmusicllc/Programming/taskTools/plans/implementation-notes-196.md`
- the test file paired with each owned file, at `/Users/matkatmusicllc/Programming/taskTools/tests/<owned file's base name>.test.ts`

## TESTS

Each owned file is paired with `tests/<its base name>.test.ts`.
The paired files that already exist are in your context from the read-file skill above.
Import `test` from `node:test`.
Import `assert` from `node:assert`.
Never import from `bun:test`.
Per `~/.claude/guides/tdd.md`, write the failing test before the code that satisfies it.

## HOW TO IMPLEMENT

1. Implement every section of the plan, in the order the `sections` array gives them, editing only the paths listed above.
2. Run each paired test file with `(cd -- '/Users/matkatmusicllc/Programming/taskTools' && node --test <absolute test path>)`.
3. While any test fails, fix the cause, then repeat step 2.
Stop after 3 rounds.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- add scope or a refactor the plan does not call for;
- redecide anything the plan already decided;
- attempt more than 3 fix rounds;
- return `implemented: true` while a test fails or the typecheck reports an error.
A test listed in `.taskTools/knownFailingTests.json` (the `npm run test:baseline` baseline) does not count as failing.

Returning `implemented: false` is a correct outcome when the plan is impossible as written.

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build `{ "message": "", "additionalData": { "implemented": <true only when every plan step is done and every test passed, false otherwise>, "notes": "<what you implemented; when implemented is false, name what is left and why it stopped>" } }`, where \`message\` is a one-line summary of what you did.
2. Write that object into the packet file named by `outcome.payload` in the hook output (the same file this prompt came from) by running, with the object on stdin:
```
node /Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/writeAgentAnswer.ts "<the outcome.payload path>" <<'TTANSWER'
<the object from step 1>
TTANSWER
```
Never edit the packet file by hand; the script keeps the keys already there and fails loudly when the object is not valid JSON.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway.