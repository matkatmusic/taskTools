## YOUR JOB

You are an agent fixing the task's own failing tests.
Your job is to fix the cause of every failure listed under FAILING TASK TESTS.
Your goal is to fix the real defect behind each failure.
Read `~/.claude/guides/tests-and-code-changes.md` first.
That guide decides, per failing test, whether the code or the test is wrong.
The task's own tests in the worktree `/Users/matkatmusicllc/Programming/taskTools` are red.
A test that fails is reporting a real defect until you have proved otherwise.
A test that checks behavior this task was asked to change is obsolete.
Comment it out.
Say which test and why.

## WHAT TO READ

invoke this skill exactly:
```
/read-file "/Users/matkatmusicllc/.claude/guides/tests-and-code-changes.md" "/Users/matkatmusicllc/Programming/taskTools/scripts/hooks/stage-and-summarize-stop.ts" "/Users/matkatmusicllc/Programming/taskTools/scripts/shared/stagedDiffs.ts" "/Users/matkatmusicllc/Programming/taskTools/tests/stage-and-summarize-stop.test.ts"
```
This puts the files into your context without spending a Read tool call.

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under `/Users/matkatmusicllc/Programming/taskTools`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside `/Users/matkatmusicllc/Programming/taskTools`.

## WHAT YOU MAY EDIT

- `/Users/matkatmusicllc/Programming/taskTools/scripts/hooks/stage-and-summarize-stop.ts`
- `/Users/matkatmusicllc/Programming/taskTools/scripts/shared/stagedDiffs.ts`
- `/Users/matkatmusicllc/Programming/taskTools/tests/stage-and-summarize-stop.test.ts`

You may also edit any test file whose failure the guide rules obsolete.
Every other path in the tree belongs to another task.

If fixing the cause needs an edit outside the file paths listed above, make no edit at all.
Say so.

## HOW TO FIX

1. Read the failing test notes below.
Name the single defect behind each failure.
2. Fix that defect in the paths listed above.
3. Re-run only the individual test that failed, with `node --test <absolute test path>`, run inside `/Users/matkatmusicllc/Programming/taskTools`.
4. Repeat until every listed failure is addressed.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file, except to comment out one the guide rules obsolete;
- add scope or a refactor no listed failure calls for.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
It is not a failure.
It is always better than a guess.

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build `{ "message": "", "additionalData": { "fixSummary": "..." } }`, where \`fixSummary\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why.
2. Write that object into the packet file named by `outcome.payload` in the hook output (the same file this prompt came from) by running, with the object on stdin:
```
node /Users/matkatmusicllc/Programming/taskTools/scripts/tackle-tasks/shared/writeAgentAnswer.ts "<the outcome.payload path>" <<'TTANSWER'
<the object from step 1>
TTANSWER
```
Never edit the packet file by hand; the script keeps the keys already there and fails loudly when the object is not valid JSON.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway.

## FAILING TASK TESTS

```

```