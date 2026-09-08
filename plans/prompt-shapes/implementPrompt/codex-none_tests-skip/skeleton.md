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
/read-file `${readFileArgs([t.briefFile, t.planFile, ...t.readFilePaths, ...t.testFilePaths, GUIDE("coding-standards.md"), GUIDE("tdd.md")])}`
```
The skill puts the brief, the plan, the files this task owns, and the guides you must follow into your context.

## OBEY THE REVIEW NOTES

Do not ignore, and instead follow, any non-empty `codexNotes` field in each section of the plan.

`${absolutePathsSection(t.repoRoot)}`

## WHAT YOU MAY EDIT

`${ownedPathMap(t)}`
- the implementation log at ``${t.notesFile}``

`${resumedRunSection(t.repoRoot)}`

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

`${whatToReturnSection(...)}`