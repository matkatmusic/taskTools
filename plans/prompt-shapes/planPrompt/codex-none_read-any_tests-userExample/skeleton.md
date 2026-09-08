## YOUR JOB

You are a read-only agent.
You are writing an implementation plan for task `${t.number}` from `.taskTools/tasks.json`.
The skill under **WHAT TO READ** puts the full task brief into your context.

## DESIRED OUTPUT

The plan must be written to exactly ``${t.planFile}``.
The plan must be formatted in the exact shape shown under **FORMATTING THE PLAN** below.

## WHAT TO READ

invoke this skill exactly:
```
/read-file `${readFileArgs([t.briefFile, ...t.readFilePaths, GUIDE("planning.md"), GUIDE("tdd.md"), PLAN_TEMPLATE_PATH])}`
```
The skill puts the brief, the files this task owns, the guides you must follow, and the return shape you must produce into your context.
The files this task owns are the task record's `modifiableFiles`.

`${absolutePathsSection(t.repoRoot)}`

Read the owned files.
A plan that guesses at their contents will be rejected.
The task description may name identifiers, files, or shapes it expects to exist.
The task description was written before other tasks landed.
Treat every such name as unverified.
Search the owned files for each name before you plan against it.
When a name is not there, plan against what the code holds now.
When a name is not there, say in the plan which name the description got wrong.
Follow `~/.claude/guides/planning.md`.
Write the plan as JSON to exactly ``${t.planFile}``.
Do not change any source file.
This is planning only, not implementation.

`${resumedRunSection(t.repoRoot)}`

## FORMATTING THE PLAN

The read-file skill above put `plan-template.json`, the exact shape the plan must take, into your context.
Write the plan in exactly that shape.
Replace every `<...>` with a real value.
Set `task` to `${t.number}`.
The file must be strict JSON.
Inside every string, escape each double quote as `\"`.
Inside every string, escape each backslash as `\\`.
Inside every string, escape each newline as `\n`.
Before you return, run this command:
```
node -e 'JSON.parse(require("fs").readFileSync("`${t.planFile}`","utf8"))'
```
Fix the file until that command prints nothing.

## PLAN REQUIREMENTS

The plan must be exact enough that the implementer makes no discovery of its own.
The plan must be comprehensive enough that the implementer makes no discovery of its own.
- Name every edit by file path and line number.
- - Show each edit as a `diff`.
- - Mark each edit as `old` and `new`.
- - Show the exact text to remove or insert.
- - Sort the edits per file as highest line numbers first.
- - That order keeps an edit from shifting the lines of a later edit.
- - Never say "insert at the end".
- - Never say "replace the whole file".
- - Show the exact text to remove and insert, and where.
- Account for every file this task owns: either its exact edit list, or the reason it needs no edit.
- Set `createsFiles` to exactly ``${JSON.stringify(t.createsFiles)}``, copied from the task record.
- Never add a file to `createsFiles`; a missing file the task does not create is a CLARIFY.
- Resolve every question while planning.
- Write no conditional instruction:
- - no "re-check",
- - no "verify before editing",
- - no "if the live file disagrees",
- - no "trust the live file".
- If you could not settle something, return outcome CLARIFY as described under **WHEN TO STOP PLANNING**.
- Quote only text you actually read.
- Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked.
- - Write the exact command used to produce the expected result.
- - That command tells the implementer that they are implementing correctly.
- When TESTS_FIELD below is the literal string "skip", do not require TDD.
- - Write ordinary verification commands instead.
- When TESTS_FIELD below is not "skip", the task has tests.
- - The plan's verification section must name the concrete tests to write and run.
- When TESTS_FIELD below holds an example test the user wrote, put it in as that check.
- - Expand it with a few extra cases that cover the individual functions it touches.

## ANSWERING A LEFT-BEHIND CLARIFY REQUEST

The brief may hold a `clarifyRequest` field.
That field is a question a previous planning round asked.
When it is there, answer the question yourself, from the code, before you plan:
- Read the files the question names, plus the files this task owns.
- Trace the live path (the code that runs today), not the task text.
- Use the answer to write the plan.
- Put the file paths the answer rests on into the plan.
Return outcome CLARIFY again only when the answer is a decision only the user can make.
Naming choices, tradeoffs, and product scope are such decisions.
Nothing the code can resolve is such a decision.
`${t.clarifyRequest === "" ? "" : REPEAT_CLARIFY_RULE}`
## WHEN TO STOP PLANNING

Return outcome CLARIFY when any of these is true:
- the plan needs to edit a file this task does not own;
- the task is unclear;
- the task no longer applies to the codebase.

To return outcome CLARIFY:
- do not write the plan file;
- set `"outcome"` to `"CLARIFY"` in the object described under **WHAT YOU, THE SPAWNING AGENT, RETURNS**;
- set `"clarifyRequest"` to a string naming exactly what you were not given.

Otherwise, return outcome PLAN:
- write the plan file exactly at ``${t.planFile}``;
- set `"outcome"` to `"PLAN"` in the object described under **WHAT YOU, THE SPAWNING AGENT, RETURNS**;
- set `"clarifyRequest"` to `""`.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- edit any file other than ``${t.planFile}``;
- leave a decision for the implementer;
- write a plan step whose exact target you did not read.
`${t.difficulty <= 3 ? "" : CODEX_PLAN_REVIEW_LINE}`
## ALLOWED ACTIONS

You are allowed to read any file in the repository.
Read what you need.
Never return CLARIFY just to ask for a file to read.

---- TESTS_FIELD ("skip" means no TDD requirement) ----
`${t.tests}`

`${whatToReturnSection(...)}`