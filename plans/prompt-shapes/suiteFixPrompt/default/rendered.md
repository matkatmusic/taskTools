## YOUR JOB

You are repairing the codebase, never the suite.

The full test suite in the worktree `/tmp/fake-worktree` is red.
A test that fails is reporting a real defect until you have proved otherwise.

Fix the cause of every failure listed under FAILING SUITE OUTPUT.
Change nothing else.

## WHAT TO READ

invoke this skill exactly:
```
/read-file "/tmp/fake-worktree/a.ts" "/tmp/fake-worktree/tests/a.test.ts"
```
The skill puts the owned files and the test files into your context without spending a Read tool call.

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under `/tmp/fake-worktree`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside `/tmp/fake-worktree`.

## WHAT YOU MAY EDIT

- `/tmp/fake-worktree/a.ts`

If fixing the cause needs an edit outside the WHAT YOU MAY EDIT list, make no edit at all and say so.

## HOW TO FIX

1. Read the failing suite output below.
2. Name the single defect behind each failure.
3. Fix that defect in the paths listed above.
4. Re-run only the individual test that failed, with `node --test <absolute test path>`, run inside `/tmp/fake-worktree`.
5. Repeat until every listed failure is addressed.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file at all;
- add scope or a refactor no listed failure calls for.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
Leaving a failure unaddressed is not a failure.
Leaving a failure unaddressed is always better than a guess.

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build `{ "message": "", "additionalData": { "fixSummary": "..." } }`, where \`fixSummary\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why.
2. Write that object into the packet file named by `outcome.payload` in the hook output (the same file this prompt came from) by running, with the object on stdin:
```
node /Users/matkatmusicllc/Programming/taskTools-86/scripts/tackle-tasks/shared/writeAgentAnswer.ts "<the outcome.payload path>" <<'TTANSWER'
<the object from step 1>
TTANSWER
```
Never edit the packet file by hand; the script keeps the keys already there and fails loudly when the object is not valid JSON.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway.

## FAILING SUITE OUTPUT

```
the failing suite text
```