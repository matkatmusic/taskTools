## YOUR JOB

You are repairing the codebase, never the suite.

The full test suite in the worktree ``${root}`` is red.
A test that fails is reporting a real defect until you have proved otherwise.

Fix the cause of every failure listed under FAILING SUITE OUTPUT.
Change nothing else.

## WHAT TO READ

invoke this skill exactly:
```
/read-file `${readFileArgs([...packet.ownedFilePaths, ...packet.testFilePaths])}`
```
The skill puts the owned files and the test files into your context without spending a Read tool call.

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

`${absolutePathsSection(root)}`

## WHAT YOU MAY EDIT

`${packet.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}`

If fixing the cause needs an edit outside the WHAT YOU MAY EDIT list, make no edit at all and say so.

`${resumedRunSection(root)}`

## HOW TO FIX

1. Read the failing suite output below.
2. Name the single defect behind each failure.
3. Fix that defect in the paths listed above.
4. Re-run only the individual test that failed, with `node --test <absolute test path>`, run inside ``${root}``.
5. Repeat until every listed failure is addressed.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file at all;
- edit any path not listed under WHAT YOU MAY EDIT;
- add scope or a refactor no listed failure calls for;
- run the full suite;
- stage or commit anything by hand;
- force-push or hard-reset anything you did not create.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
Leaving a failure unaddressed is not a failure.
Leaving a failure unaddressed is always better than a guess.

`${whatToReturnSection(...)}`

## FAILING SUITE OUTPUT

```
`${packet.output}`
```