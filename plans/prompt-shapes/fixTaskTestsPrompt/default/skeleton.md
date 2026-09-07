## YOUR JOB

Fix the cause of every failure listed under FAILING TASK TESTS.
Read `~/.claude/guides/tests-and-code-changes.md` first: it decides, per failing test, whether the code or the test is wrong.

The task's own tests in the worktree ``${root}`` are red.
A test that fails is reporting a real defect until you have proved otherwise.
A test that checks behavior this task was asked to change is obsolete: comment it out and say which test and why.

## WHAT TO READ

Run this, which puts the files into your context without spending a Read tool call, so you can read them all at once:
```
/read-file `${readFileArgs([GUIDE("tests-and-code-changes.md"), ...prepared.ownedFilePaths, ...prepared.testFilePaths])}`
```

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

`${absolutePathsSection(root)}`

## WHAT YOU MAY EDIT

`${prepared.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}`

This list is complete, plus any test file whose failure the guide rules obsolete.
Every other path in the tree belongs to another task.

If fixing the cause needs an edit outside this list, make no edit at all and say so.

`${resumedRunSection(root)}`

## HOW TO FIX

1. Read the failing test notes below and name the single defect behind each failure.
2. Fix that defect in the paths listed above.
3. Re-run only the individual test that failed, with `node --test <absolute test path>`, run inside ``${root}``.
4. Repeat until every listed failure is addressed.
5. Never run the full suite.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file, except to comment out one the guide rules obsolete;
- edit any path not listed under WHAT YOU MAY EDIT;
- add scope or a refactor no listed failure calls for;
- run the full suite;
- stage or commit anything by hand;
- force-push or hard-reset anything you did not create.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
It is not a failure, and it is always better than a guess.

`${whatToReturnSection(...)}`

## FAILING TASK TESTS

```
`${prepared.codexReviewNotes}`
```