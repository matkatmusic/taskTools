# Task 141 plan: tackle-tasks: one approval gate after every task finishes plan+implement

## Scope

Owned files: `scripts/tackleTasksBrief.ts`, `tests/tackleTasksBrief.test.ts`. Both need an edit.

Goal: `tackleTasksBrief()`'s returned brief text must instruct the orchestrator to gate each
task's own plan+implement completion immediately, one `AskUserQuestion` per task that carries an
explicit "Approve for merge" / "Do not approve" decision for that task, alongside that task's
status and the fence violations (task 138) and codex objections (task 135) presented as separate
proposed tasks, without waiting for any other task. Approval enqueues that task for merge
immediately; a task that is not approved never enters the merge queue and never merges. This is
prose-only: no other file in the pipeline is touched, and `AskUserQuestion` is never invoked from
inside this script — the brief merely instructs the human-facing orchestrator conversation to call
it.

## Edit 1 — `scripts/tackleTasksBrief.ts`

Current text, lines 88–91:

```
Each task workflow's completion sends a task-notification back to you. That
notification — not polling — is how you learn a task is ready.

## Closing your tasks
```

Replace with (insert a new `## Gate each task` section between the notification paragraph and
`## Closing your tasks`; every backtick below is the escaped `` \` `` form already used elsewhere
in this template literal):

```
Each task workflow's completion sends a task-notification back to you. That
notification — not polling — is how you learn a task is ready.

## Gate each task

The moment a task's own task-notification says it finished plan+implement,
gate that task immediately, in this main conversation — never inside a
workflow or a subagent, since \`AskUserQuestion\` is stripped from every
subagent and is not a workflow-script hook. Do not wait for any other
task's workflow to finish; one task's gate never waits on another task's
notification.

Call \`AskUserQuestion\` once for that task. Include an explicit decision
for the task itself — "Approve for merge" or "Do not approve" — alongside
its status, the fence violations the implement stage recorded for it
(task 138), and the codex objections that survived that task's
plan-review rounds (task 135). Present each fence violation and each
surviving objection as its own proposed task, separate from the approval
decision, that the user can accept or reject. For every proposed task the
user accepts, invoke the \`create-task\` skill once, never edit
\`tasks.json\` directly. Drop every proposed task the user rejects without
recording it anywhere.

Only "Approve for merge" clears a task to merge; "Do not approve" means
the task never enters the merge queue and never merges. An approved task
enters the merge queue immediately on approval — even while other tasks
are still planning or implementing. Never hold an approved task back to
gate or merge it alongside the rest, and never let this gate become a
barrier that waits for the whole batch.

## Closing your tasks
```

Use the Edit tool with `old_string` exactly equal to the four-line "Current text" block above
(the literal file content, no escaping needed there since it has no backticks) and `new_string`
exactly equal to the full replacement block above (with the `\`` escapes exactly as written,
matching the file's existing escaping convention — e.g. the file already contains
`invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.` later in
the same template literal).

No other line in this file changes. The `seriesSection`, `readStdin`, `fail`, and the
`if (process.argv[1]...)` runner block are all untouched — none of them reference the gate.

## Edit 2 — `tests/tackleTasksBrief.test.ts`

Current text, the file's last 3 lines (currently lines 46–48, immediately before end of file):

```
  assert.match(brief, new RegExp(`Keep up to ${TASKS_PER_COMMAND} task\\.workflow\\.js runs in flight`));
  assert.match(brief, /sliding window, not\s+batches of/);
});
```

Replace with (append a new test after the existing closing `});`, no blank line before the closing
`});` is altered, one blank line then the new `test(...)` block):

```
  assert.match(brief, new RegExp(`Keep up to ${TASKS_PER_COMMAND} task\\.workflow\\.js runs in flight`));
  assert.match(brief, /sliding window, not\s+batches of/);
});

test("gate: each finished task is presented as one AskUserQuestion gate, never batched", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /## Gate each task/);
  assert.match(brief, /Call `AskUserQuestion` once for that task/);
  assert.match(brief, /"Approve for merge"/);
  assert.match(brief, /"Do not approve"/);
  assert.match(brief, /fence\s+violations the implement stage recorded for it\s+\(task 138\)/);
  assert.match(brief, /codex\s+objections that survived that task's\s+plan-review rounds \(task 135\)/);
  assert.match(brief, /Present each fence violation and each\s+surviving objection as its own proposed task/);
  assert.match(brief, /invoke the `create-task`\s+skill once, never edit\s+`tasks\.json` directly\./);
  assert.match(brief, /Do not wait for any other\s+task's workflow to finish/);
  assert.match(brief, /the task never enters the merge queue and never merges\./);
  assert.match(brief, /enters the merge queue\s+immediately on approval/);
  assert.match(brief, /never let this gate become a\s+barrier that waits for the whole batch\./);
});
```

Use the Edit tool with `old_string` exactly equal to the three-line "Current text" block above and
`new_string` exactly equal to the full replacement block above. No other test in the file changes;
no new imports are needed (`test`, `assert`, `tackleTasksBrief`, `TASKS_PER_COMMAND` are already
imported at the top of the file and are all this new test uses).

### Why these particular regexes

The added prose in Edit 1 hard-wraps at roughly the same column width as the rest of the template
literal. Every multi-word phrase the new test checks against wrapped prose (the ones that cross,
or might cross depending on future rewrapping, a line break) uses `\s+` between its words instead
of a literal space, mirroring the existing test file's own pattern for a wrapped phrase
(`/sliding window, not\s+batches of/`, already in the file). `\s+` matches both a single space and
a newline, so these regexes hold regardless of exactly where a given line happens to wrap. The
regexes that check a short phrase guaranteed to sit on one line (`## Gate each task`, `Call
\`AskUserQuestion\` once for that task`, `"Approve for merge"`, `"Do not approve"`, `the task never
enters the merge queue and never merges.`) use plain literal spaces. This was verified by hand
against the exact wrapped text in Edit 1.

## Why no other owned-file edits

Both owned files get exactly the edits above; neither needs any other change. No file outside the
owned list is touched — the plan does not alter `task.workflow.js`, `tasks.json`, or any skill
file. Merge-queue mechanics (actually launching a merge step) are explicitly out of scope per the
brief: "The merge orchestration itself is a later task in the 86 chain." This task only adds the
per-task approval gate instruction; it does not invent or wire up a merge trigger.

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`):

1. `node --test tests/tackleTasksBrief.test.ts`
   Expected: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0` — the 5 pre-existing tests plus the new gate test
   all pass. Confirm the new test's name (`gate: each finished task is presented as one
   AskUserQuestion gate, never batched`) shows `✔`.

2. `npm test`
   Expected: exit code 0, no failing tests across `tests/**/*.test.ts` — confirms the edit did not
   break any test outside this file (none reference `tackleTasksBrief`, but this is the project's
   standard full-suite gate).

3. `npx tsc --noEmit` (if configured in this repo; otherwise skip — this project has no
   `tsconfig.json`-driven build step beyond `node --test` on `.ts` files directly, so this step is
   informational only and its absence is not a failure).

4. Manual read-back: `node -e "process.stdout.write(require('./scripts/tackleTasksBrief.ts'))"` is
   not valid for an ESM `.ts` module, so instead run
   `node --input-type=module -e "import { tackleTasksBrief } from './scripts/tackleTasksBrief.ts'; console.log(tackleTasksBrief('[1]', 'task 1: unblocked'))"`
   from the repo root and visually confirm the `## Gate each task` section appears once, between
   the task-notification sentence and `## Closing your tasks`, with no stray unescaped backtick
   breaking the surrounding Markdown.
