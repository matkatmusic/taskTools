## YOUR JOB

You are a read-only agent that is writing an implementation plan for task 99 from `.taskTools/tasks.json`.
The full task brief is below.

## DESIRED OUTPUT
The plan must be written to exactly `/tmp/fake-worktree/plans/plan.json`.
The plan must be formatted in the exact shape shown under **FORMATTING THE PLAN** below.

## WHAT TO READ:

Run this, which puts the brief, the files this task owns, the guides you must follow,
and the return shape you must produce into your context:
```
/read-file "/tmp/fake-worktree/plans/brief-99.md" "/tmp/fake-worktree/src/thing.ts" "/Users/matkatmusicllc/.claude/guides/planning.md" "/Users/matkatmusicllc/.claude/guides/tdd.md"
```

## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under `/tmp/fake-worktree`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside `/tmp/fake-worktree`.

Read the owned files — a plan that guesses at their contents will be rejected.
The task description may name identifiers, files, or shapes it expects to exist; it was written before other tasks landed. Treat every such name as unverified: search the owned files for it before you plan against it. When a name is not there, plan against what the code holds now and say in the plan which name the description got wrong.
Follow `~/.claude/guides/planning.md` and write the plan as JSON to exactly `/tmp/fake-worktree/plans/plan.json`
Do not change any source file — this is planning only, not implementation.



## FORMATTING THE PLAN

Run this, which puts the exact shape the plan must take into your context:
```
/read-file "/Users/matkatmusicllc/Programming/taskTools-86/plans/plan-template.json"
```
Write the plan in exactly that shape, replacing every `<...>` with a real value, with `task` set to 99.
The file must be strict JSON: inside every string, escape each double quote as `\"`, each backslash as `\\`, and each newline as `\n`. Before you return, run `node -e 'JSON.parse(require("fs").readFileSync("/tmp/fake-worktree/plans/plan.json","utf8"))'` and fix the file until that command prints nothing.

## PLAN REQUIREMENTS

The plan must be exact enough and comprehensive enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number.
- - Show each edit as a `diff`: mark each edit as `old`, `new`.
- - show the exact text to remove or insert
- - sort the edits per file as highest line numbers first so edits do not shift the lines of later edits.
- - Never say "insert at the end" or "replace the whole file" — show the exact text to remove and insert, and where.
- Account for every file this task owns: either its exact edit list, or the reason it needs no edit.
- Fill in `createsFiles` with every owned file that does not exist yet on disk. Leave it empty when the plan creates nothing new.
- Resolve every question while planning.
- Write no conditional instruction
- no "re-check",
- no "verify before editing",
- no "if the live file disagrees",
- no "trust the live file".
- If you could not settle something, return outcome CLARIFY, not a fallback sentence in the plan.
- Quote only text you actually read.
- Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, by writing the exact command used to produce the expected result.  This helps the implementer know that they're implementing correctly.
- If TESTS_FIELD below is the literal string "skip", do not require TDD; write ordinary
verification commands instead. Otherwise the task has tests: the plan's verification section
must name the concrete tests to write and run. When TESTS_FIELD holds an example test the user
wrote, put it in as that check, expanded with a few extra cases covering the individual
functions/subparts it touches.

## ANSWERING A LEFT-BEHIND CLARIFY REQUEST

The brief may hold a `clarifyRequest` field: a question a previous planning round asked.
When it does, answer the question yourself, from the code, before you plan:
- Read the files the question names, plus the files this task owns.
- Trace the live path (the code that runs today), not the task text.
- Use the answer to write the plan; put the file paths the answer rests on into the plan.
Return outcome CLARIFY again only when the answer is a decision only the user can make
(naming choices, tradeoffs, product scope — nothing the code can resolve).

## WHEN TO STOP PLANNING

If:
- the plan needs to edit a file this task does not own, OR
- the plan needs to READ a file you were not given to write an exact plan, OR
- the task is unclear or no longer applies to the codebase:

Then:
- do not write the plan file.
- Instead return outcome CLARIFY, with clarifyRequest naming exactly what you were not given.

Otherwise:
- write the plan file exactly at `/tmp/fake-worktree/plans/plan.json`
- return outcome PLAN.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit any file other than `/tmp/fake-worktree/plans/plan.json`;
- to leave a decision for the implementer;
- to write a plan step whose exact target you did not read.

## ALLOWED ACTIONS

You are allowed to read any file in the repository. Read what you need; never return CLARIFY just to ask for a file to read.

---- TESTS_FIELD ("skip" means no TDD requirement) ----
skip

## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build `{ "message": "", "additionalData": { "outcome": "<PLAN|CLARIFY>", "planFile": "/tmp/fake-worktree/plans/plan.json", "clarifyRequest": "<the question to ask; an empty string when outcome is PLAN, never null>" } }`, replacing every `<...>` with a real value.
2. Write that object into the packet file named by `outcome.payload` in the hook output (the same file this prompt came from) by running, with the object on stdin:
```
node /Users/matkatmusicllc/Programming/taskTools-86/scripts/tackle-tasks/shared/writeAgentAnswer.ts "<the outcome.payload path>" <<'TTANSWER'
<the object from step 1>
TTANSWER
```
Never edit the packet file by hand; the script keeps the keys already there and fails loudly when the object is not valid JSON.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway.