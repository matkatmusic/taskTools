# Decision: SQLite for task storage

## Summary

Someone proposed SQLite twice in this project. The first time, it was for
storing block run logs. The second time, it was for storing tasks
(task 188). Both proposals were turned down. The task list stays in
`tasks.json`, a plain JSON file. This file writes down why, with the exact
quotes from the chat sessions where each decision happened.

## Timeline

### 2026-08-28 — SQLite proposed for block run logs

- Session file:
  `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/c98baf4b-d8d8-4245-b454-ff4637fc34d7.jsonl`
- Branch: `new-run-step-tool-integration`

The user proposed several new features in one message. One of them was
about storing block run data in SQLite instead of a run-log file. The user
wrote:

> "store block input/command/command output/output/run-step inputs/etc. in
> sqlitedb per run (basically replace run-log per run with sqlite entry per
> run). How: for every block that outputs a payload to pass to another
> block, write that payload to the db as a JSON blob before returning the
> payload. purge the record for a run after that record is more than 15
> days old. the 'resume' engine uses the sqlite db to retrieve payloads and
> block inputs, not run-log.md"

The assistant reviewed the idea and wrote an assessment. It said "against"
and gave this full reasoning:

> "**3. SQLite store for block inputs and outputs — against.**
> You already have the store. `buildSuccess` (`runStepHook.ts:246`) writes
> every block payload as JSON to `<stamp>/packets/<box>-<pid>.json`. The
> only things not in there are the command line and the command output. So
> the lazy version is:
> - add `command` and `commandOutput` fields to that packet file,
> - stop deleting the packets folder on success (`runStepHook.ts:254`),
> - point `findStartAtBlockEntry` at the packet files instead of the log.
>
> That is the same data, one JSON file per block, no schema, no new
> dependency. `prepareResume` never reads the log; it reads
> `plans/checkpoint.json`. So "the resume engine uses the db" is already
> almost true.
> Against sqlite: it needs a schema, a query script (idea 4), and a purge
> job. Note `.taskTools/tasks.json` already holds an open task that
> proposes `node:sqlite` (row 739). `node:sqlite` works on this machine
> (node 26), but bun's sqlite is a different module, and your rule says
> tests run on node only. Pick sqlite only when you need a question across
> many runs, like "average time per block over 30 runs".
> 15-day purge: no purge exists today and nothing has broken. If you want
> one, it is `fd --changed-before 15d . .taskTools/runs -x rm -r`. One
> line, no code.
>
> **4. Script to pull block details from the store — against.**
> With JSON files it is `cat` and `jq`. The need for a viewer script is an
> argument against sqlite, not for a script."

This full assessment was saved to
`/Users/matkatmusicllc/.claude/plans/virtual-dreaming-lighthouse.md`.

The user then picked a plan that used JSON files, not SQLite. The user
wrote:

> "do #2 and #3, they're related: log noise moves to packets.
> run-log should contain block name and how long the block took, per block
> being executed."

In the assistant's numbered list, #2 was "strip input/command/output from
the run log" and #3 was the JSON packet store (the option offered instead
of SQLite). The user's choice kept the run log short and put the block data
in JSON packet files. No SQLite database was built.

### 2026-08-29 — Was task 188 vetoed too?

- Session file:
  `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/4383f1cc-68e3-4623-8b72-15fe89ced1ca.jsonl`
- Branch: `new-run-step-tool-integration`

The user asked about closing old tasks and said:

> "I'm pretty sure 188 was vetoed."

The assistant searched the project for a veto of task 188 and did not find
one. It found only the block-log veto from 2026-08-28, which is a
different proposal. The assistant wrote this note in
`plans/tasks-to-close.md`:

