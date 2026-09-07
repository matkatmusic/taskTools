## NOTE FOR THIS RUN

`${t.codexReviewNotes.trim()}`

## YOUR JOB

You are implementing exactly one pre-planned task, task `${t.number}`, inside the worktree ``${t.repoRoot}``.
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
/jot:implement `${t.planFile}`
```

## WHAT TO READ

invoke this skill exactly:
```
/read-file `${readFileArgs([t.briefFile, t.planFile, ...t.ownedFilePaths, ...t.testFilePaths, GUIDE("coding-standards.md"), GUIDE("tdd.md")])}`
```
The skill puts the brief, the plan, the files this task owns, and the guides you must follow into your context.

## OBEY THE REVIEW NOTES

Do not ignore, and instead follow, any non-empty `codexNotes` field in each section of the plan.

`${absolutePathsSection(t.repoRoot)}`

## WHAT YOU MAY EDIT

`${ownedPathMap(t)}`
- the implementation log at ``${t.notesFile}``
- the test file paired with each owned file, at ``${t.repoRoot}`/tests/<owned file's base name>.test.ts`

You are forbidden from editing any other file not listed above.

`${resumedRunSection(t.repoRoot)}`

## TESTS

Each owned file is paired with `tests/<its base name>.test.ts`.
The paired files that already exist are in your context from the read-file skill above.
Import `test` from `node:test`.
Import `assert` from `node:assert`.
Never import from `bun:test`.
Per `~/.claude/guides/tdd.md`, write the failing test before the code that satisfies it.

## HOW TO IMPLEMENT

1. Implement every section of the plan, in the order the `sections` array gives them, editing only the paths listed above.
2. Run ``${rootedTypecheck}``.
Fix every error it reports in the paths you own.
3. Run each paired test file with `(cd -- '`${t.repoRoot}`' && node --test <absolute test path>)`.
4. While any test fails, fix the cause, then repeat steps 2 and 3.
Stop after `${maxFixRounds}` rounds.

Never run the full suite.
That gate belongs to a separate phase, not to you.

## NEVER COMMIT

Never stage, commit, or run any git command.
A later step commits your work for you.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit anything outside the paths listed under WHAT YOU MAY EDIT;
- add scope or a refactor the plan does not call for;
- redecide anything the plan already decided;
- run the full suite;
- stage or commit anything, or run any git command;
- attempt more than `${maxFixRounds}` fix rounds;
- return `implemented: true` while a test fails or the typecheck reports an error.
A test listed in `.taskTools/knownFailingTests.json` (the `npm run test:baseline` baseline) does not count as failing.

Returning `implemented: false` is a correct outcome when the plan is impossible as written.

`${whatToReturnSection(...)}`