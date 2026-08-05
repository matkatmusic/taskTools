# Task 54 Plan: create-task collects an example test, stored as `tests`, consumed by plan/implement workflows

## Ladder check (ponytail)
This is a documented-prompt-text change across four owned files: add one field to a JSON-ish
template, one AskUserQuestion instruction to a skill doc, and one small pass-through helper each
in two workflow scripts. No new abstraction, no new dependency, no new file. Shortest diff that
touches every place the brief names.

## Scope
All four owned files need an edit. None can be skipped.

---

## Edit 1 — `skills/create-task/template/taskTemplate.json`

Current lines 5-6:
```
  "files": ["<repo-relative path this task will touch>"],
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
```

Becomes:
```
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
```

Mechanics: insert one new line, `  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",`,
immediately after the `"files"` line (currently line 5) and before the `"difficulty"` line
(currently line 6). `difficulty` and `blockedBy` shift down by one line each; no other change to
this file.

---

## Edit 2 — `skills/create-task/SKILL.md`

Current lines 11-13:
```
Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:
```

Becomes:
```
Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:
```

Mechanics: insert one new paragraph between the existing "Decide whether..." paragraph (ends at
current line 11) and the existing "Append ONE object..." paragraph (current line 13), separated
by blank lines on both sides exactly as shown above. No other line in this file changes — the
template block (lines 15-17), the `files`/`handoffFilePaths`/`specs/SPEC.md`/completion-fields
paragraphs (lines 19-25), and the closing confirmation line (line 27) are untouched because the
brief's own documentation requirement is satisfied by this one paragraph placed directly
alongside the AskUserQuestion step that collects the answer.

---

## Edit 3 — `skills/tackle-tasks/plan.workflow.js`

### Edit 3a: add a `testsInstruction` helper

Current lines 19-22:
```
  required: ['task', 'status', 'planFile', 'question'],
}

const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
```

Becomes:
```
  required: ['task', 'status', 'planFile', 'question'],
}

const testsInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
```

Mechanics: insert the new `const testsInstruction = ...` declaration (3 lines) plus a trailing
blank line between the `PLAN_SCHEMA` closing brace (current line 20) and the `plannerBrief`
declaration (current line 22). This is a plain top-level `const`, not nested inside any template
literal, so its own backticks need no escaping.

### Edit 3b: reference it from `plannerBrief`'s bullet list

Current lines 37-39:
```
- State the verification that proves the change worked, as commands with expected results.

If the plan would need to edit a file outside the owned list above, set status
```

Becomes:
```
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the owned list above, set status
```

Mechanics: insert one new bullet line, `- \${testsInstruction(t)}`, immediately after the
"State the verification..." bullet (current line 37), still inside `plannerBrief`'s template
literal so the `${...}` interpolates. The blank line before "If the plan would need..." (current
line 38) is preserved after the new bullet.

Why this satisfies the brief: `t` here is the same per-task object whose `t.files`, `t.number`,
`t.briefFile`, and `t.planFile` are already interpolated directly into this same template literal
(current lines 23-26, 45), so `t.tests` is available the same way once a task carries that field.
When `t.tests` is present and not the literal string `"skip"`, the planner is told to fold the
user's example test into the plan's verification section (satisfying "put the example test into
the plan so codex verifies against it"); when `t.tests` is absent or equals `"skip"`, the
instruction explicitly says not to require TDD — which also covers tasks created before this
field existed, since `t.tests` is then `undefined` and `undefined && ...` short-circuits to the
skip branch.

---

## Edit 4 — `skills/tackle-tasks/implement.workflow.js`

### Edit 4a: add a `tddInstruction` helper

Current lines 22-25:
```
  required: ['task', 'status', 'summary', 'remaining'],
}

const workerBrief = (t, group, planFile, note) => `You are implementing EXACTLY ONE pre-planned task from
```

Becomes:
```
  required: ['task', 'status', 'summary', 'remaining'],
}

const tddInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
  : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.'

const workerBrief = (t, group, planFile, note) => `You are implementing EXACTLY ONE pre-planned task from
```

Mechanics: insert the new `const tddInstruction = ...` declaration (3 lines) plus a trailing
blank line between the `WORKER_SCHEMA` closing brace (current line 23) and the `workerBrief`
declaration (current line 25). Plain top-level `const`, no nesting inside `workerBrief`'s own
template literal.

### Edit 4b: reference it from `workerBrief`'s body, before `jot:implement` is invoked

Current lines 36-38:
```
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
use jot:implement ${planFile}
```

Becomes:
```
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

use jot:implement ${planFile}
```

Mechanics: insert `\${tddInstruction(t)}` as its own line, immediately after the
`\${note ? ... : ''}` line (current line 37) and before `use jot:implement ${planFile}` (current
line 38), followed by a blank line, still inside `workerBrief`'s template literal. This places the
TDD instruction before the worker invokes `jot:implement` and before the "if the plan is
impossible..." / "implement every step of the plan..." lines that follow it, so the worker is told
whether to write the example test first — or to skip TDD entirely — before any implementation
step can begin, rather than after `jot:implement` has already started the work.

Why this satisfies the brief: same `t` object as `plannerBrief` above (this file already
interpolates `t.number` and `t.files` directly from it, current lines 26, 34). When `t.tests` is
present and not `"skip"`, the worker is told to write that test first and then expand it to also
cover individual functions/subparts — exactly the brief's wording. When `t.tests` is missing or
`"skip"`, the worker is told to skip TDD entirely and just write the code, which also covers
pre-existing tasks that predate this field (`t.tests` is `undefined`, so the skip branch fires).

---

## Verification

Run from the repo root after all four edits:

1. `rg -n '"tests":' skills/create-task/template/taskTemplate.json`
   Expected: one match, `6:  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",`

2. `rg -n 'Invoke AskUserQuestion to ask for an example test' skills/create-task/SKILL.md`
   Expected: exactly one match, on the new paragraph inserted between the old lines 11 and 13.

3. `rg -n 'const testsInstruction' skills/tackle-tasks/plan.workflow.js`
   Expected: exactly one match (the new helper declaration).

4. `rg -cF '${testsInstruction(t)}' skills/tackle-tasks/plan.workflow.js`
   Expected: `1` (one usage, the new bullet inside `plannerBrief`). Use single quotes around the
   pattern exactly as shown, with no backslash before `$` — inside single quotes the shell does no
   expansion, so the literal text matches the file byte-for-byte.

5. `rg -n 'const tddInstruction' skills/tackle-tasks/implement.workflow.js`
   Expected: exactly one match (the new helper declaration).

6. `rg -cF '${tddInstruction(t)}' skills/tackle-tasks/implement.workflow.js`
   Expected: `1` (one usage, inside `workerBrief` before `use jot:implement ${planFile}`). Same
   single-quote, no-backslash rule as step 4.

Note: do not use `node --check` on `plan.workflow.js` or `implement.workflow.js` as a verification
step — both files already fail it on the unedited codebase (each has a top-level `return {` —
`plan.workflow.js` line 74, `implement.workflow.js` line 122 — outside any function), because
these files are executed as the body of a wrapper function by the workflow runner, not as
standalone Node modules, and `node --check` parses the raw source without that wrapper. This is
pre-existing and unrelated to this task; a `node --check` failure here proves nothing about
whether this task's edits are correct.
