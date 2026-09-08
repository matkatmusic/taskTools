## YOUR JOB

You are implementing exactly one pre-planned task, task 190, inside the worktree `/Users/matkatmusicllc/Programming/taskTools`.
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
/read-file "/Users/matkatmusicllc/Programming/taskTools/plans/brief-190.md" "/Users/matkatmusicllc/Programming/taskTools/plans/plan.json" "/Users/matkatmusicllc/.claude/guides/coding-standards.md" "/Users/matkatmusicllc/.claude/guides/tdd.md"
```
The skill puts the brief, the plan, the files this task owns, and the guides you must follow into your context.

## OBEY THE REVIEW NOTES

Do not ignore, and instead follow, any non-empty `codexNotes` field in each section of the plan.

## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under `/Users/matkatmusicllc/Programming/taskTools`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside `/Users/matkatmusicllc/Programming/taskTools`.

## WHAT YOU MAY EDIT

- `skills/mermaid/SKILL.md` => `/Users/matkatmusicllc/Programming/taskTools/skills/mermaid/SKILL.md`
- the implementation log at `/Users/matkatmusicllc/Programming/taskTools/plans/implementation-notes-190.md`

## DO NOT CREATE TESTS

This task does not require any tests to be created.

## HOW TO IMPLEMENT

1. Implement every section of the plan, in the order the `sections` array gives them, editing only the paths listed above.
2. Run the verification command each plan section names.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- add scope or a refactor the plan does not call for;
- redecide anything the plan already decided;
- return `implemented: true` while a plan section's verification command fails.

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