> "**188** — Found a veto, but for a different proposal. The Aug 28 5:36pm
> session ("tackle-tasks: Proposed Feature Set for v2 Architecture")
> rejected **Feature 3: per-run block-payload logging in SQLite** (storing
> block input/output/command JSON with a 15-day purge — an unrelated
> proposal). That assessment
> (`~/.claude/plans/virtual-dreaming-lighthouse.md`) explicitly calls task
> 188 "a separate concern... covers task metadata, not run data" and does
> not rule on it. No record found of 188 itself (migrating `tasks.json` to
> SQLite with tags) being vetoed. Its named plumbing target
> (`createTask.workflow.js`'s file-hunter/blocker-hunter agents) is gone
> regardless — `create-task` is now a single-script stub — so it needs a
> rewrite either way. Confirm whether 188 was rejected too, or close it as
> still-open-but-needs-a-rewrite."

So on 2026-08-29, task 188 (SQLite for tasks) was still an open question,
not yet decided.

### 2026-08-31 — Task 189 marks task 188 as the SQLite owner

- Session file:
  `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/ba526ff8-0533-4248-bdfe-31f2deaca8e8.jsonl`
- Branch: `new-run-step-tool-integration`

While closing task 189, its goal list said:

> "NOT in scope: the SQLite task store and its tagging system — task 188
> owns that"

This confirms that, as of 2026-08-31, task 188 was still the open task that
owned the idea of moving tasks into SQLite.

### 2026-09-01 — What problem does task 188 solve?

- Session file:
  `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/e0e629a3-fc37-42a0-a58d-527f675e3d98.jsonl`

The assistant asked the user, as part of an interview about open tasks:

> "...(SQLite) instead of one big JSON file. What problem does task 188
> solve?"

The user answered:

> "extracting information from tasks.json requires complex 'jq'
> expressions, vs. simpler SQL queries and table joins."

That answer was written onto task 188's `problemSolvedByTask` field.

### 2026-09-02 — Final decision (this session)

The user reviewed the timeline above. The user agreed that the reasons
against SQLite for block logs also apply to task 188 (SQLite for tasks).
The user chose: "Replace with a tiny task." This means:

- Close task 188.
- Create one small new task instead: a query script that reads
  `tasks.json` and answers two questions — "what blocks task N" and "which
  open tasks touch file X".

## The reasons against SQLite (from the 2026-08-28 assessment)

These are the two numbered reasons, quoted above in full, restated here as
a short list:

1. The store already exists. For block logs, `buildSuccess` already
   writes JSON packet files. Adding SQLite would mean a second store for
   the same data.
2. SQLite needs extra work that JSON does not: a schema, a query script,
   and a purge job. It also risks a mismatch, because `node:sqlite` and
   `bun:sqlite` are different modules, and the project's test rule says
   tests run on node only.
3. SQLite is worth it only for a question that spans many records at
   once, like "average time per block over 30 runs."

## Which reasons apply to task storage, and which do not

Task 188 was about storing tasks in SQLite, not block logs. Three of the
reasons above still apply:

- **The store already exists.** Tasks already live in `tasks.json`. SQLite
  would be a second store for the same data.
- **SQLite needs extra work.** For tasks, this would mean a schema, a
  query script, and also a script to regenerate `tasks.json` from the
  database (since `tasks.json` cannot be dropped — see below).
- **node vs. bun mismatch.** This risk is the same for tasks as it was for
  block logs.

One reason does **not** apply to task storage:

- **"Only for a question across many rows."** This was the reason SQLite
  was allowed for big queries across many run records. But task 188's own
  two questions — "what blocks task N" and "which open tasks touch file
  X" — are each a single scan through one JSON array. A `jq` one-liner
  answers each one. There is no need for a database just for these two
  questions.

There is also a new fact that was not part of the block-log decision.
Task 188's own audit note (written 2026-08-31) found that about thirty
files across the codebase read `tasks.json` directly. Those files were
never updated to read from a database instead. This means `tasks.json`
must stay the real source of truth even if task 188 were built — a SQLite
copy would just be a second file to keep in sync, with real risk of the
two files disagreeing.

## Final decision and what replaces task 188

**Decision:** Do not build SQLite storage for tasks. Close task 188.

**Replacement:** Create one small new task. It adds a query script that
reads `tasks.json` directly (no database) and answers:

- What blocks task N?
- Which open tasks touch file X?

This keeps `tasks.json` as the one and only place tasks are stored, while
still solving the real problem the user named on 2026-09-01: writing
complex `jq` expressions by hand.

## Where to look again

- `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/c98baf4b-d8d8-4245-b454-ff4637fc34d7.jsonl`
  (2026-08-28 — block-log SQLite proposal and veto)
- `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/4383f1cc-68e3-4623-8b72-15fe89ced1ca.jsonl`
  (2026-08-29 — "was 188 vetoed?" question)
- `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/ba526ff8-0533-4248-bdfe-31f2deaca8e8.jsonl`
  (2026-08-31 — task 189 names task 188 as SQLite owner)
- `/Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools-86/e0e629a3-fc37-42a0-a58d-527f675e3d98.jsonl`
  (2026-09-01 — problem statement for task 188)
- `/Users/matkatmusicllc/.claude/plans/virtual-dreaming-lighthouse.md` —
  this file exists. It holds the full 2026-08-28 assessment.
- `plans/tasks-to-close.md` (relative to
  `/Users/matkatmusicllc/Programming/taskTools-86`) — this file exists. It
  holds the 2026-08-29 note about task 188.

## Task 188's record (for context)

Read from `.taskTools/completedTasks.json` (task 188 was already closed by
another agent before this file was written):

- **Title:** "Store tasks in SQLite so blockers and files are looked up by
  query instead of by research agents."
- **Difficulty:** 9
- **Blocked by:** task 160, with reason "Deferred: possibly no longer
  relevant after blocking task is completed."
- **Problem solved by task:** "extracting information from tasks.json
  requires complex 'jq' expressions, vs. simpler SQL queries and table
  joins."
