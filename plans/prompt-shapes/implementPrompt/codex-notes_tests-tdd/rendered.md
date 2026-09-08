## NOTE FOR THIS RUN

Point one.
Point two.

## YOUR JOB

You are implementing exactly one pre-planned task, task 99, inside the worktree `/tmp/fake-worktree`.
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
/jot:implement /tmp/fake-worktree/plans/plan.json
```

## WHAT TO READ

invoke this skill exactly:
```
/read-file "/tmp/fake-worktree/plans/brief-99.md" "/tmp/fake-worktree/plans/plan.json" "/tmp/fake-worktree/src/thing.ts" "/Users/matkatmusicllc/.claude/guides/coding-standards.md" "/Users/matkatmusicllc/.claude/guides/tdd.md"
```
The skill puts the brief, the plan, the files this task owns, and the guides you must follow into your context.

## OBEY THE REVIEW NOTES

Do not ignore, and instead follow, any non-empty `codexNotes` field in each section of the plan.

## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under `/tmp/fake-worktree`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside `/tmp/fake-worktree`.

## WHAT YOU MAY EDIT

- `src/thing.ts` => `/tmp/fake-worktree/src/thing.ts`
- the implementation log at `/tmp/fake-worktree/plans/implementation-notes-99.md`
- the test file paired with each owned file, at `/tmp/fake-worktree/tests/<owned file's base name>.test.ts`

You are forbidden from editing any other file not listed above.

## TESTS

Each owned file is paired with `tests/<its base name>.test.ts`.
The paired files that already exist are in your context from the read-file skill above.
Import `test` from `node:test`.
Import `assert` from `node:assert`.
Never import from `bun:test`.
Per `~/.claude/guides/tdd.md`, write the failing test before the code that satisfies it.

## HOW TO IMPLEMENT

1. Implement every section of the plan, in the order the `sections` array gives them, editing only the paths listed above.
2. Run each paired test file with `(cd -- '/tmp/fake-worktree' && node --test <absolute test path>)`.
3. While any test fails, fix the cause, then repeat step 2.
Stop after 3 rounds.

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
- attempt more than 3 fix rounds;
- return `implemented: true` while a test fails or the typecheck reports an error.
A test listed in `.taskTools/knownFailingTests.json` (the `npm run test:baseline` baseline) does not count as failing.

Returning `implemented: false` is a correct outcome when the plan is impossible as written.

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build `{ "message": "", "additionalData": { "implemented": <true only when every plan step is done and every test passed, false otherwise>, "notes": "<what you implemented; when implemented is false, name what is left and why it stopped>" } }`, where \`message\` is a one-line summary of what you did.
2. Write that object into the packet file named by `outcome.payload` in the hook output (the same file this prompt came from) by running, with the object on stdin:
```
node /Users/matkatmusicllc/Programming/taskTools-86/scripts/tackle-tasks/shared/writeAgentAnswer.ts "<the outcome.payload path>" <<'TTANSWER'
<the object from step 1>
TTANSWER
```
Never edit the packet file by hand; the script keeps the keys already there and fails loudly when the object is not valid JSON.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway.